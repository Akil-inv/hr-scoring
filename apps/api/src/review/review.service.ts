import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { zipSync } from 'fflate';
import { buildReportPdf, reportFileName } from './report-pdf';
import { supersedeDecision } from './decision-reopen';
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

export const DECISIONS = ['SELECTED', 'WAITLIST', 'NOT_SELECTED', 'DID_NOT_ATTEND'] as const;
export type Decision = (typeof DECISIONS)[number];
export const DECISION_LABEL: Record<Decision, string> = {
  SELECTED: 'Selected',
  WAITLIST: 'Waitlist',
  NOT_SELECTED: 'Not selected',
  DID_NOT_ATTEND: 'Did not attend',
};
/** No scores and no report: the candidate did not turn up. */
export const ABSENT: Decision = 'DID_NOT_ATTEND';

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
  /** Every stored report, newest first; earlier revisions are superseded. */
  reports: { revision: number; createdAt: Date; supersededAt: Date | null; supersededReason: string | null }[];
  /** The decision's revision: 2 after one reopening, and so on. */
  revision: number;
  /** Set when a scoring was reopened after HR had decided. */
  reopened: { at: Date; by: string | null; reason: string | null } | null;
  /** The interview's day has been closed. */
  dayClosed: boolean;
};

export type ReviewData = {
  event: {
    id: string; name: string; timezone: string;
    /** Closed events are final and read-only. */
    closed: boolean; closedAt: Date | null; closedBy: string | null;
  };
  criteria: Criterion[];
  /** POINTS: categories of points; RATING: every dimension rated on one scale (e.g. 1-5). */
  scale: 'POINTS' | 'RATING';
  /** What a candidate's average is out of: the rubric total, or the top rating. */
  scoreMax: number;
  supportQuestion: string | null;
  maxTotal: number;
  days: {
    date: string; candidates: number; decided: number; ready: number;
    /** Interviews not yet Completed or Cancelled in the Command Center; closing the day finishes them. */
    openInterviews: number;
    closed: boolean; closedAt: Date | null; closedBy: string | null;
  }[];
  records: CandidateRecord[];
};

