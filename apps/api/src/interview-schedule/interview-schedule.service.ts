import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { eventTimezone, localDate } from '../common/event-time';
import { Issue } from '../setup-upload/cells';
import { readCandidatesWorkbook } from './candidates-workbook';

/**
 * The interview schedule of an uploaded event: slots built from judges'
 * availability, each with its panel, and the candidates placed in them.
 *
 * Candidates arrive in batches (the candidates file) and get moved around by
 * hand (drag and drop). Both go through the same planner, so the rules are
 * identical either way: a candidate goes into an interview slot that has a
 * panel and nobody else in it; a candidate whose interview has started stays
 * put; nothing moves on or off a closed day.
 *
 * Placing a candidate creates their judging session, with the slot's panel
 * and an empty scorecard per judge — exactly what the Command Centre and the
 * judge portal already work from.
 */

export type PanelMember = { judgeId: string; name: string };
export type PlacedCandidate = { sessionId: string; teamId: string; name: string; started: boolean };
export type SlotView = {
  id: string;
  date: string;
  block: string | null;
  sequence: number | null;
  kind: 'INTERVIEW' | 'BREAK' | 'CALIBRATION';
  start: string;
  end: string;
  startUtc: Date;
  endUtc: Date;
  panel: PanelMember[];
  candidate: PlacedCandidate | null;
};
export type DayView = {
  date: string;
  status: 'OPEN' | 'CLOSED';
  panelsLocked: boolean;
  blocks: { block: string; slots: SlotView[] }[];
};
export type ScheduleView = {
  event: { id: string; name: string; timezone: string; minPanel: number };
  days: DayView[];
  totals: { interviews: number; withPanel: number; placed: number };
};

export type PlannedAction = {
  row: number | null;
  name: string;
  action: 'ADD' | 'MOVE' | 'UNCHANGED';
  from: string | null;
  to: string;
};

export type CandidatePreview = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  actions: PlannedAction[];
  counts: { add: number; move: number; unchanged: number };
};

type Request = { row: number | null; name: string; slotId: string };

type Context = {
  event: { id: string; name: string; timezone: string; minPanel: number };
  slots: Map<string, SlotView>;
  /** "YYYY-MM-DD HH:MM" in event time → slot. */
  slotByLocal: Map<string, SlotView>;
  sessionByTeamName: Map<string, { sessionId: string; teamId: string; name: string; slotId: string; started: boolean }>;
  teamIdByName: Map<string, string>;
  closedDates: Set<string>;
  roomId: string | null;
};

