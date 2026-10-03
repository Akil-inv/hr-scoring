import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { UOB_RUBRIC } from '../scoring-templates/uob-rubric';
import { checkWorkbook, CheckResult, Issue, ParsedWorkbook } from './workbook';

/** What the upload page shows before anything is saved. */
export type UploadPreview = Omit<CheckResult, 'workbook'> & {
  /** Set when this upload would replace an existing event's setup. */
  replacing: { eventId: string; name: string } | null;
};

export type UploadResult = {
  eventId: string;
  replaced: boolean;
  counts: { rooms: number; tracks: number; teams: number; judges: number; sessions: number; days: number; links: number };
  warnings: Issue[];
};

/** A judge link token: 24 URL-safe characters, 144 bits of randomness. */
export function newLinkToken(): string {
  return randomBytes(18).toString('base64url');
}

@Injectable()
export class SetupUploadService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Check a workbook and report what it would create, without saving anything.
   * Adds the checks that need the database: admin accounts that don't exist,
   * and whether an event being replaced can still be replaced.
   */
  async preview(buffer: Buffer, replaceEventId?: string): Promise<UploadPreview> {
    const result = checkWorkbook(buffer);
    const { workbook, ...rest } = result;
    const errors = [...rest.errors];
    const warnings = [...rest.warnings];

    let replacing: UploadPreview['replacing'] = null;
    if (replaceEventId) {
      const blocker = await this.replaceBlocker(replaceEventId);
      if (blocker.error) errors.push({ sheet: 'Event', row: null, message: blocker.error });
      else replacing = { eventId: replaceEventId, name: blocker.name! };
    }

    if (workbook.event) {
      const missing = await this.adminsWithoutAccounts(workbook.event.adminEmails);
      for (const email of missing) {
        warnings.push({
          sheet: 'Event',
          row: 2,
          message: `${email} has no login yet. Create it under Users & roles, then assign it to this event.`,
        });
      }
    }

    return { ...rest, errors, warnings, ok: errors.length === 0, replacing };
  }

  /**
   * Build the event from a workbook. Everything happens in one transaction:
   * either the whole event exists afterwards, or nothing changed.
   */
  async commit(buffer: Buffer, userId: string, replaceEventId?: string): Promise<UploadResult> {
    const check = checkWorkbook(buffer);
    if (!check.ok) {
      throw new BadRequestException({
        message: 'The workbook has problems. Upload it again to see them.',
        errors: check.errors,
      });
    }
    if (replaceEventId) {
      const blocker = await this.replaceBlocker(replaceEventId);
      if (blocker.error) throw new BadRequestException(blocker.error);
    }

    const wb = check.workbook;
    const adminIds = await this.adminUserIds(wb.event!.adminEmails);

    const result = await this.prisma.$transaction(
      async (tx) => {
        if (replaceEventId) await this.clearEventSetup(tx, replaceEventId);
        return this.build(tx, wb, userId, adminIds, replaceEventId);
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    await this.audit.log({
      userId,
      eventId: result.eventId,
      action: replaceEventId ? AuditAction.UPDATE : AuditAction.CREATE,
      entityType: 'Event',
      entityId: result.eventId,
      reason: replaceEventId ? 'Setup replaced by Excel upload' : 'Event created by Excel upload',
      newValues: { ...result.counts, warnings: check.warnings.length },
    });

    return { ...result, replaced: !!replaceEventId, warnings: check.warnings };
  }

  // ─── Building ────────────────────────────────────────────────────────────

  private async build(
    tx: Prisma.TransactionClient,
    wb: ParsedWorkbook,
    userId: string,
    adminIds: string[],
    existingEventId?: string,
  ): Promise<Omit<UploadResult, 'replaced' | 'warnings'>> {
    const ev = wb.event!;
    const dates = [...new Set(wb.sessions.map((s) => s.date))].sort();
    const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

    const eventData = {
      name: ev.name,
      location: ev.location,
      timezone: ev.timezone,
      startDate: asDate(dates[0]),
      endDate: asDate(dates[dates.length - 1]),
      judgingStart: asDate(dates[0]),
      judgingEnd: asDate(dates[dates.length - 1]),
      sessionDurationMinutes: ev.sessionMinutes,
      // The Command Centre's health check and Remove Judge read these. The
      // schema default of 3 would flag every 2-judge panel in the file as
      // unhealthy, so take them from the panels actually uploaded.
      minJudgesPerTeam: Math.min(...wb.sessions.map((s) => s.judgeEmails.length)),
      maxJudgesPerTeam: Math.max(...wb.sessions.map((s) => s.judgeEmails.length)),
      status: 'ACTIVE' as const,
      setupMode: 'UPLOAD' as const,
    };
    const event = existingEventId
      ? await tx.event.update({ where: { id: existingEventId }, data: eventData })
      : await tx.event.create({ data: eventData });
    const eventId = event.id;

    if (adminIds.length) {
      await tx.eventUser.createMany({
        data: adminIds.map((uid) => ({ userId: uid, eventId, role: 'ADMIN' as const })),
        skipDuplicates: true,
      });
    }

    // Rooms
    const roomId = new Map<string, string>();
    await tx.room.createMany({
      data: wb.rooms.map((r) => {
        const id = randomUUID();
        roomId.set(r.name.toLowerCase(), id);
        return { id, eventId, name: r.name, locationDescription: r.location, isVirtual: false, hasVideoConferencing: r.hasVideo };
      }),
    });

    // Tracks, in the order they first appear on the Teams sheet
    const trackId = new Map<string, string>();
    const trackNames = [...new Set(wb.teams.map((t) => t.track).filter((t): t is string => !!t))];
    await tx.challengeTrack.createMany({
      data: trackNames.map((name, i) => {
        const id = randomUUID();
        trackId.set(name.toLowerCase(), id);
        return { id, eventId, name, displayOrder: i };
      }),
    });

    // Teams
    const scheduled = new Set(wb.sessions.map((s) => s.team.toLowerCase()));
    const teamId = new Map<string, string>();
    await tx.team.createMany({
      data: wb.teams.map((t) => {
        const id = randomUUID();
        teamId.set(t.name.toLowerCase(), id);
        return {
          id,
          eventId,
          trackId: t.track ? trackId.get(t.track.toLowerCase()) ?? null : null,
          name: t.name,
          projectName: t.projectName,
          country: t.country,
          organisation: t.organisation,
          teamLeadName: t.leadName,
          teamLeadEmail: t.leadEmail,
          presentationMode: t.mode,
          problemStatement: t.problemStatement,
          solutionSummary: t.solutionSummary,
          status: scheduled.has(t.name.toLowerCase()) ? ('SCHEDULED' as const) : ('ELIGIBLE' as const),
        };
      }),
    });

    // Judges. maxSessions only matters to the automatic scheduler, which an
    // uploaded event never uses; it is set high enough not to mislead.
    const sessionsPerJudge = new Map<string, number>();
    for (const s of wb.sessions) for (const e of s.judgeEmails) sessionsPerJudge.set(e, (sessionsPerJudge.get(e) ?? 0) + 1);
    const judgeId = new Map<string, string>();
    await tx.judge.createMany({
      data: wb.judges.map((j) => {
        const id = randomUUID();
        judgeId.set(j.email, id);
        return {
          id,
          eventId,
          name: j.name,
          email: j.email,
          phone: j.phone,
          organisation: j.organisation,
          designation: j.designation,
          judgeType: 'BUSINESS' as const,
          judgeTier: j.tier ?? 'L3',
          maxSessions: Math.max(10, sessionsPerJudge.get(j.email) ?? 0),
        };
      }),
    });

    // Rubric: the sheet's, or the standard one. Marked ACTIVE straight away —
    // the checks that activation would run have already passed.
    await this.createRubric(tx, eventId, wb);

    // Time slots: one per distinct start/end, shared by every room using it.
    const slotKey = (a: Date, b: Date) => `${a.toISOString()}|${b.toISOString()}`;
    const slotId = new Map<string, string>();
    const slotRows: Prisma.TimeSlotCreateManyInput[] = [];
    for (const s of wb.sessions) {
      const k = slotKey(s.startUtc, s.endUtc);
      if (slotId.has(k)) continue;
      const id = randomUUID();
      slotId.set(k, id);
      slotRows.push({ id, eventId, date: asDate(s.date), startTime: s.startUtc, endTime: s.endUtc, slotType: 'JUDGING' });
    }
    await tx.timeSlot.createMany({ data: slotRows });

    // Sessions, panels and empty scorecards
    const sessionRows: Prisma.JudgingSessionCreateManyInput[] = [];
    const panelRows: Prisma.SessionJudgeCreateManyInput[] = [];
    const scorecardRows: Prisma.ScorecardCreateManyInput[] = [];
    for (const s of wb.sessions) {
      const id = randomUUID();
      const tId = teamId.get(s.team.toLowerCase())!;
      sessionRows.push({
        id,
        eventId,
        teamId: tId,
        roomId: roomId.get(s.room.toLowerCase())!,
        timeSlotId: slotId.get(slotKey(s.startUtc, s.endUtc))!,
        scheduledStart: s.startUtc,
        scheduledEnd: s.endUtc,
      });
      for (const email of s.judgeEmails) {
        const jId = judgeId.get(email)!;
        panelRows.push({ sessionId: id, judgeId: jId });
        scorecardRows.push({ sessionId: id, judgeId: jId, teamId: tId, eventId });
      }
    }
    await tx.judgingSession.createMany({ data: sessionRows });
    await tx.sessionJudge.createMany({ data: panelRows });
    await tx.scorecard.createMany({ data: scorecardRows });

    // Judging days, and one link per judge per day they judge
    const dayId = new Map<string, string>();
    await tx.judgingDay.createMany({
      data: dates.map((d) => {
        const id = randomUUID();
        dayId.set(d, id);
        return { id, eventId, date: asDate(d) };
      }),
    });
    const judgeDays = new Set<string>();
    for (const s of wb.sessions) for (const e of s.judgeEmails) judgeDays.add(`${e}|${s.date}`);
    const links = [...judgeDays].map((k) => {
      const [email, date] = k.split('|');
      return {
        token: newLinkToken(),
        eventId,
        judgeId: judgeId.get(email)!,
        scope: 'DAY' as const,
        dayId: dayId.get(date)!,
        createdById: userId,
      };
    });
    await tx.judgeLink.createMany({ data: links });

    return {
      eventId,
      counts: {
        rooms: wb.rooms.length,
        tracks: trackNames.length,
        teams: wb.teams.length,
        judges: wb.judges.length,
        sessions: wb.sessions.length,
        days: dates.length,
        links: links.length,
      },
    };
  }

  private async createRubric(tx: Prisma.TransactionClient, eventId: string, wb: ParsedWorkbook) {
    const fromSheet = wb.criteria.length > 0;
    const template = await tx.scoringTemplate.create({
      data: {
        eventId,
        name: fromSheet ? `${wb.event!.name} rubric` : UOB_RUBRIC.name,
        description: fromSheet ? 'From the setup upload' : UOB_RUBRIC.description,
        status: 'ACTIVE',
      },
    });

    // Each category followed by its rows, so displayOrder reads top to bottom
    // the way the judge portal shows it.
    type Row = Prisma.ScoringCriterionCreateManyInput;
    const rows: Row[] = [];
    let order = 0;
    if (fromSheet) {
      const cats = wb.criteria.filter((c) => !c.parent);
      for (const cat of cats) {
        const catId = randomUUID();
        rows.push({
          id: catId, templateId: template.id, name: cat.name, maxScore: cat.maxScore, weight: 1,
          displayOrder: order++, guidanceText: cat.guidance, requiresComment: cat.requiresComment,
        });
        for (const kid of wb.criteria.filter((c) => c.parent?.toLowerCase() === cat.name.toLowerCase())) {
          rows.push({
            templateId: template.id, parentId: catId, name: kid.name, maxScore: kid.maxScore, weight: 1,
            displayOrder: order++, guidanceText: kid.guidance, requiresComment: kid.requiresComment,
          });
        }
      }
    } else {
      for (const cat of UOB_RUBRIC.categories) {
        const catId = randomUUID();
        rows.push({
          id: catId, templateId: template.id, name: cat.name, description: cat.description,
          maxScore: cat.maxScore, weight: 1, displayOrder: order++,
        });
        for (const r of cat.rows) {
          rows.push({
            templateId: template.id, parentId: catId, name: r.name, maxScore: r.maxScore, weight: 1,
            displayOrder: order++, guidanceText: r.guidanceText, requiresComment: r.requiresComment ?? false,
          });
        }
      }
    }
    // Parents before children: createMany inserts in order, and the parent
    // foreign key is checked row by row.
    await tx.scoringCriterion.createMany({ data: rows });
  }

  // ─── Replacing ───────────────────────────────────────────────────────────

  /**
   * Why an event's setup can't be replaced, if it can't. Only uploaded events
   * are replaceable, and only before anyone has entered a score: after that,
   * the upload would throw away judging.
   */
  private async replaceBlocker(eventId: string): Promise<{ error?: string; name?: string }> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.deletedAt) return { error: 'The event to replace was not found.' };
    if (event.setupMode !== 'UPLOAD') {
      return { error: `"${event.name}" was set up with the wizard, so it can't be replaced by an upload.` };
    }
    const started = await this.prisma.scorecard.count({
      where: { eventId, OR: [{ status: { not: 'NOT_STARTED' } }, { criterionScores: { some: {} } }] },
    });
    if (started > 0) {
      return {
        error: `Scoring has started for "${event.name}" (${started} scorecard${started === 1 ? '' : 's'}), so its setup can no longer be replaced. Make changes in the Command Centre instead.`,
      };
    }
    return { name: event.name };
  }

  /** Remove an event's setup, keeping the event row, its admins and its audit trail. */
  private async clearEventSetup(tx: Prisma.TransactionClient, eventId: string) {
    const sessions = { session: { eventId } };
    await tx.teamDecision.deleteMany({ where: { eventId } });
    await tx.judgeLink.deleteMany({ where: { eventId } });
    await tx.judgingDay.deleteMany({ where: { eventId } });
    await tx.criterionScore.deleteMany({ where: { scorecard: { eventId } } });
    await tx.scorecard.deleteMany({ where: { eventId } });
    await tx.sessionJudge.deleteMany({ where: sessions });
    await tx.rankingResult.deleteMany({ where: { eventId } });
    await tx.judgingSession.deleteMany({ where: { eventId } });
    await tx.judgeMessage.deleteMany({ where: { eventId } });
    await tx.conflictDeclaration.deleteMany({ where: { eventId } });
    await tx.judgeAvailability.deleteMany({ where: { judge: { eventId } } });
    await tx.judgeExpertise.deleteMany({ where: { judge: { eventId } } });
    await tx.judge.deleteMany({ where: { eventId } });
    await tx.teamMember.deleteMany({ where: { team: { eventId } } });
    await tx.team.deleteMany({ where: { eventId } });
    await tx.scoringCriterion.deleteMany({ where: { template: { eventId } } });
    await tx.scoringTemplate.deleteMany({ where: { eventId } });
    await tx.timeSlot.deleteMany({ where: { eventId } });
    await tx.roomUnavailability.deleteMany({ where: { room: { eventId } } });
    await tx.room.deleteMany({ where: { eventId } });
    await tx.judgingRound.deleteMany({ where: { eventId } });
    await tx.challengeTrack.deleteMany({ where: { eventId } });
  }

  // ─── Admins ──────────────────────────────────────────────────────────────

  private async findUsersByEmail(emails: string[]) {
    if (emails.length === 0) return [];
    return this.prisma.user.findMany({
      where: { OR: emails.map((e) => ({ email: { equals: e, mode: 'insensitive' as const } })) },
      select: { id: true, email: true },
    });
  }

  private async adminsWithoutAccounts(emails: string[]): Promise<string[]> {
    const found = new Set((await this.findUsersByEmail(emails)).map((u) => u.email.toLowerCase()));
    return emails.filter((e) => !found.has(e));
  }

  private async adminUserIds(emails: string[]): Promise<string[]> {
    return (await this.findUsersByEmail(emails)).map((u) => u.id);
  }

  /** Only super admins and admins may set up an event. */
  static assertMaySetUp(user: { role?: string } | undefined) {
    if (!user) throw new ForbiddenException('Sign in first.');
    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only an admin can set up an event.');
    }
  }

  static assertFile(file: Express.Multer.File | undefined): Buffer {
    if (!file?.buffer?.length) throw new BadRequestException('No file received, or the file is empty.');
    const name = (file.originalname || '').toLowerCase();
    if (!name.endsWith('.xlsx')) {
      throw new BadRequestException('Upload the setup file as .xlsx (Excel workbook).');
    }
    return file.buffer;
  }
}

