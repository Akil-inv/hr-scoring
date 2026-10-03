import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

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
    const judges = await this.prisma.judge.findMany({ where: { eventId, deletedAt: null } });
    const judge = judges.find(j => this.generateToken(j.id) === token);
    if (!judge) throw new NotFoundException('Invalid judge link');
    return judge;
  }

  async getJudgeSchedule(token: string, eventId: string) {
    const judge = await this.getJudgeByToken(token, eventId);
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

    return {
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
      sessions: sessions.map(sj => {
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
