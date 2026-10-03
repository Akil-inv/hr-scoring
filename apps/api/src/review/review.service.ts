import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { eventTimezone, localDate } from '../common/event-time';

/**
 * Reviewing candidates after their interview, and the results that follow.
 *
 * A candidate's record brings together every judge's scores and comments.
 * Once every judge still on the panel has submitted, the HR admin adds
 * feedback and a decision (Selected / Waitlist / Not selected) and submits,
 * which closes the record. Results group candidates by that decision.
 */

export const DECISIONS = ['SELECTED', 'WAITLIST', 'NOT_SELECTED'] as const;
export type Decision = (typeof DECISIONS)[number];
export const DECISION_LABEL: Record<Decision, string> = {
  SELECTED: 'Selected',
  WAITLIST: 'Waitlist',
  NOT_SELECTED: 'Not selected',
};

const SUBMITTED = ['SUBMITTED', 'RESUBMITTED', 'LOCKED'];

export type Criterion = { id: string; name: string; parentId: string | null; maxScore: number; order: number };

export type JudgeCard = {
  judgeId: string;
  name: string;
  /** Not expected to score: stepped out or taken off the panel. */
  excused: boolean;
  status: string;
  submitted: boolean;
  total: number | null;
  submittedAt: Date | null;
  strengths: string | null;
  areasForImprovement: string | null;
  recommendation: string | null;
  scores: Record<string, { score: number | null; comment: string | null }>;
};

export type ReviewState = 'AWAITING' | 'READY' | 'DECIDED';

export type CandidateRecord = {
  sessionId: string;
  teamId: string;
  name: string;
  date: string;
  start: string;
  end: string;
  state: ReviewState;
  expected: number;
  submitted: number;
  average: number | null;
  categoryAverages: { id: string; name: string; maxScore: number; average: number | null }[];
  judges: JudgeCard[];
  decision: {
    status: 'DRAFT' | 'SUBMITTED';
    decision: Decision | null;
    feedback: string | null;
    decidedBy: string | null;
    decidedAt: Date | null;
  } | null;
};

export type ReviewData = {
  event: { id: string; name: string; timezone: string };
  criteria: Criterion[];
  maxTotal: number;
  days: { date: string; candidates: number; decided: number; ready: number }[];
  records: CandidateRecord[];
};

