import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, ScorecardStatus } from '@prisma/client';

/**
 * The single scoring implementation.
 *
 * Scoring used to exist twice — once in judge-portal.controller.ts for judges
 * and once in scorecards.service.ts for coordinators — and the two had drifted
 * on every axis that matters: the portal totalled from the request payload
 * rather than from storage, had no range check, faked the conflict
 * confirmation, and logged nothing. The path judges actually used was the
 * weaker of the two.
 *
 * Both now call this. Divergence is impossible rather than merely discouraged.
 *
 * Rule ids in comments refer to docs/JUDGING-SPEC.md.
 */

/** Longest a per-criterion comment may be. Generous for a sentence or two of
 *  justification; short enough that nothing unbounded reaches the database. */
const MAX_COMMENT = 2000;
/** Longest each of the three free-text summary fields may be. */
const MAX_SUMMARY = 5000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IncomingScore {
  criterionId: string;
  /**
   * Omit to leave the stored score alone; send null to clear it.
   *
   * These used to be the same thing, and only for the score: an absent comment
   * was left alone while an absent score was written as null. So a save that
   * touched only a comment erased the score beside it — the field the ranking
   * is built from, silently, on a routine autosave that is not audited.
   */
  score?: number | null;
  /** Omit to leave the stored comment alone; send null to clear it. */
  comment?: string | null;
}

export interface WriteScoresParams {
  scorecardId: string;
  eventId: string;
  scores: IncomingScore[];
  overallStrengths?: string;
  areasForImprovement?: string;
  recommendation?: string;
  submit?: boolean;
  /**
   * Only written when supplied. The portal does not ask a judge to confirm
   * anything, so it passes nothing rather than fabricating a `true` that would
   * look like evidence in a dispute (spec decision 4).
   */
  conflictConfirmed?: boolean;
  /** Audit actor. The judge's own id when scoring through the portal. */
  actorId: string;
  /** Set when the caller has already established the judge's identity. */
  expectedJudgeId?: string;
  /**
   * The scorecard's updatedAt as the client last saw it (CONCUR-4).
   *
   * A judge moving between a phone and a laptop mid-session is expected. The
   * danger is the device they walked away from: a tab left with unsaved edits
   * will save them eventually and overwrite work done since. When this is
   * supplied and does not match, the write is refused with 409 and the client
   * reloads rather than clobbering.
   */
  expectedUpdatedAt?: string | Date;
}

export interface WriteScoresResult {
  scorecardId: string;
  status: ScorecardStatus;
  totalScore: number;
  submitted: boolean;
  /** The client stores this and sends it back on the next write (CONCUR-4). */
  updatedAt: Date;
  /**
   * Criterion ids that were accepted but not stored because they name a
   * category. A page a version behind the rubric will send these; the save
   * succeeds and the client is told what was dropped, so the judge is never
   * told everything saved when part of it did not (spec VAL-5, decision 1c).
   */
  ignoredCriterionIds: string[];
}

interface Criterion {
  id: string;
  name: string;
  maxScore: number;
  requiresComment: boolean;
  parentId: string | null;
}

