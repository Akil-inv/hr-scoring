import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import {
  SwapJudgeInput, ChangeRoomInput, RescheduleInput, MarkAbsentInput,
  AddJudgeInput, SetJudgeBreakInput, RemoveJudgeInput, CancelSessionInput, UpdateStageInput, SwapRoomsInput,
} from './operations.types';

@Injectable()
export class OperationsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * A malformed id reaches Prisma's uuid cast and throws an unhandled 500 with
   * a stack trace, rather than a clean 404. Checked before every lookup that
   * takes an id from a caller.
   */
  private assertUuid(value: string | null | undefined, label: string) {
    if (!value || !OperationsService.UUID_RE.test(String(value))) {
      throw new NotFoundException(`${label} not found`);
    }
  }

  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  private async getSessionFull(sessionId: string) {
    this.assertUuid(sessionId, 'Session');
    const session = await this.prisma.judgingSession.findUnique({
      where: { id: sessionId },
      include: {
        team: true, room: true, timeSlot: true,
        judges: { include: { judge: true } },
        scorecards: true,
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  private assertEditable(session: { stage?: string } | null | undefined) {
    // A session with no stage cannot be shown to be editable, so it is treated
    // as not editable. Reading `.stage` off an undefined session would have
    // thrown a TypeError and passed the check by accident.
    if (!session?.stage) {
      throw new BadRequestException('Session has no stage and cannot be modified');
    }
    if (['COMPLETED', 'CANCELLED'].includes(session.stage)) {
      throw new BadRequestException(`Cannot modify a ${session.stage} session`);
    }
  }

  /**
   * `findFirst` returning nothing means "no such assignment" — which is also
   * what a nonexistent judge or slot produces. Left unchecked, a typo'd id read
   * as "this judge is free" and passed every safety check on the way to a
   * double-booking. The ids are verified so absence means absence.
   */
  private async isJudgeBusyInSlot(
    judgeId: string,
    slotId: string,
    excludeSessionId?: string,
    // Set when the ids came from a query rather than from a caller, so the
    // existence lookups can be skipped. Never set on a user-supplied path.
    idsKnownValid = false,
  ) {
    this.assertUuid(judgeId, 'Judge');
    this.assertUuid(slotId, 'Time slot');

    if (!idsKnownValid) {
    const [judge, slot] = await Promise.all([
      this.prisma.judge.findUnique({ where: { id: judgeId }, select: { id: true, deletedAt: true } }),
      this.prisma.timeSlot.findUnique({ where: { id: slotId }, select: { id: true } }),
    ]);
    if (!judge || judge.deletedAt) throw new NotFoundException('Judge not found');
    if (!slot) throw new NotFoundException('Time slot not found');
    }

    const found = await this.prisma.sessionJudge.findFirst({
      where: {
        judgeId,
        session: {
          timeSlotId: slotId,
          stage: { notIn: ['CANCELLED', 'RESCHEDULED'] },
          ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
        },
      },
    });
    return !!found;
  }

  /**
   * Same shape as isJudgeBusyInSlot, and more serious: "no declaration found"
   * and "no such judge" both returned false, so a bad id read as "no conflict"
   * and cleared a judge to score a team they may well have a stake in.
   */
  private async hasConflict(judgeId: string, teamId: string, idsKnownValid = false) {
    this.assertUuid(judgeId, 'Judge');
    this.assertUuid(teamId, 'Team');

    if (!idsKnownValid) {
    const [judge, team] = await Promise.all([
      this.prisma.judge.findUnique({ where: { id: judgeId }, select: { id: true, deletedAt: true } }),
      this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true, deletedAt: true } }),
    ]);
    if (!judge || judge.deletedAt) throw new NotFoundException('Judge not found');
    if (!team || team.deletedAt) throw new NotFoundException('Team not found');
    }

    const found = await this.prisma.conflictDeclaration.findFirst({
      where: { judgeId, teamId, status: 'ACTIVE' },
    });
    return !!found;
  }

  // Check if a judge would need to change rooms between adjacent sessions in the same half-day
  private async checkJudgeRoomMovements(judgeId: string, eventId: string, newSlotId: string, newRoomId: string, excludeSessionId?: string): Promise<string[]> {
    const warnings: string[] = [];
    
    // A missing slot used to return an empty warnings array, which a
    // coordinator reads as "no conflicts" — a green light produced by a row
    // that does not exist.
    this.assertUuid(newSlotId, 'Time slot');
    const newSlot = await this.prisma.timeSlot.findUnique({ where: { id: newSlotId } });
    if (!newSlot) throw new NotFoundException('Time slot not found');
    
    // Get all sessions this judge is assigned to in this event
    const judgeSessions = await this.prisma.sessionJudge.findMany({
      where: {
        judgeId,
        session: {
          eventId,
          stage: { notIn: ['CANCELLED', 'RESCHEDULED'] },
          ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
        },
      },
      include: {
        session: { include: { timeSlot: true, room: true, team: true } },
      },
    });
    
    const judge = await this.prisma.judge.findUnique({ where: { id: judgeId } });
    const judgeName = judge?.name || 'Judge';
    
    // Find sessions in adjacent time slots (same date, within 30 mins)
    const newStart = newSlot.startTime ? new Date(newSlot.startTime).getTime() : 0;
    const newEnd = newSlot.endTime ? new Date(newSlot.endTime).getTime() : 0;
    
    for (const sj of judgeSessions) {
      const sjSlot = sj.session.timeSlot;
      if (!sjSlot?.startTime || !sjSlot?.endTime) continue;
      
      const sjStart = new Date(sjSlot.startTime).getTime();
      const sjEnd = new Date(sjSlot.endTime).getTime();
      const sjRoom = sj.session.room;
      
      // Check if this session is immediately before or after
      const gapAfter = newStart - sjEnd; // new session starts after existing ends
      const gapBefore = sjStart - newEnd; // existing starts after new ends
      
      const isAdjacent = (gapAfter >= 0 && gapAfter <= 30 * 60 * 1000) || (gapBefore >= 0 && gapBefore <= 30 * 60 * 1000);
      
      if (isAdjacent && sjRoom && sjRoom.id !== newRoomId) {
        const direction = gapAfter >= 0 ? 'previous' : 'next';
        warnings.push(
          `${judgeName} would need to move from ${direction === 'previous' ? sjRoom.name : newRoomId} to ${direction === 'previous' ? newRoomId : sjRoom.name} between adjacent sessions (${sj.session.team.name})`
        );
      }
    }
    
    return warnings;
  }

  // Check room movements for all judges in a session after a potential change
  private async checkAllJudgeMovements(sessionId: string, newSlotId: string, newRoomId: string): Promise<string[]> {
    const session = await this.prisma.judgingSession.findUnique({
      where: { id: sessionId },
      include: { judges: { include: { judge: true } } },
    });
    if (!session) return [];
    
    const allWarnings: string[] = [];
    for (const sj of session.judges) {
      const w = await this.checkJudgeRoomMovements(sj.judgeId, session.eventId, newSlotId, newRoomId, sessionId);
      allWarnings.push(...w);
    }
    return allWarnings;
  }

  private async isRoomBusyInSlot(roomId: string, slotId: string, excludeSessionId?: string) {
    const found = await this.prisma.judgingSession.findFirst({
      where: {
        roomId, timeSlotId: slotId,
        stage: { notIn: ['CANCELLED', 'RESCHEDULED'] },
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
      },
    });
    return !!found;
  }

  private async getJudgeLoad(judgeId: string, eventId: string) {
    return this.prisma.sessionJudge.count({
      where: { judgeId, session: { eventId, stage: { notIn: ['CANCELLED', 'RESCHEDULED'] } } },
    });
  }

  // ─── UPDATE SESSION STAGE ───
  async updateStage(input: UpdateStageInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    const validTransitions: Record<string, string[]> = {
      'SCHEDULED': ['IN_PROGRESS', 'DELAYED', 'CANCELLED', 'NO_SHOW'],
      'IN_PROGRESS': ['COMPLETED', 'DELAYED'],
      'DELAYED': ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
      'RESCHEDULED': ['SCHEDULED'],
    };

    const allowed = validTransitions[session.stage] || [];
    if (!allowed.includes(input.stage)) {
      throw new BadRequestException(`Cannot move from ${session.stage} to ${input.stage}. Allowed: ${allowed.join(', ')}`);
    }

    // GUARD: Only one active session per room at a time
    if (input.stage === 'IN_PROGRESS') {
      const activeInRoom = await this.prisma.judgingSession.findFirst({
        where: {
          roomId: session.roomId,
          id: { not: session.id },
          stage: { in: ['IN_PROGRESS', 'QA', 'SCORING'] },
        },
        include: { team: true },
      });
      if (activeInRoom) {
        throw new BadRequestException(
          `Room ${session.room.name} already has an active session (${activeInRoom.team.name}). Complete it first.`
        );
      }
    }

    const timeUpdates: any = {};
    if (input.stage === 'IN_PROGRESS' && !session.actualStart) timeUpdates.actualStart = new Date();
    if (input.stage === 'COMPLETED') timeUpdates.actualEnd = new Date();
    if (input.stage === 'DELAYED') {
      const delayMins = session.scheduledStart ? Math.round((Date.now() - new Date(session.scheduledStart).getTime()) / 60000) : 0;
      timeUpdates.delayMinutes = Math.max(delayMins, 0);
      timeUpdates.delayReason = input.notes || 'Delayed';
    }

    await this.prisma.judgingSession.update({
      where: { id: session.id },
      data: { stage: input.stage as any, notes: input.notes || session.notes, ...timeUpdates },
    });

    // Auto-create scorecards when session starts
    if (input.stage === "IN_PROGRESS") {
      // One write for the whole panel, with the database deciding uniqueness.
      //
      // The previous form read for an existing scorecard and then created one.
      // Two clicks in quick succession both read nothing and both write, and
      // the unique constraint surfaces that as a Prisma error at the moment a
      // session is starting.
      //
      // It was also checking the wrong key: the read looked for any scorecard
      // by this judge for this team in this event, while the constraint is on
      // session and judge. A judge who had scored that team in a rescheduled
      // session read as "exists" and got no scorecard for the session actually
      // starting — they would open their portal and find nothing to score.
      await this.prisma.scorecard.createMany({
        data: session.judges.map((sj: any) => ({
          sessionId: session.id,
          judgeId: sj.judgeId,
          teamId: session.teamId,
          eventId: session.eventId,
        })),
        skipDuplicates: true,
      });
    }

    await this.audit.log({
      userId, eventId: session.eventId,
      action: AuditAction.UPDATE, entityType: 'JudgingSession', entityId: session.id,
      oldValues: { stage: session.stage }, newValues: { stage: input.stage },
    });

    return { success: true, message: `${session.team.name}: ${session.stage} → ${input.stage}`, warnings: [] };
  }

  // ─── SWAP JUDGE ───
  async swapJudge(input: SwapJudgeInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    this.assertEditable(session);

    const oldSJ = session.judges.find((sj: any) => sj.judgeId === input.oldJudgeId);
    if (!oldSJ) throw new BadRequestException('Old judge not assigned to this session');

    const oldSC = session.scorecards.find((sc: any) => sc.judgeId === input.oldJudgeId);
    if (oldSC && ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(oldSC.status)) {
      throw new BadRequestException('Old judge has submitted scores. Reopen the scorecard first.');
    }

    if (input.newJudgeId === input.oldJudgeId) throw new BadRequestException('Same judge');
    if (session.judges.some((sj: any) => sj.judgeId === input.newJudgeId)) throw new BadRequestException('New judge already on this session');
    if (await this.hasConflict(input.newJudgeId, session.teamId)) throw new BadRequestException('New judge has conflict of interest');
    if (await this.isJudgeBusyInSlot(input.newJudgeId, session.timeSlotId, session.id)) throw new BadRequestException('New judge busy in this slot');

    const newJudge = await this.prisma.judge.findUnique({ where: { id: input.newJudgeId } });
    if (!newJudge) throw new NotFoundException('New judge not found');

    const warnings: string[] = [];
    const load = await this.getJudgeLoad(input.newJudgeId, session.eventId);
    if (load >= newJudge.maxSessions) warnings.push(`${newJudge.name} exceeds max sessions`);

    await this.prisma.$transaction(async (tx) => {
      await tx.sessionJudge.delete({ where: { id: oldSJ.id } });
      await tx.sessionJudge.create({ data: { sessionId: session.id, judgeId: input.newJudgeId } });
      if (oldSC && oldSC.status === 'NOT_STARTED') {
        await tx.scorecard.delete({ where: { id: oldSC.id } });
      }
      await tx.scorecard.create({
        data: { sessionId: session.id, judgeId: input.newJudgeId, teamId: session.teamId, eventId: session.eventId },
      });
    });

    await this.audit.log({
      userId, eventId: session.eventId,
      action: AuditAction.UPDATE, entityType: 'JudgingSession', entityId: session.id,
      oldValues: { judge: oldSJ.judge.name }, newValues: { judge: newJudge.name }, reason: input.reason,
    });

    return { success: true, message: `Swapped ${oldSJ.judge.name} → ${newJudge.name}`, warnings };
  }

  // ─── ADD JUDGE ───
  async addJudge(input: AddJudgeInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    this.assertEditable(session);

    const event = await this.prisma.event.findUnique({ where: { id: session.eventId } });
    if (session.judges.length >= (event?.maxJudgesPerTeam || 5)) throw new BadRequestException('Maximum judges reached');
    if (session.judges.some((sj: any) => sj.judgeId === input.judgeId)) throw new BadRequestException('Judge already assigned');
    if (await this.hasConflict(input.judgeId, session.teamId)) throw new BadRequestException('Judge has conflict');
    if (await this.isJudgeBusyInSlot(input.judgeId, session.timeSlotId, session.id)) throw new BadRequestException('Judge busy in this slot');

    const judge = await this.prisma.judge.findUnique({ where: { id: input.judgeId } });
    if (!judge) throw new NotFoundException('Judge not found');

    await this.prisma.$transaction(async (tx) => {
      await tx.sessionJudge.create({ data: { sessionId: session.id, judgeId: input.judgeId } });
      await tx.scorecard.create({
        data: { sessionId: session.id, judgeId: input.judgeId, teamId: session.teamId, eventId: session.eventId },
      });
    });

    return { success: true, message: `Added ${judge.name} to ${session.team.name}`, warnings: [] };
  }

  /**
   * Take a judge off a session.
   *
   * Refused below the event minimum: a coordinator under pressure should not be
   * able to leave a team under-judged with one click. Refused too if the judge
   * has submitted — that scorecard is evidence, and losing a score to tidy up a
   * panel is not a trade worth offering. A draft or unstarted card goes with
   * them, since neither is worth keeping.
   */
  async removeJudge(input: RemoveJudgeInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    this.assertEditable(session);

    // Stricter than adding, deliberately. An extra judge in a running session is
    // recoverable; taking one out is not — the team has already presented to
    // them, and a partial judgement of something nobody can re-watch is not
    // something to discard on a click. A judge who has to leave mid-session is
    // marked absent instead, which preserves the record.
    if (session.stage !== 'SCHEDULED') {
      throw new BadRequestException(
        `This session is ${session.stage.toLowerCase().replace('_', ' ')}. ` +
        'Judges cannot be removed once a session has started — mark them absent instead.',
      );
    }

    const event = await this.prisma.event.findUnique({ where: { id: session.eventId } });
    const minimum = event?.minJudgesPerTeam ?? 3;

    if (session.judges.length <= minimum) {
      throw new BadRequestException(
        `This session has ${session.judges.length} judge(s) and the event minimum is ${minimum}. ` +
        'Swap the judge instead, or raise the minimum.',
      );
    }

    const assignment = session.judges.find((sj: any) => sj.judgeId === input.judgeId);
    if (!assignment) throw new NotFoundException('That judge is not on this session');

    const scorecard = session.scorecards.find((sc: any) => sc.judgeId === input.judgeId);
    if (scorecard && ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(scorecard.status)) {
      throw new BadRequestException(
        `${assignment.judge?.name ?? 'That judge'} has already submitted a score. ` +
        'Reopen and withdraw it first if it should not count.',
      );
    }

    const warnings: string[] = [];
    if (scorecard?.status === 'DRAFT') {
      warnings.push('A draft scorecard was discarded with the judge');
    }

    await this.prisma.$transaction(async (tx) => {
      if (scorecard) {
        await tx.criterionScore.deleteMany({ where: { scorecardId: scorecard.id } });
        await tx.scorecard.delete({ where: { id: scorecard.id } });
      }
      await tx.sessionJudge.delete({ where: { id: assignment.id } });
    });

    await this.audit.log({
      userId, eventId: session.eventId,
      action: AuditAction.UPDATE, entityType: 'JudgingSession', entityId: session.id,
      newValues: { removedJudge: input.judgeId, remaining: session.judges.length - 1 },
    });

    return {
      success: true,
      message: `Removed ${assignment.judge?.name ?? 'judge'} from ${session.team.name}`,
      warnings,
    };
  }

  /**
   * Mark an MD out of a session on their behalf, or back into it.
   *
   * The same field the judge's own control writes, with the same rules — only
   * an MD, and not once they have submitted. A coordinator marking it is the
   * common case, since a judge who has stepped out to take a call is not
   * necessarily going to open their portal to say so.
   */
  async setJudgeBreak(input: SetJudgeBreakInput, userId: string) {
    const assignment = await this.prisma.sessionJudge.findFirst({
      where: { sessionId: input.sessionId, judgeId: input.judgeId },
      include: { judge: true, session: { include: { team: true } } },
    });
    if (!assignment) throw new NotFoundException('That judge is not on this session');

    if (!['L2', 'L3', 'L4'].includes((assignment.judge as any).judgeTier)) {
      throw new BadRequestException(
        `${assignment.judge.name} holds a seat with no cover, so it cannot be left ` +
        'empty. Swap them instead.',
      );
    }

    if (input.onBreak) {
      const otherIgOnBreak = await this.prisma.sessionJudge.findFirst({
        where: {
          sessionId: input.sessionId,
          judgeId: { not: input.judgeId },
          onBreak: true,
          judge: { judgeTier: { in: ['L2', 'L3', 'L4'] as any } },
        } as any,
        include: { judge: true },
      });

      if (otherIgOnBreak) {
        throw new BadRequestException(
          `${otherIgOnBreak.judge.name} has already stepped out of this session. ` +
          'Only one can — the team would otherwise be scored by one judge.',
        );
      }
    }

    const scorecard = await this.prisma.scorecard.findFirst({
      where: { sessionId: input.sessionId, judgeId: input.judgeId },
    });

    if (
      input.onBreak &&
      scorecard &&
      ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(scorecard.status)
    ) {
      throw new BadRequestException(
        `${assignment.judge.name} has already submitted a score. Reopen it first ` +
        'if it should not count.',
      );
    }

    await this.prisma.sessionJudge.update({
      where: { id: assignment.id },
      data: { onBreak: input.onBreak, breakAt: input.onBreak ? new Date() : null } as any,
    });

    if (input.onBreak && scorecard && scorecard.status === 'DRAFT') {
      await this.prisma.criterionScore.deleteMany({ where: { scorecardId: scorecard.id } });
      await this.prisma.scorecard.update({
        where: { id: scorecard.id },
        data: { status: 'NOT_STARTED', totalScore: null },
      });
    }

    await this.audit.log({
      userId, eventId: assignment.session.eventId,
      action: AuditAction.UPDATE, entityType: 'SessionJudge', entityId: assignment.id,
      newValues: { judge: assignment.judge.name, onBreak: input.onBreak },
    });

    return {
      success: true,
      message: input.onBreak
        ? `${assignment.judge.name} stepped out of ${assignment.session.team.name}`
        : `${assignment.judge.name} is back on ${assignment.session.team.name}`,
      warnings: [],
    };
  }

  // ─── CANCEL SESSION ───
  async cancelSession(input: CancelSessionInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    if (session.stage === 'CANCELLED') throw new BadRequestException('Already cancelled');

    await this.prisma.judgingSession.update({
      where: { id: session.id },
      data: { stage: 'CANCELLED', notes: input.reason },
    });

    const warnings: string[] = [];
    const hasSubmitted = session.scorecards.some((sc: any) => ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(sc.status));
    if (hasSubmitted) warnings.push('Session has submitted scorecards — preserved for audit');

    return { success: true, message: `${session.team.name} cancelled`, warnings };
  }

  // ─── CHANGE ROOM ───
  async changeRoom(input: ChangeRoomInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    this.assertEditable(session);

    const newRoom = await this.prisma.room.findUnique({ where: { id: input.newRoomId } });
    if (!newRoom) throw new NotFoundException('Room not found');
    if (await this.isRoomBusyInSlot(input.newRoomId, session.timeSlotId, session.id)) {
      throw new BadRequestException(`${newRoom.name} is booked for this slot`);
    }

    await this.prisma.judgingSession.update({ where: { id: session.id }, data: { roomId: input.newRoomId } });

    const moveWarnings = await this.checkAllJudgeMovements(session.id, session.timeSlotId, input.newRoomId);
    return { success: true, message: `Moved ${session.team.name} to ${newRoom.name}`, warnings: moveWarnings };
  }

  // ─── RESCHEDULE ───
  async reschedule(input: RescheduleInput, userId: string) {
    const session = await this.getSessionFull(input.sessionId);
    this.assertEditable(session);

    const newSlot = await this.prisma.timeSlot.findUnique({ where: { id: input.newTimeSlotId } });
    if (!newSlot) throw new NotFoundException('Slot not found');
    const roomId = input.newRoomId || session.roomId;

    if (await this.isRoomBusyInSlot(roomId, input.newTimeSlotId, session.id)) throw new BadRequestException('Room booked');

    for (const sj of session.judges) {
      if (await this.isJudgeBusyInSlot(sj.judgeId, input.newTimeSlotId, session.id)) {
        throw new BadRequestException(`Judge ${sj.judge.name} busy in new slot`);
      }
    }

    await this.prisma.judgingSession.update({
      where: { id: session.id },
      data: { timeSlotId: input.newTimeSlotId, roomId, scheduledStart: newSlot.startTime, scheduledEnd: newSlot.endTime, stage: 'SCHEDULED' },
    });

    const moveWarnings = await this.checkAllJudgeMovements(session.id, input.newTimeSlotId, roomId);
    return { success: true, message: `${session.team.name} rescheduled`, warnings: moveWarnings };
  }

  // ─── MARK JUDGE ABSENT ───
  async markJudgeAbsent(input: MarkAbsentInput, userId: string) {
    const judge = await this.prisma.judge.findUnique({ where: { id: input.judgeId } });
    if (!judge) throw new NotFoundException('Judge not found');

    const affected = await this.prisma.sessionJudge.findMany({
      where: { judgeId: input.judgeId, session: { eventId: input.eventId, stage: { in: ['SCHEDULED', 'TEAM_CHECKED_IN', 'JUDGES_PRESENT', 'READY'] } } },
      include: { session: { include: { team: true, judges: true } } },
    });

    await this.prisma.judge.update({ where: { id: input.judgeId }, data: { status: 'UNAVAILABLE' } });

    const warnings = affected.map((sj: any) => `${sj.session.team.name}: ${sj.session.judges.length - 1} judges remaining`);
    return { success: true, message: `${judge.name} marked absent. ${affected.length} sessions affected.`, warnings };
  }

  // ─── SWAP ROOMS ───
  async swapRooms(input: SwapRoomsInput, userId: string) {
    const sessionA = await this.getSessionFull(input.sessionIdA);
    const sessionB = await this.getSessionFull(input.sessionIdB);
    this.assertEditable(sessionA);
    this.assertEditable(sessionB);

    if (sessionA.timeSlotId !== sessionB.timeSlotId) throw new BadRequestException('Must be same time slot');

    await this.prisma.$transaction(async (tx) => {
      const roomA = sessionA.roomId;
      const roomB = sessionB.roomId;
      await tx.judgingSession.update({ where: { id: sessionA.id }, data: { roomId: roomB } });
      await tx.judgingSession.update({ where: { id: sessionB.id }, data: { roomId: roomA } });
    });

    return { success: true, message: `Swapped rooms: ${sessionA.team.name} ↔ ${sessionB.team.name}`, warnings: [] };
  }

  // ─── SWAP TEAMS ONLY (judges stay in their rooms) ───
  async swapTeams(sessionIdA: string, sessionIdB: string, userId: string) {
    const a = await this.getSessionFull(sessionIdA);
    const b = await this.getSessionFull(sessionIdB);

    // Cannot swap started, completed, or cancelled sessions
    const blocked = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'SCORING', 'QA'];
    if (blocked.includes(a.stage)) throw new BadRequestException(`${a.team.name} is ${a.stage} — cannot swap`);
    if (blocked.includes(b.stage)) throw new BadRequestException(`${b.team.name} is ${b.stage} — cannot swap`);

    if (a.eventId !== b.eventId) throw new BadRequestException('Sessions must be in the same event');

    // Everything below runs in one transaction. The team swap used to happen
    // outside it, so a failure here left teams swapped but scorecards stale.
    await this.prisma.$transaction(async (tx) => {
      // Raw SQL swaps both team IDs in a single statement, avoiding the
      // unique constraint on (team_id, time_slot_id) that a two-step update
      // would trip.
      await tx.$executeRawUnsafe(
        `UPDATE judging_sessions SET team_id = CASE id WHEN $1::uuid THEN $3::uuid WHEN $2::uuid THEN $4::uuid END WHERE id IN ($1::uuid, $2::uuid)`,
        a.id, b.id, b.teamId, a.teamId
      );

      // Clear child criterion_scores before deleting the scorecards that own
      // them. Without this, criterion_scores_scorecard_id_fkey rejects the
      // delete and the whole swap fails — which it does as soon as a judge
      // has typed anything into a draft.
      const staleScorecards = await tx.scorecard.findMany({
        where: {
          sessionId: { in: [a.id, b.id] },
          status: { in: ['NOT_STARTED', 'DRAFT'] },
        },
        select: { id: true },
      });
      const staleIds = staleScorecards.map((sc) => sc.id);

      if (staleIds.length > 0) {
        await tx.criterionScore.deleteMany({ where: { scorecardId: { in: staleIds } } });
        await tx.scorecard.deleteMany({ where: { id: { in: staleIds } } });
      }

      // Scorecards for both sides in one write each.
      //
      // The previous form read for an existing row and then created one, which
      // leaves a window where two concurrent swaps both see nothing and both
      // write. `@@unique([sessionId, judgeId])` already guarantees uniqueness;
      // skipDuplicates lets the database enforce it rather than the code
      // guessing from a read taken a moment earlier.
      await tx.scorecard.createMany({
        data: a.judges.map((sj: any) => ({
          sessionId: a.id, judgeId: sj.judgeId, teamId: b.teamId, eventId: a.eventId,
        })),
        skipDuplicates: true,
      });

      await tx.scorecard.createMany({
        data: b.judges.map((sj: any) => ({
          sessionId: b.id, judgeId: sj.judgeId, teamId: a.teamId, eventId: b.eventId,
        })),
        skipDuplicates: true,
      });
    });

    await this.audit.log({
      userId, eventId: a.eventId,
      action: AuditAction.UPDATE, entityType: 'JudgingSession', entityId: a.id,
      oldValues: { team: a.team.name }, newValues: { team: b.team.name },
      reason: `Teams swapped: ${a.team.name} <-> ${b.team.name}`,
    });

    // Check if any judges have conflicts with the swapped teams
    const swapWarnings: string[] = [];
    for (const sj of a.judges) {
      if (await this.hasConflict(sj.judgeId, b.teamId)) {
        swapWarnings.push(`${sj.judge.name} has a conflict of interest with ${b.team.name} (now assigned to them)`);
      }
    }
    for (const sj of b.judges) {
      if (await this.hasConflict(sj.judgeId, a.teamId)) {
        swapWarnings.push(`${sj.judge.name} has a conflict of interest with ${a.team.name} (now assigned to them)`);
      }
    }
    return { success: true, message: `Teams swapped: ${a.team.name} and ${b.team.name}`, warnings: swapWarnings };
  }

  // ─── SWAP SESSIONS (swap time slots and rooms) ───
  async swapSessions(sessionIdA: string, sessionIdB: string, userId: string) {
    const a = await this.getSessionFull(sessionIdA);
    const b = await this.getSessionFull(sessionIdB);

    const blocked = ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'SCORING', 'QA'];
    if (blocked.includes(a.stage)) throw new BadRequestException(`${a.team.name} is ${a.stage} — cannot swap`);
    if (blocked.includes(b.stage)) throw new BadRequestException(`${b.team.name} is ${b.stage} — cannot swap`);

    if (a.eventId !== b.eventId) throw new BadRequestException('Sessions must be in the same event');

    // Check all judges from A are available in B's slot and vice versa
    // Must exclude BOTH sessions being swapped from the busy check
    // Asked once rather than once per judge, so the error can name everyone who
    // is busy. A coordinator told only about the first has to try the swap
    // again to discover the second.
    const aBusy = await this.prisma.sessionJudge.findMany({
      where: {
        judgeId: { in: a.judges.map((sj: any) => sj.judgeId) },
        session: {
          timeSlotId: b.timeSlotId,
          id: { notIn: [a.id, b.id] },
          stage: { notIn: ['CANCELLED', 'RESCHEDULED'] },
        },
      },
      select: { judgeId: true },
    });

    if (aBusy.length > 0) {
      const busyIds = new Set(aBusy.map(x => x.judgeId));
      const names = a.judges
        .filter((sj: any) => busyIds.has(sj.judgeId))
        .map((sj: any) => sj.judge.name);
      throw new BadRequestException(
        `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} busy in the target slot`,
      );
    }
    const bBusy = await this.prisma.sessionJudge.findMany({
      where: {
        judgeId: { in: b.judges.map((sj: any) => sj.judgeId) },
        session: {
          timeSlotId: a.timeSlotId,
          id: { notIn: [a.id, b.id] },
          stage: { notIn: ['CANCELLED', 'RESCHEDULED'] },
        },
      },
      select: { judgeId: true },
    });

    if (bBusy.length > 0) {
      const busyIds = new Set(bBusy.map(x => x.judgeId));
      const names = b.judges
        .filter((sj: any) => busyIds.has(sj.judgeId))
        .map((sj: any) => sj.judge.name);
      throw new BadRequestException(
        `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} busy in the target slot`,
      );
    }

    const aSlot = a.timeSlotId;
    const aRoom = a.roomId;
    const aStart = a.scheduledStart;
    const aEnd = a.scheduledEnd;

    // Use raw SQL to swap atomically - avoids unique constraint on (room_id, time_slot_id)
    await this.prisma.$executeRaw`
      UPDATE judging_sessions SET
        time_slot_id = CASE
          WHEN id = ${a.id}::uuid THEN ${b.timeSlotId}::uuid
          WHEN id = ${b.id}::uuid THEN ${aSlot}::uuid
        END,
        room_id = CASE
          WHEN id = ${a.id}::uuid THEN ${b.roomId}::uuid
          WHEN id = ${b.id}::uuid THEN ${aRoom}::uuid
        END,
        scheduled_start = CASE
          WHEN id = ${a.id}::uuid THEN ${b.scheduledStart}
          WHEN id = ${b.id}::uuid THEN ${aStart}
        END,
        scheduled_end = CASE
          WHEN id = ${a.id}::uuid THEN ${b.scheduledEnd}
          WHEN id = ${b.id}::uuid THEN ${aEnd}
        END
      WHERE id IN (${a.id}::uuid, ${b.id}::uuid)
    `;

    await this.audit.log({
      userId, eventId: a.eventId,
      action: AuditAction.UPDATE, entityType: 'JudgingSession', entityId: a.id,
      oldValues: { slot: aSlot, room: aRoom }, newValues: { slot: b.timeSlotId, room: b.roomId },
      reason: `Swapped with ${b.team.name}`,
    });

    // Check room movement impact for all judges
    const sessionSwapWarnings: string[] = [];
    for (const sj of a.judges) {
      const w = await this.checkJudgeRoomMovements(sj.judgeId, a.eventId, b.timeSlotId, b.roomId, a.id);
      sessionSwapWarnings.push(...w);
    }
    for (const sj of b.judges) {
      const w = await this.checkJudgeRoomMovements(sj.judgeId, b.eventId, a.timeSlotId, a.roomId, b.id);
      sessionSwapWarnings.push(...w);
    }
    return { success: true, message: `Swapped ${a.team.name} and ${b.team.name}`, warnings: sessionSwapWarnings };
  }

  // ─── FIND REPLACEMENT JUDGES ───
  async findReplacementJudges(sessionId: string) {
    const session = await this.getSessionFull(sessionId);
    const allJudges = await this.prisma.judge.findMany({ where: { eventId: session.eventId, deletedAt: null } });
    const currentIds = new Set(session.judges.map((sj: any) => sj.judgeId));

    const candidates = await Promise.all(
      allJudges.filter(j => !currentIds.has(j.id)).map(async (j) => {
        const load = await this.getJudgeLoad(j.id, session.eventId);
        const conflict = await this.hasConflict(j.id, session.teamId, true);
        const busy = await this.isJudgeBusyInSlot(j.id, session.timeSlotId, undefined, true);
        let score = 100;
        if (j.status !== 'ACTIVE') score -= 80;
        if (conflict) score -= 90;
        if (busy) score -= 70;
        if (load >= j.maxSessions) score -= 50;
        score -= load * 5;
        return { judgeId: j.id, judgeName: j.name, judgeType: j.judgeType, currentLoad: load, maxSessions: j.maxSessions, isAvailable: j.status === 'ACTIVE', hasConflict: conflict, isBusyInSlot: busy, score };
      })
    );
    return candidates.sort((a, b) => b.score - a.score);
  }

  // ─── OUTSTANDING SCORING ───
  /**
   * Sessions that have finished but whose scorecards are not in, grouped by
   * the judge who owes them.
   *
   * Grouped by judge rather than by session on purpose: one judge with six
   * outstanding scorecards is one conversation, not six problems. Sorted by
   * the oldest outstanding session so anything left over from yesterday
   * surfaces above this morning's.
   *
   * There is no hard stop anywhere — a judge who does not finish on day one
   * can finish on day two. This exists so a coordinator knows who to chase.
   * The platform never contacts judges itself.
   */
  /**
   * Send a note to one or more judges.
   *
   * Any undismissed message for the same judge is retired first, so a judge
   * never accumulates a queue. The newest instruction is the one that matters.
   */
  async messageJudges(eventId: string, judgeIds: string[], body: string, sentByName: string) {
    const text = body.trim();
    if (!text) throw new BadRequestException('Message cannot be empty');
    if (judgeIds.length === 0) throw new BadRequestException('Pick at least one judge');

    await this.prisma.judgeMessage.updateMany({
      where: { judgeId: { in: judgeIds }, dismissedAt: null },
      data: { dismissedAt: new Date() },
    });

    await this.prisma.judgeMessage.createMany({
      data: judgeIds.map(judgeId => ({ judgeId, eventId, body: text, sentByName })),
    });

    return { sent: judgeIds.length };
  }

  /** Who has read it and who has not — the useful half of a read receipt. */
  async judgeMessages(eventId: string) {
    const messages = await this.prisma.judgeMessage.findMany({
      where: { eventId, dismissedAt: null },
      include: { judge: { select: { id: true, name: true } } },
      orderBy: { sentAt: 'desc' },
    });
    return messages.map(m => ({
      id: m.id,
      judgeId: m.judge.id,
      judgeName: m.judge.name,
      body: m.body,
      sentByName: m.sentByName,
      sentAt: m.sentAt,
    }));
  }

  async outstandingScoring(eventId: string) {
    const sessions = await this.prisma.judgingSession.findMany({
      where: { eventId, stage: 'COMPLETED' },
      include: {
        team: true,
        room: true,
        timeSlot: true,
        scorecards: { include: { judge: true } },
        judges: true,
      },
    });

    type Row = {
      judgeId: string;
      judgeName: string;
      judgeEmail: string;
      judgePhone: string | null;
      notStarted: number;
      inProgress: number;
      oldestSessionAt: Date | null;
      teams: string[];
    };

    const byJudge = new Map<string, Row>();

    for (const s of sessions) {
      // Who stepped out of this session and owes nothing.
      const excused = new Set(
        (s as any).judges
          .filter((sj: any) => sj.onBreak)
          .map((sj: any) => sj.judgeId as string),
      );

      for (const sc of s.scorecards) {
        if (!['NOT_STARTED', 'DRAFT', 'REOPENED'].includes(sc.status)) continue;
        if (!sc.judge) continue;
        // Chasing an excused judge teaches a coordinator to ignore the panel,
        // which costs more than the one row saves.
        if (excused.has(sc.judgeId)) continue;

        const row = byJudge.get(sc.judgeId) ?? {
          judgeId: sc.judgeId,
          judgeName: sc.judge.name,
          judgeEmail: sc.judge.email,
          judgePhone: sc.judge.phone ?? null,
          notStarted: 0,
          inProgress: 0,
          oldestSessionAt: null,
          teams: [],
        };

        // A judge who has saved a draft is mid-thought. One who has not opened
        // the scorecard may not know they are expected to score at all — a
        // different conversation.
        if (sc.status === 'NOT_STARTED') row.notStarted += 1;
        else row.inProgress += 1;

        const startedAt = s.timeSlot?.startTime ?? s.scheduledStart ?? null;
        if (startedAt && (!row.oldestSessionAt || startedAt < row.oldestSessionAt)) {
          row.oldestSessionAt = startedAt;
        }

        row.teams.push(`${s.team.name} (${s.room?.name ?? 'room tbc'})`);
        byJudge.set(sc.judgeId, row);
      }
    }

    return [...byJudge.values()]
      .sort((a, b) => {
        const at = a.oldestSessionAt?.getTime() ?? 0;
        const bt = b.oldestSessionAt?.getTime() ?? 0;
        return at - bt;
      })
      .map((r) => ({
        judgeId: r.judgeId,
        judgeName: r.judgeName,
        judgeEmail: r.judgeEmail,
        judgePhone: r.judgePhone,
        outstanding: r.notStarted + r.inProgress,
        notStarted: r.notStarted,
        inProgress: r.inProgress,
        oldestSessionAt: r.oldestSessionAt ? r.oldestSessionAt.toISOString() : null,
        teams: r.teams,
      }));
  }

  // ─── HEALTH CHECK ───
  async healthCheck(eventId: string) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new NotFoundException('Event not found');

    const sessions = await this.prisma.judgingSession.findMany({
      where: { eventId, stage: { notIn: ['CANCELLED'] } },
      include: { team: true, room: true, judges: true, scorecards: true },
    });

    return sessions.map(s => {
      const issues: string[] = [];
      if (s.judges.length < event.minJudgesPerTeam) issues.push(`${s.judges.length}/${event.minJudgesPerTeam} judges`);
      const pending = s.scorecards.filter(sc => sc.status === 'NOT_STARTED').length;
      if (s.stage === 'COMPLETED' && pending > 0) issues.push(`${pending} scorecard(s) not started`);
      return { sessionId: s.id, teamName: s.team.name, roomName: s.room.name, stage: s.stage, judgesAssigned: s.judges.length, judgesRequired: event.minJudgesPerTeam, isHealthy: issues.length === 0, issues };
    });
  }
}
