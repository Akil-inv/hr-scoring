import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { halfDayWindow, eventTimezone } from '../common/event-time';
import { CreateJudgeInput, UpdateJudgeInput, SetJudgeAvailabilityInput, SetJudgeExpertiseInput } from './judges.types';

@Injectable()
export class JudgesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private enrichJudge(judge: any) {
    return {
      ...judge,
      availabilityCount: judge._count?.availability ?? judge.availability?.length ?? 0,
      conflictCount: judge._count?.conflicts ?? judge.conflicts?.length ?? 0,
      expertise: judge.expertise?.map((e: any) => ({
        ...e,
        trackName: e.track?.name || null,
      })) || [],
    };
  }

  async create(input: CreateJudgeInput, userId: string) {
    const existing = await this.prisma.judge.findUnique({
      where: { eventId_email: { eventId: input.eventId, email: input.email } },
    });
    if (existing) throw new ConflictException(`Judge with email "${input.email}" already exists`);

    const judge = await this.prisma.judge.create({
      data: input as any,
      include: {
        availability: true,
        expertise: { include: { track: true } },
        _count: { select: { availability: true, conflicts: true } },
      },
    });

    await this.audit.log({
      userId, eventId: input.eventId,
      action: AuditAction.CREATE, entityType: 'Judge',
      entityId: judge.id, newValues: { name: judge.name, email: judge.email },
    });

    return this.enrichJudge(judge);
  }

  async update(id: string, input: UpdateJudgeInput, userId: string) {
    const existing = await this.prisma.judge.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Judge not found');

    const updated = await this.prisma.judge.update({
      where: { id }, data: input as any,
      include: {
        availability: true,
        expertise: { include: { track: true } },
        _count: { select: { availability: true, conflicts: true } },
      },
    });

    await this.audit.log({
      userId, eventId: existing.eventId,
      action: AuditAction.UPDATE, entityType: 'Judge',
      entityId: id, oldValues: existing, newValues: updated,
    });

    return this.enrichJudge(updated);
  }

  async findAllByEvent(eventId: string, judgeType?: string, status?: string) {
    const where: any = { eventId, deletedAt: null };
    if (judgeType) where.judgeType = judgeType;
    if (status) where.status = status;

    const judges = await this.prisma.judge.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        availability: true,
        expertise: { include: { track: true } },
        _count: { select: { availability: true, conflicts: true } },
      },
    });

    return judges.map(j => this.enrichJudge(j));
  }

  async findOne(id: string) {
    const judge = await this.prisma.judge.findUnique({
      where: { id },
      include: {
        availability: true,
        expertise: { include: { track: true } },
        _count: { select: { availability: true, conflicts: true } },
      },
    });
    if (!judge) throw new NotFoundException('Judge not found');
    return this.enrichJudge(judge);
  }

  async setAvailability(input: SetJudgeAvailabilityInput, userId: string) {
    const judge = await this.prisma.judge.findUnique({ where: { id: input.judgeId } });
    if (!judge) throw new NotFoundException('Judge not found');

    const dateStr = new Date(input.date).toISOString().split('T')[0];
    const parseTime = (timeStr: string): Date => {
      const [h, m] = timeStr.split(':').map(Number);
      const d = new Date(dateStr + 'T00:00:00.000Z');
      d.setUTCHours(h, m, 0, 0);
      return d;
    };

    // Delete existing availability for this judge on this date
    await this.prisma.judgeAvailability.deleteMany({
      where: { judgeId: input.judgeId, date: new Date(dateStr) },
    });

    const avail = await this.prisma.judgeAvailability.create({
      data: {
        judgeId: input.judgeId,
        date: new Date(dateStr),
        startTime: parseTime(input.startTime),
        endTime: parseTime(input.endTime),
      },
    });

    await this.audit.log({
      userId, eventId: judge.eventId,
      action: AuditAction.UPDATE, entityType: 'JudgeAvailability',
      entityId: input.judgeId,
      newValues: { date: dateStr, startTime: input.startTime, endTime: input.endTime },
    });

    return avail;
  }

  async setExpertise(input: SetJudgeExpertiseInput, userId: string) {
    const judge = await this.prisma.judge.findUnique({ where: { id: input.judgeId } });
    if (!judge) throw new NotFoundException('Judge not found');

    const expertise = await this.prisma.judgeExpertise.upsert({
      where: { judgeId_trackId: { judgeId: input.judgeId, trackId: input.trackId } },
      create: {
        judgeId: input.judgeId,
        trackId: input.trackId,
        expertiseLevel: input.expertiseLevel,
      },
      update: { expertiseLevel: input.expertiseLevel },
      include: { track: true },
    });

    return { ...expertise, trackName: expertise.track?.name || null };
  }

  async importFromCsv(eventId: string, rows: any[], userId: string) {
    const errors: Array<{ row: number; field: string; message: string }> = [];
    let imported = 0;

    const validTypes = ['TECHNICAL', 'BUSINESS', 'DOMAIN', 'INNOVATION', 'EXECUTIVE'];

    const existingJudges = await this.prisma.judge.findMany({
      where: { eventId, deletedAt: null },
      select: { email: true },
    });
    const existingEmails = new Set(existingJudges.map(j => j.email.toLowerCase()));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      if (!row.name?.trim()) { errors.push({ row: rowNum, field: 'name', message: 'Required' }); continue; }
      if (!row.email?.trim()) { errors.push({ row: rowNum, field: 'email', message: 'Required' }); continue; }

      const judgeType = (row.judge_type || 'TECHNICAL').trim().toUpperCase();
      if (!validTypes.includes(judgeType)) {
        errors.push({ row: rowNum, field: 'judge_type', message: `Invalid type "${row.judge_type}". Valid: ${validTypes.join(', ')}` });
        continue;
      }

      const email = row.email.trim().toLowerCase();
      if (existingEmails.has(email)) {
        errors.push({ row: rowNum, field: 'email', message: `"${email}" already exists` });
        continue;
      }

      try {
        await this.prisma.judge.create({
          data: {
            eventId,
            name: row.name.trim(),
            email,
            organisation: row.organisation?.trim() || null,
            designation: row.designation?.trim() || null,
            judgeType: judgeType as any,
            maxSessions: parseInt(row.max_sessions) || 10,
            judgeTier: (row.judge_tier || "L1").trim().toUpperCase() as any,
            phone: row.phone?.trim() || null,
            isStandby: ['true', 'yes', '1', 'y'].includes(
              (row.standby || '').trim().toLowerCase(),
            ),
          },
        });
        existingEmails.add(email);
        imported++;
      } catch (e: any) {
        errors.push({ row: rowNum, field: 'general', message: e.message?.substring(0, 100) || 'Unknown error' });
      }
    }

    await this.audit.log({
      userId, eventId,
      action: AuditAction.CREATE, entityType: 'Judge',
      entityId: 'import-batch',
      newValues: { imported, skipped: errors.length, totalRows: rows.length },
    });

    return { imported, skipped: errors.length, errors };
  }
  /**
   * Import the availability matrix.
   *
   * One row per judge per day. A judge absent from the file for a given day is
   * not available that day — the file is the whole truth, which is why it is
   * required rather than optional.
   *
   * Existing availability for the event is cleared first. A re-import is a
   * correction, not an addition, and merging would leave a withdrawn morning
   * still recorded.
   */
  async importAvailability(eventId: string, rows: any[], userId: string) {
    const errors: Array<{ row: number; field: string; message: string }> = [];
    let imported = 0;

    const judges = await this.prisma.judge.findMany({
      where: { eventId, deletedAt: null },
      select: { id: true, email: true, name: true },
    });
    const byEmail = new Map(judges.map(j => [j.email.toLowerCase(), j]));

    // Half-day windows in the event's timezone, not the server's and not UTC.
    //
    // The previous version stored AM as 00:00-12:00 UTC. For a Singapore event
    // that is 08:00-20:00 local, so every morning slot matched — and PM, stored
    // as 13:00-23:59 UTC, was 21:00-07:59 local and matched nothing at all. A
    // judge who said they were free in the afternoon was silently unschedulable.
    const eventRecord = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { timezone: true },
    });
    const tz = eventTimezone(eventRecord);

    // A re-import replaces rather than merges.
    await this.prisma.judgeAvailability.deleteMany({
      where: { judge: { eventId } },
    });

    const seen = new Set<string>();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const email = row.email?.trim().toLowerCase();
      if (!email) { errors.push({ row: rowNum, field: 'email', message: 'Required' }); continue; }

      const judge = byEmail.get(email);
      if (!judge) {
        errors.push({ row: rowNum, field: 'email', message: `No judge with email "${email}" on this event` });
        continue;
      }

      const dateStr = row.date?.trim();
      if (!dateStr) { errors.push({ row: rowNum, field: 'date', message: 'Required, e.g. 2026-08-28' }); continue; }

      const date = new Date(`${dateStr}T00:00:00Z`);
      if (isNaN(date.getTime())) {
        errors.push({ row: rowNum, field: 'date', message: `"${dateStr}" is not a date. Use YYYY-MM-DD.` });
        continue;
      }

      const session = (row.session || 'BOTH').trim().toUpperCase();
      if (!['AM', 'PM', 'BOTH'].includes(session)) {
        errors.push({ row: rowNum, field: 'session', message: `"${row.session}" is not AM, PM or BOTH` });
        continue;
      }

      const key = `${judge.id}|${dateStr}`;
      if (seen.has(key)) {
        errors.push({ row: rowNum, field: 'date', message: `${judge.name} already has a row for ${dateStr}` });
        continue;
      }
      seen.add(key);

      try {
        const window = halfDayWindow(dateStr, session as 'AM' | 'PM' | 'BOTH', tz);
        await this.prisma.judgeAvailability.create({
          data: {
            judgeId: judge.id,
            date,
            startTime: window.start,
            endTime: window.end,
          },
        });
        imported++;
      } catch (e: any) {
        errors.push({ row: rowNum, field: 'general', message: e.message?.substring(0, 100) || 'Unknown error' });
      }
    }

    // Judges with nothing recorded cannot be scheduled, so say so plainly here
    // rather than leaving it to be discovered when the solver ignores them.
    const withAvailability = new Set([...seen].map(k => k.split('|')[0]));
    const missing = judges.filter(j => !withAvailability.has(j.id));

    await this.audit.log({
      userId, eventId,
      action: AuditAction.UPDATE, entityType: 'JudgeAvailability',
      entityId: 'import-batch',
      newValues: { imported, skipped: errors.length, judgesWithNoAvailability: missing.length },
    });

    return {
      imported,
      skipped: errors.length,
      errors,
      judgesWithNoAvailability: missing.map(j => j.name),
    };
  }

  /**
   * Delete a judge, taking their metadata with them.
   *
   * Availability, expertise and conflicts cascade — they describe a judge and
   * mean nothing without one. Session assignments are removed here rather than
   * by cascade, so that removing somebody from a schedule is a visible step
   * rather than a side effect of a foreign key.
   *
   * A submitted score is not deleted and not deletable. The team presented, the
   * judge formed a judgement, and it counted. Clearing a list to re-import a
   * corrected spreadsheet must not quietly take scores with it.
   */
  async deleteJudge(id: string, userId: string) {
    const judge = await this.prisma.judge.findUniqueOrThrow({ where: { id } });

    const submitted = await this.prisma.scorecard.count({
      where: {
        judgeId: id,
        status: { in: ['SUBMITTED', 'RESUBMITTED', 'LOCKED'] },
      },
    });

    if (submitted > 0) {
      throw new BadRequestException(
        `${judge.name} has submitted ${submitted} scorecard(s). Deleting them ` +
        'would remove scores that have already counted. Reopen and withdraw those ' +
        'first if this judge should not have scored.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Unstarted and draft scorecards go — neither is a judgement of anything.
      const cards = await tx.scorecard.findMany({
        where: { judgeId: id },
        select: { id: true },
      });
      if (cards.length > 0) {
        await tx.criterionScore.deleteMany({
          where: { scorecardId: { in: cards.map(c => c.id) } },
        });
        await tx.scorecard.deleteMany({ where: { judgeId: id } });
      }

      // A session pointing at a deleted judge is broken in a way nobody notices
      // until the day.
      await tx.sessionJudge.deleteMany({ where: { judgeId: id } });
      await tx.conflictDeclaration.deleteMany({ where: { judgeId: id } });
      await tx.judgeMessage.deleteMany({ where: { judgeId: id } });

      await tx.judge.delete({ where: { id } });
    });
    await this.audit.log({ userId, eventId: judge.eventId, action: 'DELETE' as any, entityType: 'Judge', entityId: id, oldValues: { name: judge.name }, reason: 'Judge deleted' });
    return judge;
  }

}