@Injectable()
export class ScoringCoreService {
  private readonly logger = new Logger(ScoringCoreService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────
  // Template resolution — PRE-4, PRE-5
  // ───────────────────────────────────────────────────────────────────────

  /**
   * The event's one active scoring template.
   *
   * There used to be four different versions of this query across the
   * codebase: two filtered on status ACTIVE and two did not, and none had an
   * orderBy. With more than one template each could resolve to a different
   * one, and rankings would depend on which row Postgres happened to return.
   *
   * Template integrity is a process control — nobody edits a rubric mid-event.
   * This asserts the precondition rather than assuming it.
   */
  async getActiveTemplate(eventId: string) {
    // ACTIVE or LOCKED, never DRAFT. A draft rubric is still being edited, and
    // scoring against one means a judge's answers may not correspond to the
    // questions that end up counting. LOCKED is in use and frozen, so it stays
    // scoreable — excluding it would stop scoring the moment a coordinator
    // locked the criteria.
    const templates = await this.prisma.scoringTemplate.findMany({
      where: { eventId, status: { in: ['ACTIVE', 'LOCKED'] } },
      orderBy: { createdAt: 'asc' },
    });

    if (templates.length === 0) {
      const drafts = await this.prisma.scoringTemplate.count({
        where: { eventId, status: 'DRAFT' },
      });
      throw new BadRequestException(
        drafts > 0
          ? 'The scoring template is still a draft. A coordinator must activate ' +
            'it before judges can score.'
          : 'Scoring is not configured for this event. Contact a coordinator.',
      );
    }
    if (templates.length > 1) {
      throw new BadRequestException(
        `This event has ${templates.length} active scoring templates. Exactly ` +
          'one is required — rankings would otherwise depend on which is read. ' +
          'Contact a coordinator.',
      );
    }
    return templates[0];
  }

  /**
   * Leaves and categories, resolved together so a caller cannot pick up one
   * without the other. A criterion with children is a grouping, not a
   * question: scoring both would ask for the same points twice and put the
   * total past the rubric maximum.
   */
  async getCriteria(templateId: string): Promise<{
    all: Criterion[];
    leaves: Criterion[];
    categoryIds: Set<string>;
    byId: Map<string, Criterion>;
  }> {
    const all = (await this.prisma.scoringCriterion.findMany({
      where: { templateId },
      orderBy: { displayOrder: 'asc' },
      select: {
        id: true,
        name: true,
        maxScore: true,
        requiresComment: true,
        parentId: true,
      },
    })) as Criterion[];

    const categoryIds = new Set(
      all.map((c) => c.parentId).filter(Boolean) as string[],
    );
    const leaves = all.filter((c) => !categoryIds.has(c.id));

    // PRE-5. The old check counted criteria before filtering, so a template of
    // categories only passed it and then scored every team zero.
    if (leaves.length === 0) {
      throw new BadRequestException(
        'The scoring template has no scoreable criteria. Contact a coordinator.',
      );
    }

    return {
      all,
      leaves,
      categoryIds,
      byId: new Map(all.map((c) => [c.id, c])),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Preconditions — PRE-1, PRE-2, PRE-3, STATE-3
  // ───────────────────────────────────────────────────────────────────────

  private async assertWritable(scorecard: any, submitting: boolean) {
    const event = await this.prisma.event.findUnique({
      where: { id: scorecard.eventId },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'COMPLETED' || event.status === 'ARCHIVED') {
      throw new BadRequestException('Event is closed. No more scoring allowed.');
    }

    const session = await this.prisma.judgingSession.findUnique({
      where: { id: scorecard.sessionId },
    });
    if (!session) throw new NotFoundException('Session not found');

    const scoreable = ['SCORING', 'COMPLETED', 'QA', 'IN_PROGRESS'];
    if (!scoreable.includes(session.stage)) {
      throw new BadRequestException(
        'Scoring opens when the coordinator starts this session.',
      );
    }

    if (
      ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(scorecard.status)
    ) {
      throw new BadRequestException(
        'You have already submitted this score. Ask a coordinator to reopen it ' +
          'if it needs changing.',
      );
    }

    // STATE-3. Nothing further is checked here, and the omission is deliberate.
    //
    // This once required a saved draft before a submit — DRAFT or REOPENED
    // only — on the reasoning that submitting with no prior save writes rows
    // created by the same request. That reasoning was wrong. A judge who scores
    // a team in one sitting and presses Submit has never saved a draft and the
    // twenty-second autosave has not yet fired, so their scorecard is still
    // NOT_STARTED. The rule refused an ordinary sequence, and only for judges
    // who worked quickly.
    //
    // Whether a draft was saved along the way says nothing about whether the
    // judgement is complete. SUB-1 checks that, against the template's full
    // leaf set. The guard above already prevents a second submit, which is the
    // only status rule a submit needs.
  }

  // ───────────────────────────────────────────────────────────────────────
  // Validation — VAL-1 to VAL-8
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Validates everything before anything is written (VAL-7). A request that
   * fails leaves the scorecard exactly as it was, so a judge never has to
   * reason about which half of their save landed.
   */
  private validate(
    scores: IncomingScore[],
    criteria: { byId: Map<string, Criterion>; categoryIds: Set<string> },
  ): { accepted: IncomingScore[]; ignoredCriterionIds: string[] } {
    const accepted: IncomingScore[] = [];
    const ignoredCriterionIds: string[] = [];

    for (const s of scores) {
      const criterion = criteria.byId.get(s.criterionId);

      // VAL-4. A criterion from another template is refused rather than
      // ignored: unlike a stale category it indicates the client is scoring
      // against a rubric this event does not use.
      if (!criterion) {
        throw new BadRequestException(
          `Unknown criterion ${s.criterionId} for this event's scoring template.`,
        );
      }

      // VAL-5 / decision 1c. Accepted, dropped, and reported.
      if (criteria.categoryIds.has(s.criterionId)) {
        ignoredCriterionIds.push(s.criterionId);
        continue;
      }

      // An omitted score is not a change; a null one is a deliberate clear.
      // Both skip range validation, but they must stay distinguishable — the
      // write below keys off whether the property is present at all.
      if (!('score' in s)) {
        accepted.push({ ...s });
        continue;
      }
      if (s.score === null || s.score === undefined) {
        accepted.push({ ...s, score: null });
        continue;
      }

      if (s.comment != null && String(s.comment).length > MAX_COMMENT) {
        throw new BadRequestException(
          `Comment for "${criterion.name}" is too long ` +
            `(${String(s.comment).length} characters; the limit is ${MAX_COMMENT}).`,
        );
      }

      if (!Number.isInteger(s.score)) {
        throw new BadRequestException(
          `Score for "${criterion.name}" must be a whole number (got ${s.score}).`,
        );
      }
      if (s.score < 0 || s.score > criterion.maxScore) {
        throw new BadRequestException(
          `Score for "${criterion.name}" must be between 0 and ` +
            `${criterion.maxScore} (got ${s.score}).`,
        );
      }

      accepted.push(s);
    }

    return { accepted, ignoredCriterionIds };
  }

  // ───────────────────────────────────────────────────────────────────────
  // The single write path
  // ───────────────────────────────────────────────────────────────────────

  async writeScores(params: WriteScoresParams): Promise<WriteScoresResult> {
    // A malformed id used to reach Prisma's uuid cast and throw an unhandled
    // 500 — before the ownership check ran, and with a stack trace in the
    // response. Checked here so a bad id is a bad request.
    if (!params.scorecardId || !UUID_RE.test(String(params.scorecardId))) {
      throw new BadRequestException('Scorecard not found');
    }

    const scorecard = await this.prisma.scorecard.findUnique({
      where: { id: params.scorecardId },
    });
    if (!scorecard) throw new NotFoundException('Scorecard not found');

    // 403, not 400. Writing to someone else's scorecard is an authorisation
    // failure, not a malformed request, and a client needs to tell the two
    // apart — a 400 invites a retry with different values.
    if (
      params.expectedJudgeId &&
      scorecard.judgeId !== params.expectedJudgeId
    ) {
      throw new ForbiddenException('This scorecard does not belong to you.');
    }

    // CONCUR-4. Checked before anything else is done, so a stale device is
    // told to reload rather than being allowed part-way through a write.
    if (params.expectedUpdatedAt) {
      const seen = new Date(params.expectedUpdatedAt).getTime();
      const actual = new Date(scorecard.updatedAt).getTime();
      if (seen !== actual) {
        throw new ConflictException(
          'This scorecard was updated on another device. Reload to see the ' +
            'current scores before continuing.',
        );
      }
    }

    for (const [field, label] of [
      ['overallStrengths', 'Overall strengths'],
      ['areasForImprovement', 'Areas for improvement'],
      ['recommendation', 'Recommendation'],
    ] as const) {
      const v = (params as any)[field];
      if (v != null && String(v).length > MAX_SUMMARY) {
        throw new BadRequestException(
          `${label} is too long (${String(v).length} characters; the limit is ` +
            `${MAX_SUMMARY}).`,
        );
      }
    }

    const submitting = params.submit === true;
    await this.assertWritable(scorecard, submitting);

    const template = await this.getActiveTemplate(params.eventId);
    const criteria = await this.getCriteria(template.id);
    const { accepted, ignoredCriterionIds } = this.validate(
      params.scores ?? [],
      criteria,
    );

    // AUDIT-2. Once a scorecard has been submitted at least once, every change
    // to it is a change to a judgement of record, so the previous values are
    // captured before they are overwritten. Routine autosaves on work that has
    // never been submitted are not audited (AUDIT-5) — twelve judges saving
    // every twenty seconds across three days would bury the entries that
    // matter.
    const previouslySubmitted = scorecard.submittedAt !== null;
    const before = previouslySubmitted
      ? await this.prisma.criterionScore.findMany({
          where: { scorecardId: scorecard.id },
          select: { criterionId: true, score: true, comment: true },
        })
      : [];
    const beforeById = new Map(before.map((b) => [b.criterionId, b]));

    // TXN-1. Criterion writes and the scorecard update land together or not at
    // all. Previously a crash between them left scores written and status
    // stale, and two tabs autosaving could produce a total from one request
    // and scores from the other.
    const result = await this.prisma.$transaction(async (tx) => {
      // Every leaf gets a row, so a scorecard is never partially shaped and
      // SUB-1 can validate against the full set rather than whatever exists.
      for (const c of criteria.leaves) {
        await tx.criterionScore.upsert({
          where: {
            scorecardId_criterionId: {
              scorecardId: scorecard.id,
              criterionId: c.id,
            },
          },
          create: { scorecardId: scorecard.id, criterionId: c.id },
          update: {},
        });
      }

      for (const s of accepted) {
        // Only what the caller supplied. `undefined` is Prisma's "leave this
        // column alone"; an explicit null clears it. Building the object this
        // way means a partial payload cannot erase a field it never mentioned,
        // whatever client sent it.
        const data: { score?: number | null; comment?: string | null } = {};
        if ('score' in s) data.score = s.score ?? null;
        if ('comment' in s) data.comment = s.comment ?? null;

        if (Object.keys(data).length === 0) continue;

        await tx.criterionScore.update({
          where: {
            scorecardId_criterionId: {
              scorecardId: scorecard.id,
              criterionId: s.criterionId,
            },
          },
          data,
        });
      }

      const stored = await tx.criterionScore.findMany({
        where: { scorecardId: scorecard.id },
        include: { criterion: true },
      });

      if (submitting) {
        // SUB-1. Validated against the template's full leaf set. The old check
        // iterated the rows that happened to exist, so a scorecard missing a
        // row submitted as complete.
        for (const leaf of criteria.leaves) {
          const row = stored.find((s) => s.criterionId === leaf.id);
          if (!row || row.score === null) {
            throw new BadRequestException(
              `Score for "${leaf.name}" is required.`,
            );
          }
          if (leaf.requiresComment && !row.comment?.trim()) {
            throw new BadRequestException(
              `Comment for "${leaf.name}" is required.`,
            );
          }
        }
      }

      // TOTAL-1, TOTAL-2. Summed from storage, never from the payload. The
      // portal used to sum only the criteria in the current request, so every
      // autosave rewrote the total with whatever the page happened to send —
      // and a submit validated stored rows while totalling the payload.
      const totalScore = stored.reduce((sum, cs) => sum + (cs.score ?? 0), 0);

      const nextStatus: ScorecardStatus = submitting
        ? scorecard.status === 'REOPENED'
          ? ScorecardStatus.RESUBMITTED
          : ScorecardStatus.SUBMITTED
        : scorecard.status === 'NOT_STARTED'
          ? ScorecardStatus.DRAFT
          : (scorecard.status as ScorecardStatus);

      const updated = await tx.scorecard.update({
        where: { id: scorecard.id },
        data: {
          status: nextStatus,
          totalScore,
          submittedAt: submitting ? new Date() : scorecard.submittedAt,
          // Undefined leaves the column alone, so a save that carries only
          // scores does not wipe a judge's notes (DRAFT-3).
          overallStrengths: params.overallStrengths,
          areasForImprovement: params.areasForImprovement,
          recommendation: params.recommendation,
          // Written only when the caller actually asked someone (decision 4).
          conflictConfirmed:
            params.conflictConfirmed === undefined
              ? undefined
              : params.conflictConfirmed,
        },
      });

      return { updated, stored, totalScore, nextStatus };
    });

    await this.writeAudit({
      scorecard,
      params,
      previouslySubmitted,
      beforeById,
      after: result.stored,
      nextStatus: result.nextStatus,
      totalScore: result.totalScore,
      submitting,
    });

    return {
      scorecardId: scorecard.id,
      status: result.nextStatus,
      totalScore: result.totalScore,
      submitted: submitting,
      updatedAt: result.updated.updatedAt,
      ignoredCriterionIds,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Audit — AUDIT-1, AUDIT-2, AUDIT-5
  // ───────────────────────────────────────────────────────────────────────

  private async writeAudit(ctx: {
    scorecard: any;
    params: WriteScoresParams;
    previouslySubmitted: boolean;
    beforeById: Map<string, { score: number | null; comment: string | null }>;
    after: any[];
    nextStatus: ScorecardStatus;
    totalScore: number;
    submitting: boolean;
  }) {
    const {
      scorecard,
      params,
      previouslySubmitted,
      beforeById,
      after,
      nextStatus,
      totalScore,
      submitting,
    } = ctx;

    const firstDraft =
      !submitting && scorecard.status === 'NOT_STARTED';

    // AUDIT-5: routine autosaves on unsubmitted work are not recorded.
    if (!submitting && !previouslySubmitted && !firstDraft) return;

    const changes: any[] = [];
    if (previouslySubmitted) {
      for (const row of after) {
        const was = beforeById.get(row.criterionId);
        if (!was) continue;
        if (was.score !== row.score || (was.comment ?? null) !== (row.comment ?? null)) {
          changes.push({
            criterion: row.criterion?.name ?? row.criterionId,
            scoreFrom: was.score,
            scoreTo: row.score,
            commentChanged: (was.comment ?? null) !== (row.comment ?? null),
          });
        }
      }
    }

    // Free-text changes on a submitted scorecard are recorded alongside the
    // scores (decision 2b): the scores decide the ranking, the text decides how
    // a team reads its own feedback.
    const textChanged = previouslySubmitted
      ? {
          overallStrengths:
            params.overallStrengths !== undefined &&
            params.overallStrengths !== scorecard.overallStrengths,
          areasForImprovement:
            params.areasForImprovement !== undefined &&
            params.areasForImprovement !== scorecard.areasForImprovement,
          recommendation:
            params.recommendation !== undefined &&
            params.recommendation !== scorecard.recommendation,
        }
      : undefined;

    try {
      await this.audit.log({
        userId: params.actorId,
        eventId: scorecard.eventId,
        action: AuditAction.UPDATE,
        entityType: 'Scorecard',
        entityId: scorecard.id,
        oldValues: {
          status: scorecard.status,
          totalScore: scorecard.totalScore,
          ...(changes.length ? { criterionScores: changes } : {}),
        },
        newValues: {
          status: nextStatus,
          totalScore,
          judgeId: scorecard.judgeId,
          teamId: scorecard.teamId,
          sessionId: scorecard.sessionId,
          ...(textChanged ? { textChanged } : {}),
        },
      });
    } catch (err: any) {
      // An audit failure must never lose a judge's score. The write has already
      // committed; losing the trail is bad, losing the judgement is worse.
      this.logger.error(
        `Audit write failed for scorecard ${scorecard.id}: ${err?.message}`,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Break — AUDIT-4
  // ───────────────────────────────────────────────────────────────────────

  async recordBreak(ctx: {
    eventId: string;
    sessionId: string;
    judgeId: string;
    judgeName: string;
    onBreak: boolean;
    draftDiscarded: boolean;
    actorId: string;
  }) {
    try {
      await this.audit.log({
        userId: ctx.actorId,
        eventId: ctx.eventId,
        action: AuditAction.UPDATE,
        entityType: 'SessionJudge',
        entityId: `${ctx.sessionId}:${ctx.judgeId}`,
        newValues: {
          judgeName: ctx.judgeName,
          onBreak: ctx.onBreak,
          draftDiscarded: ctx.draftDiscarded,
        },
      });
    } catch (err: any) {
      this.logger.error(`Audit write failed for break: ${err?.message}`);
    }
  }
}
