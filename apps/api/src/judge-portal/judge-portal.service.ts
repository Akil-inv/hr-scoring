import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

/**
 * What a judge link opens. Interview events (set up by upload) use one link
 * per judge per day: it shows and scores only that day's interviews, stops
 * working when the day is closed, and can be reissued. Wizard events keep
 * the original one link per judge for the whole event.
 */
export type LinkScope = { kind: 'EVENT' } | { kind: 'DAY'; date: string; dayId: string; linkId: string };

/** A day link's token: random, so it cannot be worked out from the judge. */
export function newDayToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class JudgePortalService {
  constructor(private prisma: PrismaService) {}

  generateToken(judgeId: string): string {
    // The salt is configurable but defaults to the original value, because
    // changing it invalidates every judge link already sent. Set
    // JUDGE_TOKEN_SALT before an event begins, never during one.
    const salt = process.env.JUDGE_TOKEN_SALT || 'hackjudge-salt-2026';
    return crypto.createHash('sha256').update(judgeId + salt).digest('hex').substring(0, 16);
  }

  async getJudgeByToken(token: string, eventId: string) {
    return (await this.resolve(token, eventId)).judge;
  }

  /**
   * Who a link belongs to and what it opens. A day link that has been
   * cancelled says why (the day closed, the event closed, or it was
   * reissued) rather than just "invalid".
   */
  async resolve(token: string, eventId: string) {
    const link = await this.prisma.judgeLink.findUnique({ where: { token }, include: { day: true } });
    if (link && (!eventId || link.eventId === eventId)) {
      if (link.revokedAt) {
        const why = link.revokedReason ?? '';
        throw new GoneException(
          why === 'Day closed'
            ? `Scoring for ${link.day ? isoDate(link.day.date) : 'this day'} is closed. Thank you for judging.`
            : why === 'Event closed'
              ? 'This event is closed. Thank you for judging.'
              : 'This link has been replaced. Ask HR for your new link.',
        );
      }
      const judge = await this.prisma.judge.findFirst({ where: { id: link.judgeId, deletedAt: null } });
      if (!judge) throw new NotFoundException('Invalid judge link');
      this.prisma.judgeLink.update({ where: { id: link.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
      const scope: LinkScope = link.dayId && link.day
        ? { kind: 'DAY', date: isoDate(link.day.date), dayId: link.dayId, linkId: link.id }
        : { kind: 'EVENT' };
      return { judge, scope };
    }
    const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { setupMode: true } });
    if (event?.setupMode === 'UPLOAD') {
      // Interview events use day links only; an old whole-event link must not work.
      throw new NotFoundException('This link is not valid. Ask HR for your link for today.');
    }
    const judges = await this.prisma.judge.findMany({ where: { eventId, deletedAt: null } });
    const judge = judges.find(j => this.generateToken(j.id) === token);
    if (!judge) throw new NotFoundException('Invalid judge link');
    return { judge, scope: { kind: 'EVENT' } as LinkScope };
  }

  /** Whether a session is one this link may see and score. */
  inScope(scope: LinkScope, session: { timeSlot?: { date: Date } | null }): boolean {
    if (scope.kind === 'EVENT') return true;
    return !!session.timeSlot && isoDate(session.timeSlot.date) === scope.date;
  }

  /** Refuse a write to an interview outside the link's day. */
  async assertSessionInScope(scope: LinkScope, sessionId: string) {
    if (scope.kind === 'EVENT') return;
    const session = await this.prisma.judgingSession.findUnique({ where: { id: sessionId }, include: { timeSlot: true } });
    if (!session || !this.inScope(scope, session)) {
      throw new BadRequestException(`This interview is not on your link for ${scope.date}.`);
    }
  }

  // ─── Day links (interview events) ─────────────────────────────────────

  /**
   * Every judge's link for each day they sit a panel, made when missing (a
   * judge added to a day later gets one here). Closed days list their links
   * as closed. Newest active link per judge per day.
   */
  async dayLinks(eventId: string, userId: string | null) {
    const [days, seats, sessions, links] = await Promise.all([
      this.prisma.judgingDay.findMany({ where: { eventId }, orderBy: { date: 'asc' } }),
      this.prisma.slotJudge.findMany({
        where: { timeSlot: { eventId } },
        include: { timeSlot: { select: { date: true } }, judge: true },
      }),
      this.prisma.sessionJudge.findMany({
        where: { session: { eventId, stage: { notIn: ['CANCELLED'] } }, removedAt: null } as any,
        include: { session: { include: { timeSlot: { select: { date: true } } } } },
      }),
      this.prisma.judgeLink.findMany({ where: { eventId, scope: 'DAY' }, orderBy: { createdAt: 'desc' } }),
    ]);
    const dayByDate = new Map(days.map((d) => [isoDate(d.date), d]));
    const judgesByDate = new Map<string, Map<string, any>>();
    for (const s of seats) {
      if (s.judge.deletedAt) continue;
      const d = isoDate(s.timeSlot.date);
      if (!judgesByDate.has(d)) judgesByDate.set(d, new Map());
      judgesByDate.get(d)!.set(s.judgeId, s.judge);
    }
    const interviews = new Map<string, number>();
    for (const sj of sessions) {
      if (!sj.session.timeSlot) continue;
      const k = `${sj.judgeId}|${isoDate(sj.session.timeSlot.date)}`;
      interviews.set(k, (interviews.get(k) ?? 0) + 1);
    }

    const out: any[] = [];
    for (const [date, judges] of [...judgesByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let day = dayByDate.get(date);
      if (!day) {
        day = await this.prisma.judgingDay.create({ data: { eventId, date: new Date(`${date}T00:00:00Z`) } });
      }
      const closed = day.status === 'CLOSED';
      const rows: any[] = [];
      for (const judge of [...judges.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        let link = links.find((l) => l.judgeId === judge.id && l.dayId === day!.id && !l.revokedAt)
          ?? (closed ? links.find((l) => l.judgeId === judge.id && l.dayId === day!.id) : undefined);
        if (!link && !closed) {
          link = await this.prisma.judgeLink.create({
            data: { token: newDayToken(), eventId, judgeId: judge.id, scope: 'DAY', dayId: day.id, createdById: userId },
          });
        }
        rows.push({
          linkId: link?.id ?? null,
          judgeId: judge.id, name: judge.name, email: judge.email, phone: judge.phone ?? null,
          interviews: interviews.get(`${judge.id}|${date}`) ?? 0,
          link: link && !link.revokedAt ? `/judge/${link.token}?event=${eventId}` : null,
          lastUsedAt: link?.lastUsedAt ?? null,
          reissued: links.filter((l) => l.judgeId === judge.id && l.dayId === day!.id && l.revokedReason === 'Reissued').length,
        });
      }
      out.push({ date, closed, closedAt: day.closedAt, links: rows });
    }
    return { days: out };
  }

  /** Cancel a day link and issue a new one for the same judge and day. */
  async reissue(eventId: string, linkId: string, userId: string) {
    const link = await this.prisma.judgeLink.findFirst({ where: { id: linkId, eventId }, include: { day: true, judge: { select: { name: true } } } as any });
    if (!link) throw new NotFoundException('Link not found.');
    if ((link as any).day?.status === 'CLOSED') throw new BadRequestException('That day is closed, so its links cannot be reissued.');
    if (link.revokedAt) throw new BadRequestException('That link was already cancelled. Refresh the page to see the current one.');
    const now = new Date();
    const fresh = await this.prisma.$transaction(async (tx) => {
      await tx.judgeLink.update({ where: { id: link.id }, data: { revokedAt: now, revokedReason: 'Reissued' } });
      return tx.judgeLink.create({
        data: { token: newDayToken(), eventId, judgeId: link.judgeId, scope: link.scope, dayId: link.dayId, sessionId: link.sessionId, createdById: userId },
      });
    });
    await this.prisma.auditLog.create({
      data: {
        userId, eventId, action: AuditAction.UPDATE, entityType: 'JudgeLink', entityId: fresh.id,
        reason: `Link reissued for ${(link as any).judge?.name ?? 'judge'} (${(link as any).day ? isoDate((link as any).day.date) : ''})`,
      },
    }).catch(() => undefined);
    return { linkId: fresh.id, link: `/judge/${fresh.token}?event=${eventId}` };
  }

  async getJudgeSchedule(token: string, eventId: string) {
    const { judge, scope } = await this.resolve(token, eventId);
    const sessions = await this.prisma.sessionJudge.findMany({
      where: { judgeId: judge.id, session: { eventId, stage: { notIn: ['CANCELLED'] } } },
      include: {
        session: {
          include: {
            team: { include: { track: true } },
            room: true, timeSlot: true,
            judges: { include: { judge: true } },
            scorecards: { where: { judgeId: judge.id } },
          },
        },
      },
      orderBy: { session: { scheduledStart: 'asc' } },
    });
    const visible = sessions.filter((sj) => this.inScope(scope, sj.session));

    return {
      /** The day this link opens, for day links. */
      linkDate: scope.kind === 'DAY' ? scope.date : null,
      // Tier decides whether the break control appears at all. Without it the
      // portal cannot tell an MD from an ED.
      judge: { id: judge.id, name: judge.name, email: judge.email, judgeType: judge.judgeType, judgeTier: (judge as any).judgeTier, organisation: judge.organisation },
      message: await this.prisma.judgeMessage
        .findFirst({
          where: { judgeId: judge.id, dismissedAt: null },
          orderBy: { sentAt: 'desc' },
          select: { id: true, body: true, sentByName: true, sentAt: true },
        })
        .catch(() => null),
      sessions: visible.map(sj => {
        const s = sj.session;
        const sc = s.scorecards?.[0];
        return {
          sessionId: s.id, scorecardId: sc?.id || null,
          onBreak: (sj as any).onBreak ?? false,
          scorecardStatus: sc?.status || 'NO_SCORECARD', totalScore: sc?.totalScore || null,
          team: { name: s.team.name, projectName: s.team.projectName, track: s.team.track?.name || null,
            country: s.team.country || null,
            // Colour only — the portal tints the card for visual grouping but
            // never labels the platform. A judge does not need to know which
            // vendor is in the room, and saying so would suggest this session
            // is somehow different from the others.
            platform: (s.team as any).platform || null,
            organisation: s.team.organisation || null, department: (s.team as any).department || null,
            vendorTools: (s.team as any).vendorTools || null, techStack: s.team.techStack || null,
            useCaseTitle: s.team.useCaseTitle || null,
            problemStatement: s.team.problemStatement || null,
            solutionSummary: s.team.solutionSummary || null },
          room: s.room.name, date: s.timeSlot.date, startTime: s.timeSlot.startTime, endTime: s.timeSlot.endTime, stage: s.stage,
          fellowJudges: s.judges.filter((j: any) => j.judgeId !== judge.id).map((j: any) => ({ name: j.judge.name, type: j.judge.judgeType })),
        };
      }),
    };
  }

  async generateAllLinks(eventId: string) {
    const judges = await this.prisma.judge.findMany({
      where: { eventId, deletedAt: null, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });

    // Counted per judge so a coordinator can see, before sending anything,
    // which links would open an empty page.
    const counts = await this.prisma.sessionJudge.groupBy({
      by: ['judgeId'],
      where: { session: { eventId, stage: { notIn: ['CANCELLED'] } } },
      _count: { judgeId: true },
    });
    const byJudge = new Map(counts.map(c => [c.judgeId, c._count.judgeId]));

    return judges
      .map(j => ({
        judgeId: j.id,
        name: j.name,
        email: j.email,
        phone: j.phone || null,
        token: this.generateToken(j.id),
        link: `/judge/${this.generateToken(j.id)}?event=${eventId}`,
        sessionCount: byJudge.get(j.id) ?? 0,
      }))
      // Busiest first, nothing-to-do last. Alphabetical order tells a
      // coordinator nothing; workload tells them where to look.
      .sort((a, b) => b.sessionCount - a.sessionCount || a.name.localeCompare(b.name));
  }
}