function hhmm(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

function label(s: SlotView): string {
  return `${s.date} ${s.start}`;
}

@Injectable()
export class InterviewScheduleService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ─── Reading ─────────────────────────────────────────────────────────────

  private async context(eventId: string): Promise<Context> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.deletedAt) throw new NotFoundException('Event not found.');
    if (event.setupMode !== 'UPLOAD') {
      throw new BadRequestException(`"${event.name}" was set up with the wizard; its schedule is managed on the Schedule page.`);
    }
    const tz = eventTimezone(event);

    const [slots, sessions, days, room] = await Promise.all([
      this.prisma.timeSlot.findMany({
        where: { eventId },
        orderBy: { startTime: 'asc' },
        include: { panel: { include: { judge: { select: { id: true, name: true } } } } },
      }),
      this.prisma.judgingSession.findMany({
        where: { eventId },
        include: { team: { select: { id: true, name: true } }, scorecards: { select: { status: true } } },
      }),
      this.prisma.judgingDay.findMany({ where: { eventId } }),
      this.prisma.room.findFirst({ where: { eventId }, orderBy: { createdAt: 'asc' } }),
    ]);

    const views = new Map<string, SlotView>();
    const byLocal = new Map<string, SlotView>();
    for (const s of slots) {
      const view: SlotView = {
        id: s.id,
        date: localDate(s.startTime, tz),
        block: s.block,
        sequence: s.sequence,
        kind: s.slotType === 'JUDGING' ? 'INTERVIEW' : s.slotType === 'CALIBRATION' ? 'CALIBRATION' : 'BREAK',
        start: hhmm(s.startTime, tz),
        end: hhmm(s.endTime, tz),
        startUtc: s.startTime,
        endUtc: s.endTime,
        panel: s.panel.map((p) => ({ judgeId: p.judge.id, name: p.judge.name })).sort((a, b) => a.name.localeCompare(b.name)),
        candidate: null,
      };
      views.set(s.id, view);
      if (view.kind === 'INTERVIEW') byLocal.set(`${view.date} ${view.start}`, view);
    }

    const sessionByTeamName: Context['sessionByTeamName'] = new Map();
    for (const s of sessions) {
      const started = s.stage !== 'SCHEDULED' || s.scorecards.some((c) => c.status !== 'NOT_STARTED');
      const placed = { sessionId: s.id, teamId: s.team.id, name: s.team.name, slotId: s.timeSlotId, started };
      sessionByTeamName.set(s.team.name.toLowerCase(), placed);
      const v = views.get(s.timeSlotId);
      if (v) v.candidate = { sessionId: s.id, teamId: s.team.id, name: s.team.name, started };
    }
    const teams = await this.prisma.team.findMany({ where: { eventId, deletedAt: null }, select: { id: true, name: true } });

    return {
      event: { id: event.id, name: event.name, timezone: tz, minPanel: event.minJudgesPerTeam },
      slots: views,
      slotByLocal: byLocal,
      sessionByTeamName,
      teamIdByName: new Map(teams.map((t) => [t.name.toLowerCase(), t.id])),
      closedDates: new Set(days.filter((d) => d.status === 'CLOSED').map((d) => d.date.toISOString().slice(0, 10))),
      roomId: room?.id ?? null,
    };
  }

  async schedule(eventId: string): Promise<ScheduleView> {
    const ctx = await this.context(eventId);
    const days = await this.prisma.judgingDay.findMany({ where: { eventId }, orderBy: { date: 'asc' } });
    const out: DayView[] = days.map((d) => ({
      date: d.date.toISOString().slice(0, 10),
      status: d.status,
      panelsLocked: !!d.panelsLockedAt,
      blocks: [],
    }));
    const dayByDate = new Map(out.map((d) => [d.date, d]));
    for (const s of ctx.slots.values()) {
      const day = dayByDate.get(s.date);
      if (!day) continue;
      const name = s.block ?? (Number(s.start.slice(0, 2)) < 12 ? 'AM' : 'PM');
      let block = day.blocks.find((b) => b.block === name);
      if (!block) day.blocks.push((block = { block: name, slots: [] }));
      block.slots.push(s);
    }
    const interviews = [...ctx.slots.values()].filter((s) => s.kind === 'INTERVIEW');
    return {
      event: ctx.event,
      days: out,
      totals: {
        interviews: interviews.length,
        withPanel: interviews.filter((s) => s.panel.length > 0).length,
        placed: interviews.filter((s) => s.candidate).length,
      },
    };
  }

  // ─── Planning ────────────────────────────────────────────────────────────

  /**
   * Work out what a set of placements would do, and everything wrong with it.
   * Requests are judged against the schedule as it will be once all of them
   * apply, so a batch can move A out of a slot and B into it.
   */
  private plan(ctx: Context, requests: Request[]): { actions: PlannedAction[]; errors: Issue[] } {
    const errors: Issue[] = [];
    const err = (row: number | null, message: string) => errors.push({ sheet: 'Candidates', row, message });
    const actions: PlannedAction[] = [];

    // Final occupancy: everyone placed now, minus anyone this batch moves.
    const moving = new Set(requests.map((r) => r.name.toLowerCase()));
    const occupant = new Map<string, string>();
    for (const p of ctx.sessionByTeamName.values()) {
      if (!moving.has(p.name.toLowerCase())) occupant.set(p.slotId, p.name);
    }

    for (const r of requests) {
      const slot = ctx.slots.get(r.slotId)!;
      const current = ctx.sessionByTeamName.get(r.name.toLowerCase());
      const from = current ? ctx.slots.get(current.slotId) : undefined;

      if (current && current.slotId === r.slotId) {
        actions.push({ row: r.row, name: current.name, action: 'UNCHANGED', from: label(slot), to: label(slot) });
        occupant.set(r.slotId, current.name);
        continue;
      }
      let bad = false;
      if (slot.kind !== 'INTERVIEW') { err(r.row, `${r.name}: ${label(slot)} is a ${slot.kind.toLowerCase()}, not an interview.`); bad = true; }
      else if (slot.panel.length === 0) { err(r.row, `${r.name}: the ${label(slot)} interview has no panel (fewer than ${ctx.event.minPanel} judges available).`); bad = true; }
      if (ctx.closedDates.has(slot.date)) { err(r.row, `${r.name}: ${slot.date} is closed.`); bad = true; }
      if (current?.started) { err(r.row, `${current.name}'s interview at ${from ? label(from) : 'their slot'} has started, so they can't be moved.`); bad = true; }
      if (from && ctx.closedDates.has(from.date)) { err(r.row, `${current!.name} is on ${from.date}, which is closed.`); bad = true; }
      const taken = occupant.get(r.slotId);
      if (taken) { err(r.row, `${r.name}: ${label(slot)} already has ${taken}.`); bad = true; }
      if (bad) continue;

      occupant.set(r.slotId, current?.name ?? r.name);
      actions.push({
        row: r.row,
        name: current?.name ?? r.name,
        action: current ? 'MOVE' : 'ADD',
        from: from ? label(from) : null,
        to: label(slot),
      });
    }
    return { actions, errors };
  }

  // ─── Candidate batches ───────────────────────────────────────────────────

  private async planFile(eventId: string, buffer: Buffer) {
    const ctx = await this.context(eventId);
    const { rows, errors } = readCandidatesWorkbook(buffer);
    const requests: Request[] = [];
    for (const r of rows) {
      const slot = ctx.slotByLocal.get(`${r.date} ${r.time}`);
      if (!slot) {
        errors.push({ sheet: 'Candidates', row: r.row, message: `${r.name}: no interview starts at ${r.time} on ${r.date}.` });
        continue;
      }
      requests.push({ row: r.row, name: r.name, slotId: slot.id });
    }
    const planned = this.plan(ctx, requests);
    const allErrors = [...errors, ...planned.errors].sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
    return { ctx, requests, actions: planned.actions, errors: allErrors };
  }

  async previewCandidates(eventId: string, buffer: Buffer): Promise<CandidatePreview> {
    const { actions, errors } = await this.planFile(eventId, buffer);
    const count = (a: PlannedAction['action']) => actions.filter((x) => x.action === a).length;
    const warnings: Issue[] = actions
      .filter((a) => a.action === 'MOVE')
      .map((a) => ({ sheet: 'Candidates', row: a.row, message: `${a.name} moves from ${a.from} to ${a.to}.` }));
    return {
      ok: errors.length === 0,
      errors,
      warnings,
      actions,
      counts: { add: count('ADD'), move: count('MOVE'), unchanged: count('UNCHANGED') },
    };
  }

  async commitCandidates(eventId: string, buffer: Buffer, userId: string) {
    const { ctx, requests, actions, errors } = await this.planFile(eventId, buffer);
    if (errors.length) {
      throw new BadRequestException({ message: 'The candidates file has problems. Upload it again to see them.', errors });
    }
    await this.apply(ctx, requests, actions);
    const count = (a: PlannedAction['action']) => actions.filter((x) => x.action === a).length;
    const counts = { add: count('ADD'), move: count('MOVE'), unchanged: count('UNCHANGED') };
    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'InterviewSchedule', entityId: eventId,
      reason: 'Candidates file uploaded', newValues: { ...counts, actions: actions.filter((a) => a.action !== 'UNCHANGED') },
    });
    return { counts, actions };
  }

  // ─── Moving by hand ──────────────────────────────────────────────────────

  /**
   * Drag and drop: put a placed candidate into another interview slot. If
   * that slot has a candidate, the two swap.
   */
  async move(eventId: string, sessionId: string, toSlotId: string, userId: string) {
    const ctx = await this.context(eventId);
    const mover = [...ctx.sessionByTeamName.values()].find((p) => p.sessionId === sessionId);
    if (!mover) throw new NotFoundException('That candidate is not on this schedule.');
    const target = ctx.slots.get(toSlotId);
    if (!target) throw new NotFoundException('That slot is not on this schedule.');

    const requests: Request[] = [{ row: null, name: mover.name, slotId: toSlotId }];
    const other = target.candidate && target.candidate.sessionId !== sessionId ? target.candidate : null;
    if (other) requests.push({ row: null, name: other.name, slotId: mover.slotId });

    const { actions, errors } = this.plan(ctx, requests);
    if (errors.length) throw new BadRequestException(errors.map((e) => e.message).join(' '));
    await this.apply(ctx, requests, actions);
    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'JudgingSession', entityId: sessionId,
      reason: other ? 'Candidates swapped on the schedule' : 'Candidate moved on the schedule',
      newValues: { actions },
    });
    return { actions };
  }

  // ─── Applying ────────────────────────────────────────────────────────────

  /**
   * Write planned placements. A new candidate gets a team, a session with the
   * slot's panel and an empty scorecard per judge. A moved candidate keeps
   * their session, which takes the new slot's time and panel; their unstarted
   * scorecards are replaced to match. Nothing scored is ever touched: the
   * planner refuses to move anyone whose interview has started.
   */
  private async apply(ctx: Context, requests: Request[], actions: PlannedAction[]) {
    if (!ctx.roomId) throw new BadRequestException('This event has no interview room. Upload the setup again.');
    const slotFor = new Map(requests.map((r) => [r.name.toLowerCase(), r.slotId]));
    const work = actions.filter((a) => a.action !== 'UNCHANGED');
    if (work.length === 0) return;

    await this.prisma.$transaction(async (tx) => {
      for (const a of work) {
        const slot = ctx.slots.get(slotFor.get(a.name.toLowerCase())!)!;
        const judgeIds = slot.panel.map((p) => p.judgeId);
        if (a.action === 'ADD') {
          const teamId = ctx.teamIdByName.get(a.name.toLowerCase()) ?? (await tx.team.create({
            data: { eventId: ctx.event.id, name: a.name, projectName: '', teamLeadName: a.name, teamLeadEmail: '', status: 'SCHEDULED' },
          })).id;
          await tx.team.update({ where: { id: teamId }, data: { status: 'SCHEDULED' } });
          const session = await tx.judgingSession.create({
            data: {
              eventId: ctx.event.id, teamId, roomId: ctx.roomId!, timeSlotId: slot.id,
              scheduledStart: slot.startUtc, scheduledEnd: slot.endUtc,
              judges: { create: judgeIds.map((judgeId) => ({ judgeId })) },
            },
          });
          await tx.scorecard.createMany({
            data: judgeIds.map((judgeId) => ({ sessionId: session.id, judgeId, teamId, eventId: ctx.event.id })),
          });
        } else {
          const current = ctx.sessionByTeamName.get(a.name.toLowerCase())!;
          await tx.criterionScore.deleteMany({ where: { scorecard: { sessionId: current.sessionId } } });
          await tx.scorecard.deleteMany({ where: { sessionId: current.sessionId } });
          await tx.sessionJudge.deleteMany({ where: { sessionId: current.sessionId } });
          await tx.judgingSession.update({
            where: { id: current.sessionId },
            data: {
              timeSlotId: slot.id, scheduledStart: slot.startUtc, scheduledEnd: slot.endUtc,
              judges: { create: judgeIds.map((judgeId) => ({ judgeId })) },
            },
          });
          await tx.scorecard.createMany({
            data: judgeIds.map((judgeId) => ({ sessionId: current.sessionId, judgeId, teamId: current.teamId, eventId: ctx.event.id })),
          });
        }
      }
    }, { timeout: 60_000, maxWait: 10_000 });
  }

  // ─── Access ──────────────────────────────────────────────────────────────

  /**
   * REST calls skip the GraphQL event-scope guard, so check it here: a user
   * assigned to some events may only touch those. Super admins see all.
   */
  async assertAccess(user: { sub?: string; role?: string } | undefined, eventId: string, roles: string[]) {
    if (!user?.sub) throw new ForbiddenException('Sign in first.');
    if (user.role === 'SUPER_ADMIN') return;
    if (!roles.includes(user.role ?? '')) throw new ForbiddenException('Your role cannot do this.');
    const assignments = await this.prisma.eventUser.count({ where: { userId: user.sub } });
    if (assignments === 0) return;
    const assigned = await this.prisma.eventUser.findUnique({ where: { userId_eventId: { userId: user.sub, eventId } } });
    if (!assigned) throw new ForbiddenException('You are not assigned to this event. Ask a super admin to add you.');
  }

  // ─── Locking ─────────────────────────────────────────────────────────────

  /** Lock or unlock a day's judge panels. */
  async setLock(eventId: string, date: string, locked: boolean, userId: string) {
    const day = await this.prisma.judgingDay.findUnique({ where: { eventId_date: { eventId, date: new Date(`${date}T00:00:00.000Z`) } } });
    if (!day) throw new NotFoundException(`${date} is not a judging day of this event.`);
    await this.prisma.judgingDay.update({
      where: { id: day.id },
      data: locked ? { panelsLockedAt: new Date(), panelsLockedById: userId } : { panelsLockedAt: null, panelsLockedById: null },
    });
    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'JudgingDay', entityId: day.id,
      reason: locked ? `Panels locked for ${date}` : `Panels unlocked for ${date}`,
    });
    return { date, panelsLocked: locked };
  }
}
