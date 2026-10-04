import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { LAP_RUBRIC, RATING_MAX, RATING_MIN, RatingDimension, ratingAnchors } from '../scoring-templates/lap-rubric';
import { checkWorkbook, CheckResult, DEFAULT_SCORE_STEP, Issue, ParsedWorkbook } from './workbook';

/** What the upload page shows before anything is saved. */
export type UploadPreview = Omit<CheckResult, 'workbook'> & {
  /** Set when this upload would replace an existing event's setup. */
  replacing: { eventId: string; name: string } | null;
};

export type UploadResult = {
  eventId: string;
  replaced: boolean;
  counts: { judges: number; days: number; interviews: number; interviewsWithPanel: number; links: number };
  warnings: Issue[];
};

/** A judge link token: 24 URL-safe characters, 144 bits of randomness. */
export function newLinkToken(): string {
  return randomBytes(18).toString('base64url');
}

/** The one room an interview event runs in: one panel interviews at a time. */
export const PANEL_ROOM_NAME = 'Interview panel';

@Injectable()
export class SetupUploadService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * Check a workbook and report the schedule it would build, without saving
   * anything. Adds the checks that need the database: admin accounts that
   * don't exist, and whether an event being replaced can still be replaced.
   */
  async preview(buffer: Buffer, replaceEventId?: string): Promise<UploadPreview> {
    const { workbook, ...rest } = checkWorkbook(buffer);
    const errors = [...rest.errors];
    const warnings = [...rest.warnings];

    let replacing: UploadPreview['replacing'] = null;
    if (replaceEventId) {
      const blocker = await this.replaceBlocker(replaceEventId);
      if (blocker.error) errors.push({ sheet: 'Event', row: null, message: blocker.error });
      else replacing = { eventId: replaceEventId, name: blocker.name! };
    }

    if (workbook.event) {
      for (const email of await this.adminsWithoutAccounts(workbook.event.adminEmails)) {
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
    const dates = [...new Set(wb.schedule.map((b) => b.date))].sort();
    const asDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
    const interviews = wb.schedule.flatMap((b) => b.slots.filter((s) => s.kind === 'INTERVIEW'));
    const firstInterview = wb.template.find((t) => t.kind === 'INTERVIEW')!;

    const eventData = {
      name: ev.name,
      location: ev.location,
      timezone: ev.timezone,
      startDate: asDate(dates[0]),
      endDate: asDate(dates[dates.length - 1]),
      judgingStart: asDate(dates[0]),
      judgingEnd: asDate(dates[dates.length - 1]),
      sessionDurationMinutes: firstInterview.end - firstInterview.start,
      // The Command Centre's panel health check and Remove Judge read these.
      minJudgesPerTeam: ev.minPanel,
      maxJudgesPerTeam: Math.max(ev.minPanel, ...interviews.map((s) => s.panel.length)),
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

    await tx.room.create({ data: { eventId, name: PANEL_ROOM_NAME, hasVideoConferencing: false } });

    // Judges. maxSessions only matters to the automatic scheduler, which an
    // uploaded event never uses; set high enough not to mislead.
    const seated = new Map<string, number>();
    for (const s of interviews) for (const e of s.panel) seated.set(e, (seated.get(e) ?? 0) + 1);
    const judgeId = new Map<string, string>();
    await tx.judge.createMany({
      data: wb.judges.map((j) => {
        const id = randomUUID();
        judgeId.set(j.email, id);
        return {
          id, eventId, name: j.name, email: j.email, phone: j.phone, organisation: j.organisation,
          designation: j.designation, judgeType: 'BUSINESS' as const, judgeTier: j.tier ?? 'L3',
          maxSessions: Math.max(10, seated.get(j.email) ?? 0),
        };
      }),
    });

    await this.createRubric(tx, eventId, wb);

    // Every item of every scheduled block becomes a time slot, breaks and
    // calibration included, so the day reads in full on the schedule.
    const slotRows: Prisma.TimeSlotCreateManyInput[] = [];
    const panelRows: Prisma.SlotJudgeCreateManyInput[] = [];
    for (const b of wb.schedule) {
      for (const s of b.slots) {
        const id = randomUUID();
        slotRows.push({
          id, eventId, date: asDate(b.date), startTime: s.startUtc, endTime: s.endUtc,
          slotType: s.kind === 'INTERVIEW' ? 'JUDGING' : s.kind === 'BREAK' ? 'BREAK' : 'CALIBRATION',
          block: b.block, sequence: s.sequence,
        });
        for (const email of s.panel) panelRows.push({ timeSlotId: id, judgeId: judgeId.get(email)! });
      }
    }
    await tx.timeSlot.createMany({ data: slotRows });
    await tx.slotJudge.createMany({ data: panelRows });

    // Judging days, and one link per judge per day they sit at least one panel.
    const dayId = new Map<string, string>();
    await tx.judgingDay.createMany({
      data: dates.map((d) => {
        const id = randomUUID();
        dayId.set(d, id);
        return { id, eventId, date: asDate(d) };
      }),
    });
    const judgeDays = new Set<string>();
    for (const b of wb.schedule) for (const s of b.slots) for (const e of s.panel) judgeDays.add(`${e}|${b.date}`);
    const links = [...judgeDays].map((k) => {
      const [email, date] = k.split('|');
      return {
        token: newLinkToken(), eventId, judgeId: judgeId.get(email)!, scope: 'DAY' as const,
        dayId: dayId.get(date)!, createdById: userId,
      };
    });
    await tx.judgeLink.createMany({ data: links });

    return {
      eventId,
      counts: {
        judges: wb.judges.length,
        days: dates.length,
        interviews: interviews.length,
        interviewsWithPanel: interviews.filter((s) => s.panel.length > 0).length,
        links: links.length,
      },
    };
  }

  /**
   * The event's rubric: the Criteria sheet's points rubric when given,
   * otherwise a 1-5 rating rubric from the Rubric sheet, or the LAP rubric
   * when neither sheet is filled in.
   */
  private async createRubric(tx: Prisma.TransactionClient, eventId: string, wb: ParsedWorkbook) {
    if (wb.criteria.length > 0) return this.createPointsRubric(tx, eventId, wb);
    const fromSheet = wb.rating.length > 0;
    const dims: (RatingDimension & { requiresComment?: boolean; scoreStep?: number })[] = fromSheet ? wb.rating : LAP_RUBRIC.dimensions;
    const template = await tx.scoringTemplate.create({
      data: {
        eventId,
        name: fromSheet ? `${wb.event!.name} rubric` : LAP_RUBRIC.name,
        description: fromSheet ? 'From the setup upload' : 'LAP HR interview rubric',
        scale: 'RATING',
        supportQuestion: wb.event?.supportQuestion ?? null,
        maxTotal: RATING_MAX * dims.length,
        status: 'ACTIVE',
      },
    });
    // Comments are required unless the Rubric sheet says N for a dimension:
    // the comments are the record of why.
    await tx.scoringCriterion.createMany({
      data: dims.map((d, i) => ({
        templateId: template.id, name: d.name, description: d.descriptor || null,
        minScore: RATING_MIN, maxScore: RATING_MAX, scoreIncrement: d.scoreStep ?? DEFAULT_SCORE_STEP, weight: 1, displayOrder: i,
        requiresComment: d.requiresComment !== false, scoringAnchors: ratingAnchors(d),
      })),
    });
  }

  private async createPointsRubric(tx: Prisma.TransactionClient, eventId: string, wb: ParsedWorkbook) {
    const template = await tx.scoringTemplate.create({
      data: {
        eventId,
        name: `${wb.event!.name} rubric`,
        description: 'From the setup upload',
        supportQuestion: wb.event?.supportQuestion ?? null,
        // Activation's checks (categories total 100, rows fill each category)
        // already passed in the workbook check.
        status: 'ACTIVE',
      },
    });

    // Each category followed by its rows, so displayOrder reads top to bottom
    // the way the judge portal shows it. Parents precede children, which the
    // parent foreign key needs within one insert.
    const rows: Prisma.ScoringCriterionCreateManyInput[] = [];
    let order = 0;
    for (const cat of wb.criteria.filter((c) => !c.parent)) {
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
    await tx.scoringCriterion.createMany({ data: rows });
  }

  // ─── Replacing ───────────────────────────────────────────────────────────

  /**
   * Why an event's setup can't be replaced, if it can't. Only uploaded events
   * are replaceable, and only before any candidate has been placed: after
   * that, replacing would pull candidates out of their interviews.
   */
  private async replaceBlocker(eventId: string): Promise<{ error?: string; name?: string }> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.deletedAt) return { error: 'The event to replace was not found.' };
    if (event.setupMode !== 'UPLOAD') {
      return { error: `"${event.name}" was set up with the wizard, so it can't be replaced by an upload.` };
    }
    const placed = await this.prisma.judgingSession.count({ where: { eventId } });
    if (placed > 0) {
      return {
        error: `${placed} candidate${placed === 1 ? ' is' : 's are'} already placed in "${event.name}", so its setup can no longer be replaced. Untick Replace to set this file up as a new event, or change panels on the Schedule page.`,
      };
    }
    return { name: event.name };
  }

  /** Remove an event's setup, keeping the event row, its admins and its audit trail. */
  private async clearEventSetup(tx: Prisma.TransactionClient, eventId: string) {
    await tx.teamDecision.deleteMany({ where: { eventId } });
    await tx.judgeLink.deleteMany({ where: { eventId } });
    await tx.judgingDay.deleteMany({ where: { eventId } });
    await tx.criterionScore.deleteMany({ where: { scorecard: { eventId } } });
    await tx.scorecard.deleteMany({ where: { eventId } });
    await tx.sessionJudge.deleteMany({ where: { session: { eventId } } });
    await tx.rankingResult.deleteMany({ where: { eventId } });
    await tx.judgingSession.deleteMany({ where: { eventId } });
    await tx.judgeMessage.deleteMany({ where: { eventId } });
    await tx.conflictDeclaration.deleteMany({ where: { eventId } });
    await tx.judgeAvailability.deleteMany({ where: { judge: { eventId } } });
    await tx.judgeExpertise.deleteMany({ where: { judge: { eventId } } });
    await tx.slotJudge.deleteMany({ where: { timeSlot: { eventId } } });
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
      throw new BadRequestException('Upload the file as .xlsx (Excel workbook).');
    }
    return file.buffer;
  }
}