/** Command Center stages that mean the interview is over. */
const FINISHED_STAGES = ['COMPLETED', 'CANCELLED'];

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

    const [sessions, decisions, users, reports, dayRows] = await Promise.all([
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
        select: { decisionId: true, revision: true, createdAt: true, supersededAt: true, supersededReason: true },
        orderBy: { revision: 'desc' },
      }),
      this.prisma.judgingDay.findMany({ where: { eventId } }),
    ]);
    const reportOf = (decisionId: string, revision: number) =>
      reports.find((r) => r.decisionId === decisionId && r.revision === revision && !r.supersededAt) ?? null;
    const dayRow = new Map(dayRows.map((d) => [d.date.toISOString().slice(0, 10), d]));
    const dayClosed = (date: string) => dayRow.get(date)?.status === 'CLOSED';
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
        reports: d
          ? reports.filter((x) => x.decisionId === d.id).map((x) => ({
              revision: x.revision, createdAt: x.createdAt, supersededAt: x.supersededAt, supersededReason: x.supersededReason,
            }))
          : [],
        revision: d?.revision ?? 1,
        reopened: d?.reopenedAt
          ? { at: d.reopenedAt, by: d.reopenedById ? userName.get(d.reopenedById) ?? null : null, reason: d.reopenReason }
          : null,
        dayClosed: dayClosed(day),
      });
    }

    const byDay = new Map<string, { candidates: number; decided: number; ready: number; openInterviews: number }>();
    const stageOf = new Map(sessions.map((x) => [x.id, x.stage]));
    // Days closed or with candidates are listed.
    for (const r of records) {
      const x = byDay.get(r.date) ?? { candidates: 0, decided: 0, ready: 0, openInterviews: 0 };
      x.candidates++;
      if (!FINISHED_STAGES.includes(stageOf.get(r.sessionId) as string)) x.openInterviews++;
      if (r.state === 'DECIDED') x.decided++;
      if (r.state === 'READY') x.ready++;
      byDay.set(r.date, x);
    }

    const maxTotal = categories.length ? categories.reduce((s2, c) => s2 + c.maxScore, 0) : leaves.reduce((s2, c) => s2 + c.maxScore, 0);
    return {
      event: {
        id: event.id, name: event.name, timezone: tz,
        closed: event.status === 'COMPLETED' || event.status === 'ARCHIVED',
        closedAt: event.closedAt ?? null,
        closedBy: event.closedById ? userName.get(event.closedById) ?? null : null,
      },
      criteria,
      scale: rating ? 'RATING' : 'POINTS',
      scoreMax: rating ? Math.max(...leaves.map((l) => l.maxScore), 0) : maxTotal,
      supportQuestion,
      maxTotal,
      days: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, x]) => {
        const row = dayRow.get(d);
        return {
          date: d, ...x,
          closed: row?.status === 'CLOSED',
          closedAt: row?.closedAt ?? null,
          closedBy: row?.closedById ? userName.get(row.closedById) ?? null : null,
        };
      }),
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
    if (data.event.closed) throw new BadRequestException('This event is closed. Its records can no longer be changed.');
    const record = data.records.find((r) => r.sessionId === sessionId);
    if (!record) throw new NotFoundException('That candidate is not in this event.');
    if (record.decision?.status === 'SUBMITTED') {
      throw new BadRequestException(`${record.name}'s record is already closed.`);
    }
    const decision = input.decision ? String(input.decision).toUpperCase() : null;
    if (decision && !(DECISIONS as readonly string[]).includes(decision)) {
      throw new BadRequestException('Decision must be Selected, Waitlist, Not selected or Did not attend.');
    }
    const feedback = input.feedback?.trim() || null;
    const absent = decision === ABSENT;

    if (input.submit && !absent) {
      if (record.state !== 'READY') {
        throw new BadRequestException(
          `${record.name} can't be decided yet: ${record.submitted} of ${record.expected} judges have submitted.`,
        );
      }
      if (!decision) throw new BadRequestException('Choose Selected, Waitlist or Not selected before submitting.');
      if (!feedback) throw new BadRequestException('Add your feedback before submitting.');
    }
    if (input.submit && absent && record.judges.some((j) => j.submitted)) {
      throw new BadRequestException(`${record.name} has scores from the panel, so they attended. Choose another decision.`);
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
    // Re-decided on a closed day: the scorecards go back to locked.
    if (input.submit && record.dayClosed) {
      await this.prisma.scorecard.updateMany({
        where: { sessionId, status: { in: ['SUBMITTED', 'RESUBMITTED'] } },
        data: { status: 'LOCKED', lockedAt: new Date() },
      });
    }

    let report = false;
    if (input.submit && !absent) {
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
    if (record.decision.decision === ABSENT) {
      throw new BadRequestException(`${record.name} did not attend, so there is no assessment report.`);
    }
    const decision = await this.prisma.teamDecision.findUnique({ where: { teamId: record.teamId } });
    if (!decision) throw new NotFoundException('Decision not found.');
    const existing = await this.prisma.decisionReport.findUnique({
      where: { decisionId_revision: { decisionId: decision.id, revision: decision.revision } },
    });
    if (existing) return existing;
    const earlier = record.reports.find((x) => x.revision === decision.revision - 1) ?? null;
    const pdf = await buildReportPdf(data, record, decision.decidedAt ?? new Date(), {
      revision: decision.revision,
      replaces: earlier ? { revision: earlier.revision, createdAt: earlier.createdAt } : null,
    });
    return this.prisma.decisionReport.upsert({
      where: { decisionId_revision: { decisionId: decision.id, revision: decision.revision } },
      create: {
        eventId, decisionId: decision.id, teamId: record.teamId, revision: decision.revision,
        fileName: reportFileName(record, decision.revision), pdf,
      },
      update: {},
    });
  }

  /** The stored report for one candidate (made now if it is missing). */
  async report(eventId: string, sessionId: string, revision?: number): Promise<{ fileName: string; pdf: Buffer }> {
    if (revision) {
      const session = await this.prisma.judgingSession.findFirst({ where: { id: sessionId, eventId }, select: { teamId: true } });
      const d = session && (await this.prisma.teamDecision.findUnique({ where: { teamId: session.teamId } }));
      const r = d && (await this.prisma.decisionReport.findUnique({ where: { decisionId_revision: { decisionId: d.id, revision } } }));
      if (!r) throw new NotFoundException(`There is no revision ${revision} of this report.`);
      return { fileName: r.fileName, pdf: Buffer.from(r.pdf) };
    }
    const r = await this.storeReport(eventId, sessionId);
    return { fileName: r.fileName, pdf: Buffer.from(r.pdf) };
  }

  /**
   * Before HR decides: reopen the chosen judges' scorecards so they can
   * correct them. After HR decides, the judges' scores are final: only HR's
   * decision reopens (revise), going back to a draft at the next revision,
   * with the stored report kept and marked superseded. Never on a closed
   * event.
   */
  async reopen(
    eventId: string, sessionId: string,
    input: { reason?: string | null; judgeIds?: string[] | null }, userId: string,
  ) {
    const data = await this.load(eventId);
    if (data.event.closed) throw new BadRequestException('This event is closed. Its records can no longer be changed.');
    const record = data.records.find((r) => r.sessionId === sessionId);
    if (!record) throw new NotFoundException('That candidate is not in this event.');
    const reason = input.reason?.trim();
    if (!reason) throw new BadRequestException('Give a reason for reopening. It is kept on the record.');

    const wanted = new Set(input.judgeIds ?? []);
    if (record.decision?.status === 'SUBMITTED' && wanted.size > 0) {
      throw new BadRequestException(
        "HR has made the final decision, so the judges' scores are final. You can revise the decision and comments instead.",
      );
    }
    const unknown = [...wanted].filter((id) => !record.judges.some((j) => j.judgeId === id));
    if (unknown.length) throw new BadRequestException('Some of the chosen judges are not on this panel.');
    const cards = await this.prisma.scorecard.findMany({
      where: { sessionId, judgeId: { in: [...wanted] }, status: { in: ['SUBMITTED', 'RESUBMITTED', 'LOCKED'] } },
      include: { judge: { select: { name: true } } },
    });
    const decided = record.decision?.status === 'SUBMITTED';
    if (cards.length === 0 && !decided) {
      throw new BadRequestException(
        wanted.size ? 'None of the chosen judges has submitted, so there is nothing to reopen.' : 'Choose the judges whose scoring to reopen.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      if (cards.length) {
        await tx.scorecard.updateMany({
          where: { id: { in: cards.map((c) => c.id) } },
          data: { status: 'REOPENED', reopenReason: reason, lockedAt: null },
        });
      }
      if (decided) await supersedeDecision(tx, record.teamId, reason, userId);
    });

    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'TeamDecision', entityId: record.teamId,
      reason: `Reopened ${record.name}: ${reason}`,
      oldValues: { decision: record.decision?.decision ?? null, status: record.decision?.status ?? null, revision: record.revision },
      newValues: { reopenedJudges: cards.map((c) => c.judge.name), decisionReopened: decided },
    });
    return { reopenedJudges: cards.map((c) => c.judge.name), decisionReopened: decided };
  }

  /**
   * Close a day: every candidate must be decided (or marked as not
   * attending). Their reports are made, the day's scorecards are locked and
   * its judge links stop working. A closed day is not reopened; a single
   * interview on it can be (see reopen).
   */
  async closeDay(eventId: string, date: string, userId: string) {
    const data = await this.load(eventId, date);
    if (data.event.closed) throw new BadRequestException('This event is closed.');
    const day = data.days.find((d) => d.date === date);
    if (!day) throw new NotFoundException('There are no candidates on that day.');
    if (day.closed) throw new BadRequestException('That day is already closed.');
    const open = data.records.filter((r) => r.state !== 'DECIDED');
    if (open.length) {
      const names = open.slice(0, 5).map((r) => r.name).join(', ') + (open.length > 5 ? ` and ${open.length - 5} more` : '');
      throw new BadRequestException(
        `${open.length} candidate${open.length === 1 ? ' still needs' : 's still need'} a final decision: ${names}. ` +
        'Decide each one, or mark them Did not attend, before closing the day.',
      );
    }
    for (const r of data.records) {
      if (r.decision?.decision !== ABSENT) await this.storeReport(eventId, r.sessionId);
    }
    const now = new Date();
    const sessionIds = data.records.map((r) => r.sessionId);
    const absent = data.records.filter((r) => r.decision?.decision === ABSENT).map((r) => r.sessionId);
    const attended = sessionIds.filter((id) => !absent.includes(id));
    let completed = 0;
    let cancelled = 0;
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.judgingDay.upsert({
        where: { eventId_date: { eventId, date: new Date(`${date}T00:00:00Z`) } },
        create: { eventId, date: new Date(`${date}T00:00:00Z`), status: 'CLOSED', closedAt: now, closedById: userId },
        update: { status: 'CLOSED', closedAt: now, closedById: userId },
      });
      await tx.scorecard.updateMany({
        where: { sessionId: { in: sessionIds }, status: { in: ['SUBMITTED', 'RESUBMITTED'] } },
        data: { status: 'LOCKED', lockedAt: now },
      });
      await tx.judgeLink.updateMany({
        where: { dayId: row.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'Day closed' },
      });
      // Every candidate has a final decision, so the interviews are over: the
      // Command Center shows them Completed (Did not attend: Cancelled).
      const unfinished = { stage: { notIn: FINISHED_STAGES as any } };
      completed = (await tx.judgingSession.updateMany({
        where: { id: { in: attended }, ...unfinished },
        data: { stage: 'COMPLETED', actualEnd: now },
      })).count;
      cancelled = (await tx.judgingSession.updateMany({
        where: { id: { in: absent }, ...unfinished },
        data: { stage: 'CANCELLED' },
      })).count;
    });
    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'JudgingDay', entityId: date,
      reason: `Day ${date} closed`, newValues: { candidates: data.records.length, interviewsCompleted: completed, interviewsCancelled: cancelled },
    });
    return { date, closedAt: now, candidates: data.records.length, interviewsCompleted: completed, interviewsCancelled: cancelled };
  }

  /** Close the event once every day is closed. Final: everything becomes read-only. */
  async closeEvent(eventId: string, userId: string) {
    const data = await this.load(eventId);
    if (data.event.closed) throw new BadRequestException('This event is already closed.');
    const open = data.days.filter((d) => !d.closed);
    if (open.length) {
      throw new BadRequestException(
        `${open.length} day${open.length === 1 ? ' is' : 's are'} still open: ${open.map((d) => d.date).join(', ')}. Close every day first.`,
      );
    }
    if (data.days.length === 0) throw new BadRequestException('This event has no candidates yet.');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.event.update({ where: { id: eventId }, data: { status: 'COMPLETED', closedAt: now, closedById: userId } }),
      this.prisma.judgeLink.updateMany({ where: { eventId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'Event closed' } }),
    ]);
    await this.audit.log({
      userId, eventId, action: AuditAction.UPDATE, entityType: 'Event', entityId: eventId,
      reason: 'Event closed', newValues: { days: data.days.length, candidates: data.records.length },
    });
    return { closedAt: now };
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
  async dayReports(
    eventId: string, date: string,
    // Required: no caller may get the day's reports unlocked by leaving it out.
    lock: (files: { name: string; pdf: Buffer }[]) => Promise<{ name: string; pdf: Buffer }[]>,
  ): Promise<{ fileName: string; zip: Buffer; count: number }> {
    const data = await this.load(eventId, date);
    const decided = data.records
      .filter((r) => r.decision?.status === 'SUBMITTED' && r.decision.decision !== ABSENT)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (decided.length === 0) throw new BadRequestException('No candidates on this day have a final HR decision yet.');
    const list: { name: string; pdf: Buffer }[] = [];
    for (const r of decided) {
      const rep = await this.storeReport(eventId, r.sessionId);
      list.push({ name: `${r.start.replace(':', '')}-${rep.fileName}`, pdf: rep.pdf });
    }
    // Each PDF is locked (with the downloader's document password) before zipping.
    const files: Record<string, Uint8Array> = {};
    for (const f of await lock(list)) files[f.name] = new Uint8Array(f.pdf);
    const base = data.event.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'reports';
    return { fileName: `${base}-${date}-reports.zip`, zip: Buffer.from(zipSync(files, { level: 0 })), count: decided.length };
  }

}
