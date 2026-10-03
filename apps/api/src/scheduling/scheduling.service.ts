import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, SlotType, SessionStage } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
// Anchoring was replaced by panel composition — see the PANEL constant below.
// anchors.ts is retained for reference and is no longer called.
import { planPasses, describePlan } from './passes';
import { isMorning, localDate, eventTimezone } from '../common/event-time';

@Injectable()
export class SchedulingService {
  private schedulerUrl: string;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private config: ConfigService,
  ) {
    // getOrThrow, not get-with-default. A missing SCHEDULER_URL used to fall
    // back to localhost:8000 — which is not even the port this scheduler runs
    // on locally — so the API started cleanly and then failed at the one moment
    // it mattered, reporting 'Cannot reach scheduler' with nothing pointing at
    // the cause. An environment missing this variable is misconfigured, and it
    // should say so at boot rather than during a solve.
    this.schedulerUrl = this.config.getOrThrow<string>('SCHEDULER_URL');
  }

  async generateSchedule(
    eventId: string,
    minJudges: number,
    maxJudges: number,
    userId: string,
    guided = false,
  ) {
    // Gather all data for the solver
    const [teams, judges, slots, rooms, conflicts, existingSessions] = await Promise.all([
      this.prisma.team.findMany({
        where: { eventId, deletedAt: null, status: { in: ['ELIGIBLE', 'DRAFT', 'SUBMITTED'] } },
      }),
      this.prisma.judge.findMany({
        where: { eventId, deletedAt: null, status: 'ACTIVE' },
        include: { availability: true, expertise: true, conflicts: { where: { status: 'ACTIVE' } } },
      }),
      this.prisma.timeSlot.findMany({
        where: { eventId, slotType: SlotType.JUDGING },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
      this.prisma.room.findMany({
        where: { eventId, deletedAt: null, status: 'ACTIVE' },
      }),
      this.prisma.conflictDeclaration.findMany({
        where: { eventId, status: 'ACTIVE' },
      }),
      // Sessions that already exist — manually placed, or left from an earlier
      // partial generation. These are kept as-is and worked around.
      //
      // CANCELLED and NO_SHOW are excluded. A cancelled session used to put its
      // team into scheduledTeamIds and its room-slot into lockedSessions, so
      // cancelling a session silently removed that team from the schedule and
      // held its room-slot against everyone else. Nothing errored: the team was
      // filtered out before the solve, so it never appeared in
      // unscheduledTeams either.
      //
      // RESCHEDULED stays in the list deliberately. A rescheduled session is a
      // real placement that has moved, not one that has gone away.
      this.prisma.judgingSession.findMany({
        where: { eventId, stage: { notIn: [SessionStage.CANCELLED, SessionStage.NO_SHOW] } },
        include: { judges: true },
      }),
    ]);

    // Teams that already have a session are not re-solved. Everything else is
    // handed to the solver.
    const scheduledTeamIds = new Set(existingSessions.map(s => s.teamId));
    const teamsToSchedule = teams.filter(t => !scheduledTeamIds.has(t.id));

    // The solver still needs to know what those sessions consume: their
    // room-slot is taken, their judges are busy in that slot, and those judges
    // have already used part of their session budget.
    const lockedSessions = existingSessions.map(s => ({
      team_id: s.teamId,
      room_id: s.roomId,
      slot_id: s.timeSlotId,
      judge_ids: s.judges.map(sj => sj.judgeId),
    }));

    if (teamsToSchedule.length === 0) {
      return {
        success: true,
        sessions: [],
        unscheduledTeams: [],
        warnings: [
          existingSessions.length > 0
            ? `All ${existingSessions.length} team(s) are already scheduled. Reset the schedule to regenerate.`
            : 'No teams to schedule.',
        ],
        qualityScore: 0,
        solveTimeSeconds: 0,
      };
    }

    // A judge with no availability recorded cannot be scheduled.
    //
    // The solver treats an empty slot list as "no restriction", which was right
    // when availability was optional. Now that the matrix is the source of
    // truth, that default would book someone for three days on the strength of
    // nobody having asked them.
    const unavailable = judges.filter(j => j.availability.length === 0);
    const schedulable = judges.filter(j => j.availability.length > 0);

    // A room booked for something else cannot host a session, so those
    // room-slot pairs are excluded before the solve rather than discovered on
    // the day. Lunch divides the halves: a morning exclusion runs to noon.
    const exclusions = await this.prisma.roomUnavailability.findMany({
      where: { eventId },
    });

    const eventRecord = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { timezone: true },
    });
    const tz = eventTimezone(eventRecord);

    const blockedRoomSlots: Array<{ room_id: string; slot_id: string }> = [];
    for (const ex of exclusions) {
      const exDate = localDate(ex.date, tz);
      for (const slot of slots) {
        if (localDate(slot.date, tz) !== exDate) continue;
        if ((ex.session === 'AM') === isMorning(slot.startTime, tz)) {
          blockedRoomSlots.push({ room_id: ex.roomId, slot_id: slot.id });
        }
      }
    }

    // Map judge availability to slot IDs
    const judgeInputs = schedulable.map(j => {
      const availSlotIds = slots
        .filter(s => {
          return j.availability.some(a => {
            const slotDate = new Date(s.date).toISOString().split('T')[0];
            const availDate = new Date(a.date).toISOString().split('T')[0];
            return slotDate === availDate && s.startTime >= a.startTime && s.endTime <= a.endTime;
          });
        })
        .map(s => s.id);

      const conflictTeamIds = j.conflicts.map(c => c.teamId);

      return {
        id: j.id,
        name: j.name,
        judge_type: j.judgeType,
        max_sessions: j.maxSessions,
        available_slot_ids: availSlotIds,
        conflict_team_ids: conflictTeamIds,
        expertise_track_ids: j.expertise.map(e => e.trackId),
        tier: (j as any).judgeTier ?? 'L3',
        is_standby: (j as any).isStandby ?? false,
      };
    });

    // Anchors are decided here rather than by the solver. With two MDs and two
    // rooms there is nothing to optimise, and deciding it up front means a
    // coordinator can read "MD Priya, room 2, Tuesday" off the plan instead of
    // inferring it from the result.
    const slotsByDate = new Map<string, Array<{ id: string }>>();
    for (const s of slots) {
      const key = new Date(s.date).toISOString().split('T')[0];
      const list = slotsByDate.get(key) ?? [];
      list.push({ id: s.id });
      slotsByDate.set(key, list);
    }

    /**
     * The panel every session must have.
     *
     * Replaces room anchoring: rather than pinning an MD to a room for a day,
     * each panel draws one MD and one ED-or-SVP from the pool of ten, alongside
     * the mandatory PS. Three MDs sharing the sessions rather than two carrying
     * a room each.
     */
    const PANEL = [
      { tiers: ['PS'], count: 1 },
      { tiers: ['L2'], count: 1 },
      { tiers: ['L3', 'L4'], count: 1 },
    ];

    // Anchoring is retired. Composition replaces it: rather than pinning a judge
    // to a room for a day, each panel is drawn from the pool per session. The
    // empty plan is kept so the payload shape does not change.
    const anchorPlan: {
      assignments: any[]; reservedJudgeIds: string[];
      warnings: string[]; coverSlotIds: Record<string, string[]>;
    } = { assignments: [], reservedJudgeIds: [], warnings: [], coverSlotIds: {} };

    // Guided mode runs a sequence of smaller solves rather than one large one,
    // so the rules are honoured in priority order and a failure names the rule
    // that caused it.
    const passPlan = guided
      ? planPasses(
          teamsToSchedule.map(t => ({
            id: t.id,
            name: t.name,
            country: (t as any).country ?? null,
            platform: (t as any).platform ?? null,
            trackId: t.trackId,
          })),
          rooms.map(r => ({
            id: r.id,
            name: r.name,
            hasVideoConferencing: (r as any).hasVideoConferencing ?? false,
          })),
          Math.max(Math.floor(slots.length / Math.max(rooms.length, 1)), 1),
        )
      : { passes: [], warnings: [] };

    // Concurrency, not total capacity, is what binds here: every room running at
    // once needs one MD each, so the pool must cover the rooms in every slot.
    const panelWarnings: string[] = [];
    if (guided) {
      const count = (tier: string) =>
        schedulable.filter(j => ((j as any).judgeTier ?? '') === tier).length;

      const mds = count('L2');
      const ps = count('PS');
      const others = count('L3') + count('L4');
      const rooms_ = rooms.length;

      if (mds < rooms_) {
        panelWarnings.push(
          `${mds} MD(s) for ${rooms_} rooms — every room running at once needs one each.`,
        );
      } else if (mds === rooms_) {
        panelWarnings.push(
          `${mds} MD(s) for ${rooms_} rooms leaves no spare. One unavailable half-day and the schedule will not fill.`,
        );
      }

      if (ps < rooms_) {
        panelWarnings.push(`${ps} PS judge(s) for ${rooms_} rooms — one is needed per session.`);
      }
      if (others < rooms_) {
        panelWarnings.push(`${others} ED/SVP judge(s) for ${rooms_} rooms.`);
      }
    }

    const payload = {
      event_id: eventId,
      teams: teamsToSchedule.map(t => ({ id: t.id, name: t.name, track_id: t.trackId })),
      judges: judgeInputs,
      slots: slots.map(s => ({
        id: s.id,
        date: new Date(s.date).toISOString().split('T')[0],
        start_time: s.startTime.toISOString(),
        end_time: s.endTime.toISOString(),
      })),
      rooms: rooms.map(r => ({ id: r.id, name: r.name })),
      // Room-slot pairs the solver may not use. Rides on the same mechanism as
      // locked sessions, so no new constraint is needed — a blocked room is
      // simply one that is already occupied.
      blocked_room_slots: blockedRoomSlots,
      min_judges_per_team: minJudges,
      max_judges_per_team: maxJudges,
      locked_sessions: lockedSessions,
      judge_composition: guided ? PANEL : [],
      anchors: anchorPlan.assignments.map(a => ({
        room_id: a.roomId,
        date: a.date,
        anchor_judge_id: a.anchorJudgeId,
        ps_judge_id: a.psJudgeId,
        anchor_break_slot_ids: a.anchorBreakSlotIds,
      })),
      // L1 is held back for the final round and vendors are invited by a
      // coordinator rather than solved. Everyone else is in the pool.
      reserved_judge_ids: guided
        ? schedulable
            .filter(j => ['L1', 'V'].includes((j as any).judgeTier ?? ''))
            .map(j => j.id)
        : anchorPlan.reservedJudgeIds,
    };

    // Call the Python solver
    try {
      let result: any;

      if (guided && passPlan.passes.length > 0) {
        // Each pass solves its own teams with everything placed so far locked,
        // so a later pass works around earlier ones rather than competing with
        // them. This is the same mechanism that handles manual placements.
        const allSessions: any[] = [];
        const allWarnings: string[] = [...passPlan.warnings];
        const allUnscheduled: string[] = [];
        const locked = [...lockedSessions];
        let totalSolveTime = 0;
        let worstQuality = 100;

        for (const pass of passPlan.passes) {
          const passPayload = {
            ...payload,
            teams: pass.teams.map(t => ({ id: t.id, name: t.name, track_id: t.trackId })),
            locked_sessions: locked,
            restrict_to_room_ids: pass.restrictToRoomIds,
            cluster: pass.cluster,
          };

          const res = await fetch(`${this.schedulerUrl}/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(passPayload),
          });

          if (!res.ok) {
            const err = await res.text();
            throw new InternalServerErrorException(`Scheduler error on ${pass.label}: ${err}`);
          }

          const passResult = await res.json();
          totalSolveTime += passResult.solve_time_seconds || 0;

          if (!passResult.success) {
            // One rule failing should not lose the work of the passes that
            // succeeded, so the run continues and the coordinator is told which
            // pass could not be placed.
            allWarnings.push(`${pass.label} could not be placed.`);
            // Ids, not names. The success path below pushes ids from the
            // solver, so mixing the two made this array unusable for any caller
            // that looks a team up — half the entries would silently miss.
            allUnscheduled.push(...pass.teams.map(t => t.id));
            continue;
          }

          worstQuality = Math.min(worstQuality, passResult.quality_score ?? 100);
          allSessions.push(...(passResult.sessions || []));
          allUnscheduled.push(...(passResult.unscheduled_teams || []));

          // Lock what this pass placed so the next works around it.
          for (const s of passResult.sessions || []) {
            locked.push({
              team_id: s.team_id,
              room_id: s.room_id,
              slot_id: s.slot_id,
              judge_ids: s.judge_ids || [],
            });
          }
        }

        result = {
          // Every team placed, or it did not succeed. `allSessions.length > 0`
          // reported success when one team out of seventy-nine was placed and
          // ten passes had failed.
          success: allUnscheduled.length === 0 && allSessions.length > 0,
          sessions: allSessions,
          unscheduled_teams: allUnscheduled,
          warnings: [describePlan(passPlan), ...allWarnings],
          quality_score: worstQuality,
          solve_time_seconds: Math.round(totalSolveTime * 100) / 100,
        };
      } else {
        const response = await fetch(`${this.schedulerUrl}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new InternalServerErrorException(`Scheduler error: ${err}`);
        }

        result = await response.json();
      }

      // QA tee: captures the solve for tools/qa/check_schedule.py.
      // Off unless SCHEDULE_TEE_DIR is set. Wrapped so a write failure can
      // never fail a schedule generation.
      //
      // Captures the base payload and the assembled result, so in guided mode
      // the checker sees the whole schedule rather than one pass. Per-pass
      // restrict_to_room_ids and cluster are not in the base payload.
      if (process.env.SCHEDULE_TEE_DIR) {
        try {
          const fs = await import('node:fs/promises');
          const dir = process.env.SCHEDULE_TEE_DIR;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(
            `${dir}/${stamp}-request.json`,
            JSON.stringify(payload, null, 2),
          );
          await fs.writeFile(
            `${dir}/${stamp}-response.json`,
            JSON.stringify(result, null, 2),
          );
          console.log(
            `[schedule-tee] wrote ${dir}/${stamp}-{request,response}.json ` +
            `(guided=${guided}, sessions=${result.sessions?.length ?? 0})`,
          );
        } catch (teeError) {
          console.warn(`[schedule-tee] failed: ${teeError}`);
        }
      }

      await this.audit.log({
        userId, eventId,
        action: AuditAction.CREATE, entityType: 'Schedule',
        entityId: eventId,
        newValues: {
          sessions: result.sessions?.length || 0,
          locked: lockedSessions.length,
          unscheduled: result.unscheduled_teams?.length || 0,
          quality: result.quality_score,
          solveTime: result.solve_time_seconds,
        },
      });

      return {
        success: result.success,
        sessions: result.sessions?.map((s: any) => ({
          teamId: s.team_id,
          teamName: s.team_name,
          roomId: s.room_id,
          roomName: s.room_name,
          slotId: s.slot_id,
          slotDate: s.slot_date,
          slotStart: s.slot_start,
          slotEnd: s.slot_end,
          judgeIds: s.judge_ids,
          judgeNames: s.judge_names,
        })) || [],
        unscheduledTeams: result.unscheduled_teams || [],
        // Anchor warnings come first — a room with no MD is a bigger problem
        // than a room change, and a coordinator should see it before the
        // optimisation notes.
        warnings: [
          ...(unavailable.length > 0
            ? [`${unavailable.length} judge(s) have no availability recorded and were not scheduled: ` +
               unavailable.slice(0, 5).map(j => j.name).join(', ') +
               (unavailable.length > 5 ? `, and ${unavailable.length - 5} more` : '')]
            : []),
          ...(guided ? panelWarnings : anchorPlan.warnings),
          ...(result.warnings || []),
        ],
        qualityScore: result.quality_score || 0,
        solveTimeSeconds: result.solve_time_seconds || 0,
      };
    } catch (err: any) {
      if (err instanceof InternalServerErrorException) throw err;
      throw new InternalServerErrorException(`Cannot reach scheduler: ${err.message}`);
    }
  }
}