function hhmm(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

@Injectable()
export class ReviewService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Everything needed to review an event's candidates, optionally one day only. */
  async load(eventId: string, date?: string): Promise<ReviewData> {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event || event.deletedAt) throw new NotFoundException('Event not found.');
    const tz = eventTimezone(event);

    const template = await this.prisma.scoringTemplate.findFirst({
      where: { eventId, status: { in: ['ACTIVE', 'LOCKED'] } },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    const criteria: Criterion[] = (template?.criteria ?? []).map((c) => ({
      id: c.id, name: c.name, parentId: c.parentId, maxScore: c.maxScore, order: c.displayOrder,
    }));
    const parents = new Set(criteria.map((c) => c.parentId).filter(Boolean));
    const leaves = criteria.filter((c) => !parents.has(c.id));
    const categories = criteria.filter((c) => !c.parentId && parents.has(c.id));

    const [sessions, decisions, users] = await Promise.all([
      this.prisma.judgingSession.findMany({
        where: { eventId },
        orderBy: { scheduledStart: 'asc' },
        include: {
          team: { select: { id: true, name: true } },
          judges: { include: { judge: { select: { id: true, name: true } } } },
          scorecards: { include: { criterionScores: true } },
        },
      }),
      this.prisma.teamDecision.findMany({ where: { eventId } }),
      this.prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    ]);
    const decisionByTeam = new Map(decisions.map((d) => [d.teamId, d]));
    const userName = new Map(users.map((u) => [u.id, u.name || u.email]));

    const records: CandidateRecord[] = [];
    for (const s of sessions) {
      if (!s.scheduledStart) continue;
      const day = localDate(s.scheduledStart, tz);
      const cardByJudge = new Map(s.scorecards.map((c) => [c.judgeId, c]));
      const judges: JudgeCard[] = s.judges
        .map((sj) => {
          const card = cardByJudge.get(sj.judgeId);
          const scores: JudgeCard['scores'] = {};
          for (const cs of card?.criterionScores ?? []) scores[cs.criterionId] = { score: cs.score, comment: cs.comment };
          return {
            judgeId: sj.judgeId,
            name: sj.judge.name,
            excused: sj.onBreak || !!sj.removedAt,
            status: card?.status ?? 'NOT_STARTED',
            submitted: !!card && SUBMITTED.includes(card.status),
            total: card?.totalScore ?? null,
            submittedAt: card?.submittedAt ?? null,
            strengths: card?.overallStrengths ?? null,
            areasForImprovement: card?.areasForImprovement ?? null,
            recommendation: card?.recommendation ?? null,
            scores,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      // A judge who stepped out or was taken off doesn't hold the record up,
      // but a score they did submit still counts.
      const expected = judges.filter((j) => !j.excused);
      const scored = judges.filter((j) => j.submitted);
      const totalOf = (j: JudgeCard) => leaves.reduce((sum, l) => sum + (j.scores[l.id]?.score ?? 0), 0);
      const average = scored.length ? round1(scored.reduce((s2, j) => s2 + (j.total ?? totalOf(j)), 0) / scored.length) : null;
      const categoryAverages = categories.map((cat) => {
        const rows = criteria.filter((c) => c.parentId === cat.id);
        const per = scored.map((j) => rows.reduce((sum, r) => sum + (j.scores[r.id]?.score ?? 0), 0));
        return { id: cat.id, name: cat.name, maxScore: cat.maxScore, average: per.length ? round1(per.reduce((a, b) => a + b, 0) / per.length) : null };
      });

      const d = decisionByTeam.get(s.team.id);
      const decided = d?.status === 'SUBMITTED';
      const ready = expected.length > 0 && expected.every((j) => j.submitted);
      records.push({
        sessionId: s.id,
        teamId: s.team.id,
        name: s.team.name,
        date: day,
        start: hhmm(s.scheduledStart, tz),
        end: s.scheduledEnd ? hhmm(s.scheduledEnd, tz) : '',
        state: decided ? 'DECIDED' : ready ? 'READY' : 'AWAITING',
        expected: expected.length,
        submitted: expected.filter((j) => j.submitted).length,
        average,
        categoryAverages,
        judges,
        decision: d
          ? {
              status: d.status,
              decision: (d.decision as Decision) ?? null,
              feedback: d.feedback,
              decidedBy: d.decidedById ? userName.get(d.decidedById) ?? null : null,
              decidedAt: d.decidedAt,
            }
          : null,
      });
    }

    const byDay = new Map<string, { candidates: number; decided: number; ready: number }>();
    for (const r of records) {
      const x = byDay.get(r.date) ?? { candidates: 0, decided: 0, ready: 0 };
      x.candidates++;
      if (r.state === 'DECIDED') x.decided++;
      if (r.state === 'READY') x.ready++;
      byDay.set(r.date, x);
    }

    return {
      event: { id: event.id, name: event.name, timezone: tz },
      criteria,
      maxTotal: categories.length ? categories.reduce((s2, c) => s2 + c.maxScore, 0) : leaves.reduce((s2, c) => s2 + c.maxScore, 0),
      days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, x]) => ({ date: d, ...x })),
      records: date ? records.filter((r) => r.date === date) : records,
    };
  }

  /**
   * Save the HR admin's feedback and decision. Without submit it is a draft
   * the admin can come back to. Submitting needs every expected judge's
   * scorecard in, a decision and feedback, and closes the record.
   */
  async decide(
    eventId: string,
    sessionId: string,
    input: { decision?: string | null; feedback?: string | null; submit?: boolean },
    userId: string,
  ) {
    const data = await this.load(eventId);
    const record = data.records.find((r) => r.sessionId === sessionId);
    if (!record) throw new NotFoundException('That candidate is not in this event.');
    if (record.decision?.status === 'SUBMITTED') {
      throw new BadRequestException(`${record.name}'s record is already closed.`);
    }
    const decision = input.decision ? String(input.decision).toUpperCase() : null;
    if (decision && !(DECISIONS as readonly string[]).includes(decision)) {
      throw new BadRequestException('Decision must be Selected, Waitlist or Not selected.');
    }
    const feedback = input.feedback?.trim() || null;

    if (input.submit) {
      if (record.state !== 'READY') {
        throw new BadRequestException(
          `${record.name} can't be decided yet: ${record.submitted} of ${record.expected} judges have submitted.`,
        );
      }
      if (!decision) throw new BadRequestException('Choose Selected, Waitlist or Not selected before submitting.');
      if (!feedback) throw new BadRequestException('Add your feedback before submitting.');
    }

    const saved = await this.prisma.teamDecision.upsert({
      where: { teamId: record.teamId },
      create: {
        eventId, teamId: record.teamId, sessionId, decision: decision as Decision | null, feedback,
        status: input.submit ? 'SUBMITTED' : 'DRAFT',
        decidedById: input.submit ? userId : null,
        decidedAt: input.submit ? new Date() : null,
      },
      update: {
        sessionId, decision: decision as Decision | null, feedback,
        status: input.submit ? 'SUBMITTED' : 'DRAFT',
        decidedById: input.submit ? userId : null,
        decidedAt: input.submit ? new Date() : null,
      },
    });

    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'TeamDecision', entityId: saved.id,
      reason: input.submit ? `Decision submitted for ${record.name}` : `Decision draft saved for ${record.name}`,
      oldValues: record.decision ?? undefined,
      newValues: { decision, feedback, status: saved.status, average: record.average },
    });
    return { status: saved.status, decision, feedback };
  }

  /** REST calls skip the GraphQL scope guard; check event access here. */
  async assertAccess(user: { sub?: string; role?: string } | undefined, eventId: string, roles: string[]) {
    if (!user?.sub) throw new ForbiddenException('Sign in first.');
    if (user.role === 'SUPER_ADMIN') return;
    if (!roles.includes(user.role ?? '')) throw new ForbiddenException('Your role cannot do this.');
    const assignments = await this.prisma.eventUser.count({ where: { userId: user.sub } });
    if (assignments === 0) return;
    const assigned = await this.prisma.eventUser.findUnique({ where: { userId_eventId: { userId: user.sub, eventId } } });
    if (!assigned) throw new ForbiddenException('You are not assigned to this event. Ask a super admin to add you.');
  }
}
