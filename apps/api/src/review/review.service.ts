import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { zipSync } from 'fflate';
import { buildReportPdf, reportFileName } from './report-pdf';
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

export type Criterion = {
  id: string; name: string; parentId: string | null; minScore: number; maxScore: number; order: number;
  description: string | null;
  /** Rating rubrics: what a 1, 3 and 5 look like. */
  anchors: { score: number; label: string; text: string }[];
};

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
  /** Yes / No to the rubric's support question; null when not answered or not asked. */
  support: boolean | null;
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
  /** Out of ReviewData.scoreMax: the mean total (points) or the mean rating (rating). */
  average: number | null;
  /** Per category (points) or per dimension (rating), averaged over the judges who submitted. */
  categoryAverages: { id: string; name: string; maxScore: number; average: number | null }[];
  /** Answers to the support question from the judges who submitted. */
  support: { yes: number; no: number };
  judges: JudgeCard[];
  decision: {
    status: 'DRAFT' | 'SUBMITTED';
    decision: Decision | null;
    feedback: string | null;
    decidedBy: string | null;
    decidedAt: Date | null;
  } | null;
  /** The stored PDF report for the current decision, once HR has submitted. */
  report: { revision: number; createdAt: Date } | null;
};

export type ReviewData = {
  event: { id: string; name: string; timezone: string };
  criteria: Criterion[];
  /** POINTS: categories of points; RATING: every dimension rated on one scale (e.g. 1-5). */
  scale: 'POINTS' | 'RATING';
  /** What a candidate's average is out of: the rubric total, or the top rating. */
  scoreMax: number;
  supportQuestion: string | null;
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
  private readonly logger = new Logger(ReviewService.name);

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
      id: c.id, name: c.name, parentId: c.parentId, minScore: c.minScore, maxScore: c.maxScore, order: c.displayOrder,
      description: c.description ?? null,
      anchors: Array.isArray(c.scoringAnchors)
        ? (c.scoringAnchors as any[]).filter((a) => typeof a?.score === 'number' && a?.text)
        : [],
    }));
    const rating = template?.scale === 'RATING';
    const supportQuestion = template?.supportQuestion ?? null;
    const parents = new Set(criteria.map((c) => c.parentId).filter(Boolean));
    const leaves = criteria.filter((c) => !parents.has(c.id));
    const categories = criteria.filter((c) => !c.parentId && parents.has(c.id));

    const [sessions, decisions, users, reports] = await Promise.all([
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
      this.prisma.decisionReport.findMany({
        where: { eventId },
        select: { decisionId: true, revision: true, createdAt: true },
      }),
    ]);
    const reportOf = (decisionId: string, revision: number) =>
      reports.find((r) => r.decisionId === decisionId && r.revision === revision) ?? null;
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
            support: card?.support ?? null,
            scores,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      // A judge who stepped out or was taken off doesn't hold the record up,
      // but a score they did submit still counts.
      const expected = judges.filter((j) => !j.excused);
      const scored = judges.filter((j) => j.submitted);
      const totalOf = (j: JudgeCard) => leaves.reduce((sum, l) => sum + (j.scores[l.id]?.score ?? 0), 0);
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      let average: number | null;
      let categoryAverages: CandidateRecord['categoryAverages'];
      if (rating) {
        // Each dimension averaged over the judges; the candidate's score is
        // the mean rating across all of them, out of the top of the scale.
        categoryAverages = leaves.map((l) => {
          const v = mean(scored.map((j) => j.scores[l.id]?.score).filter((x): x is number => typeof x === 'number'));
          return { id: l.id, name: l.name, maxScore: l.maxScore, average: v === null ? null : round1(v) };
        });
        const perJudge = scored.map((j) => mean(leaves.map((l) => j.scores[l.id]?.score ?? 0)) ?? 0);
        const v = mean(perJudge);
        average = v === null ? null : round1(v);
      } else {
        const v = mean(scored.map((j) => j.total ?? totalOf(j)));
        average = v === null ? null : round1(v);
        categoryAverages = categories.map((cat) => {
          const rows = criteria.filter((c) => c.parentId === cat.id);
          const per = mean(scored.map((j) => rows.reduce((sum, r) => sum + (j.scores[r.id]?.score ?? 0), 0)));
          return { id: cat.id, name: cat.name, maxScore: cat.maxScore, average: per === null ? null : round1(per) };
        });
      }

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
        support: {
          yes: scored.filter((j) => j.support === true).length,
          no: scored.filter((j) => j.support === false).length,
        },
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
        report: d && decided ? reportOf(d.id, d.revision) : null,
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

    const maxTotal = categories.length ? categories.reduce((s2, c) => s2 + c.maxScore, 0) : leaves.reduce((s2, c) => s2 + c.maxScore, 0);
    return {
      event: { id: event.id, name: event.name, timezone: tz },
      criteria,
      scale: rating ? 'RATING' : 'POINTS',
      scoreMax: rating ? Math.max(...leaves.map((l) => l.maxScore), 0) : maxTotal,
      supportQuestion,
      maxTotal,
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

    // The report is made now and kept, so the file on record is what was
    // decided. If making it fails the decision still stands; the report is
    // made on first download instead.
    let report = false;
    if (input.submit) {
      try {
        await this.storeReport(eventId, sessionId);
        report = true;
      } catch (e: any) {
        this.logger.error(`Report for ${record.name} (${sessionId}) not made: ${e?.message}`);
      }
    }
    return { status: saved.status, decision, feedback, report };
  }

  /** Make the report PDF for a decided record and keep it with the decision. */
  async storeReport(eventId: string, sessionId: string) {
    const data = await this.load(eventId);
    const record = data.records.find((r) => r.sessionId === sessionId);
    if (!record) throw new NotFoundException('That candidate is not in this event.');
    if (record.decision?.status !== 'SUBMITTED') {
      throw new BadRequestException(`${record.name}'s report is available once HR submits the final decision.`);
    }
    const decision = await this.prisma.teamDecision.findUnique({ where: { teamId: record.teamId } });
    if (!decision) throw new NotFoundException('Decision not found.');
    const existing = await this.prisma.decisionReport.findUnique({
      where: { decisionId_revision: { decisionId: decision.id, revision: decision.revision } },
    });
    if (existing) return existing;
    const pdf = await buildReportPdf(data, record, decision.decidedAt ?? new Date());
    return this.prisma.decisionReport.upsert({
      where: { decisionId_revision: { decisionId: decision.id, revision: decision.revision } },
      create: {
        eventId, decisionId: decision.id, teamId: record.teamId, revision: decision.revision,
        fileName: reportFileName(record), pdf,
      },
      update: {},
    });
  }

  /** The stored report for one candidate (made now if it is missing). */
  async report(eventId: string, sessionId: string): Promise<{ fileName: string; pdf: Buffer }> {
    const r = await this.storeReport(eventId, sessionId);
    return { fileName: r.fileName, pdf: Buffer.from(r.pdf) };
  }

  /**
   * A preview of the report with HR's decision and comments as they stand on
   * screen. Not stored and marked as a draft; works before the panel has all
   * submitted, so HR can see the report taking shape.
   */
  async previewReport(
    eventId: string, sessionId: string,
    input: { decision?: string | null; feedback?: string | null }, userId: string,
  ): Promise<{ fileName: string; pdf: Buffer }> {
    const data = await this.load(eventId);
    const record = data.records.find((r) => r.sessionId === sessionId);
    if (!record) throw new NotFoundException('That candidate is not in this event.');
    if (record.decision?.status === 'SUBMITTED') return this.report(eventId, sessionId);
    const decision = input.decision ? String(input.decision).toUpperCase() : null;
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const draft: CandidateRecord = {
      ...record,
      decision: {
        status: 'DRAFT',
        decision: (DECISIONS as readonly string[]).includes(decision ?? '') ? (decision as Decision) : null,
        feedback: input.feedback?.trim() || null,
        decidedBy: me?.name || me?.email || null,
        decidedAt: null,
      },
    };
    const pdf = await buildReportPdf(data, draft, new Date(), { preview: true });
    return { fileName: reportFileName(record).replace('-assessment.pdf', '-preview.pdf'), pdf };
  }

  /** Every decided candidate's report for one day, in interview order, as a zip. */
  async dayReports(eventId: string, date: string): Promise<{ fileName: string; zip: Buffer; count: number }> {
    const data = await this.load(eventId, date);
    const decided = data.records
      .filter((r) => r.decision?.status === 'SUBMITTED')
      .sort((a, b) => a.start.localeCompare(b.start));
    if (decided.length === 0) throw new BadRequestException('No candidates on this day have a final HR decision yet.');
    const files: Record<string, Uint8Array> = {};
    for (const r of decided) {
      const rep = await this.storeReport(eventId, r.sessionId);
      files[`${r.start.replace(':', '')}-${rep.fileName}`] = new Uint8Array(rep.pdf);
    }
    const base = data.event.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reports';
    return { fileName: `${base}-${date}-reports.zip`, zip: Buffer.from(zipSync(files, { level: 0 })), count: decided.length };
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
