import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RankingStatus, AuditAction, ScorecardStatus } from '@prisma/client';
import { RankingOutput } from './rankings.types';

/**
 * Ranking calculation.
 *
 * Rule ids refer to docs/JUDGING-SPEC.md.
 *
 * The change that matters most here is RANK-4. The tie-break used to run
 * correctly and then be thrown away: teams with equal aggregates were written
 * with the same rankPosition, and getRankings ordered by rankPosition alone, so
 * for tied teams Postgres returned them in whatever order it liked. The order
 * shown after a refresh could differ from the order computed, and could differ
 * between two refreshes. Which team was announced as the winner depended on
 * when you looked.
 */

/** Scores within this distance are treated as equal (ROUND-2). */
const TIE_EPSILON = 0.01;

const COUNTED: ScorecardStatus[] = [
  ScorecardStatus.SUBMITTED,
  ScorecardStatus.RESUBMITTED,
  ScorecardStatus.LOCKED,
];

@Injectable()
export class RankingsService {
  private readonly logger = new Logger(RankingsService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  /**
   * The event's one active scoring template.
   *
   * Mirrors ScoringCoreService.getActiveTemplate. This used to be a bare
   * findFirst with no status filter and no orderBy, which is a different
   * question from the one the scoring path asked — so scoring and ranking could
   * resolve to different templates.
   */
  private async getActiveTemplate(eventId: string) {
    // ACTIVE or LOCKED, matching ScoringCoreService. Ranking against a DRAFT
    // rubric used to be possible — the old lookup had no status filter at all,
    // so standings could be computed from a template still being edited.
    const templates = await this.prisma.scoringTemplate.findMany({
      where: { eventId, status: { in: ['ACTIVE', 'LOCKED'] } },
      orderBy: { createdAt: 'asc' },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    if (templates.length === 0) {
      throw new BadRequestException(
        'No active scoring template for this event. A draft template must be ' +
          'activated before rankings can be calculated.',
      );
    }
    if (templates.length > 1) {
      throw new BadRequestException(
        `This event has ${templates.length} active scoring templates. Exactly ` +
          'one is required — rankings would otherwise depend on which is read.',
      );
    }
    return templates[0];
  }

  private async getTeamJudgeNames(
    eventId: string,
    teamIds: string[],
  ): Promise<Map<string, string[]>> {
    const sessionJudges = await this.prisma.sessionJudge.findMany({
      where: {
        session: { eventId, teamId: { in: teamIds } },
        judge: { deletedAt: null },
      },
      include: { judge: true, session: true },
    });
    const map = new Map<string, string[]>();
    for (const sj of sessionJudges) {
      const names = map.get(sj.session.teamId) || [];
      if (!names.includes(sj.judge.name)) names.push(sj.judge.name);
      map.set(sj.session.teamId, names);
    }
    return map;
  }

  /**
   * How many counted scorecards each team should have — its assigned judges,
   * less anyone on break (RANK-8). The old incomplete count only noticed teams
   * with no scores at all, so a team judged by one of three read as complete.
   */
  private async getExpectedJudgeCounts(
    eventId: string,
    teamIds: string[],
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.sessionJudge.findMany({
      where: {
        session: { eventId, teamId: { in: teamIds }, stage: { not: 'CANCELLED' } },
        onBreak: false,
        judge: { deletedAt: null },
      } as any,
      include: { session: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.session.teamId, (map.get(r.session.teamId) ?? 0) + 1);
    }
    return map;
  }

  async calculateRankings(
    eventId: string,
    trackId: string | null,
    userId: string,
  ): Promise<RankingOutput> {
    this.logger.log(
      `Calculating rankings for event ${eventId}, track ${trackId || 'overall'}`,
    );

    const template = await this.getActiveTemplate(eventId);

    // Categories carry no scores of their own. The leaf check runs after
    // filtering, not before: a template of categories only used to pass the old
    // check and then score every team zero (PRE-5).
    const parentIds = new Set(
      template.criteria.map((c: any) => c.parentId).filter(Boolean),
    );
    const criteria = template.criteria.filter((c: any) => !parentIds.has(c.id));
    if (criteria.length === 0) {
      throw new BadRequestException(
        'The scoring template has no scoreable criteria — every team would score zero.',
      );
    }

    const teamWhere: any = { eventId, deletedAt: null };
    if (trackId) teamWhere.trackId = trackId;
    const teams = await this.prisma.team.findMany({
      where: teamWhere,
      include: { track: true },
    });
    if (teams.length === 0) throw new BadRequestException('No teams found');

    const teamIds = teams.map((t) => t.id);

    // RANK-6. A soft-deleted judge's scorecard used to keep counting towards a
    // team's average long after the judge was removed from the event.
    const scorecards = await this.prisma.scorecard.findMany({
      where: {
        eventId,
        teamId: { in: teamIds },
        status: { in: COUNTED },
        judge: { deletedAt: null },
      },
      include: { criterionScores: { include: { criterion: true } } },
    });

    // RANK-7. REOPENED is not a counted status, so calculating while one is
    // open silently drops that judge from the team's average. Silent is exactly
    // what this platform must not be.
    const reopened = await this.prisma.scorecard.findMany({
      where: { eventId, teamId: { in: teamIds }, status: ScorecardStatus.REOPENED },
      include: { team: true, judge: true },
    });

    const teamJudgeNames = await this.getTeamJudgeNames(eventId, teamIds);
    const expectedCounts = await this.getExpectedJudgeCounts(eventId, teamIds);

    const teamScorecards = new Map<string, typeof scorecards>();
    for (const sc of scorecards) {
      const arr = teamScorecards.get(sc.teamId) || [];
      arr.push(sc);
      teamScorecards.set(sc.teamId, arr);
    }

    type Scored = {
      teamId: string;
      teamName: string;
      projectName: string;
      trackName: string | null;
      trackId: string | null;
      aggregatedScore: number;
      bestCriterionAverage: number;
      judgeCount: number;
      expectedJudgeCount: number;
      judgeNames: string;
      criterionAverages: Array<{
        criterionId: string;
        criterionName: string;
        average: number;
        maxScore: number;
      }>;
    };

    let teamsWithIncompleteScores = 0;
    const teamScores: Scored[] = [];

    for (const team of teams) {
      const cards = teamScorecards.get(team.id) || [];
      const expected = expectedCounts.get(team.id) ?? 0;

      if (cards.length === 0) {
        teamsWithIncompleteScores++;
        continue;
      }
      if (expected > 0 && cards.length < expected) teamsWithIncompleteScores++;

      const criterionAverages: Scored['criterionAverages'] = [];
      let best = 0;

      for (const criterion of criteria) {
        const scores: number[] = [];
        for (const card of cards) {
          const cs = card.criterionScores.find(
            (s) => s.criterionId === criterion.id,
          );
          if (cs && cs.score !== null) scores.push(cs.score);
        }
        const average =
          scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 0;
        const rounded = this.round2(average);
        best = Math.max(best, rounded);
        criterionAverages.push({
          criterionId: criterion.id,
          criterionName: criterion.name,
          average: rounded,
          maxScore: criterion.maxScore,
        });
      }

      teamScores.push({
        teamId: team.id,
        teamName: team.name,
        projectName: team.projectName,
        trackName: team.track?.name || null,
        trackId: team.trackId || null,
        aggregatedScore: this.round2(
          criterionAverages.reduce((sum, ca) => sum + ca.average, 0),
        ),
        bestCriterionAverage: best,
        judgeCount: cards.length,
        expectedJudgeCount: expected,
        judgeNames: (teamJudgeNames.get(team.id) || []).join(', '),
        criterionAverages,
      });
    }

    // Ordering: score, then highest single criterion average, then judge count.
    // Scores within TIE_EPSILON are treated as equal (ROUND-2) so a placement is
    // never decided by a difference smaller than the rubric can express.
    // teamId last, so the order is deterministic even where everything ties —
    // two refreshes must never disagree.
    const equal = (a: number, b: number) => Math.abs(a - b) < TIE_EPSILON;

    teamScores.sort((a, b) => {
      if (!equal(a.aggregatedScore, b.aggregatedScore)) {
        return b.aggregatedScore - a.aggregatedScore;
      }
      if (!equal(a.bestCriterionAverage, b.bestCriterionAverage)) {
        return b.bestCriterionAverage - a.bestCriterionAverage;
      }
      if (a.judgeCount !== b.judgeCount) return b.judgeCount - a.judgeCount;
      return a.teamId.localeCompare(b.teamId);
    });

    // RANK-4. Position follows the sorted order, so the tie-break survives being
    // written down. A position is only shared where a tie survived every
    // tie-break, and that is recorded rather than inferred.
    const fullyTiedWithPrevious = (i: number): boolean => {
      if (i === 0) return false;
      const a = teamScores[i];
      const b = teamScores[i - 1];
      return (
        equal(a.aggregatedScore, b.aggregatedScore) &&
        equal(a.bestCriterionAverage, b.bestCriterionAverage) &&
        a.judgeCount === b.judgeCount
      );
    };

    const positions: number[] = [];
    const tiedFlags: boolean[] = [];
    for (let i = 0; i < teamScores.length; i++) {
      const shared = fullyTiedWithPrevious(i);
      positions.push(shared ? positions[i - 1] : i + 1);
      tiedFlags.push(shared);
      if (shared) tiedFlags[i - 1] = true;
    }

    const rankingsData = teamScores.map((ts, i) => ({
      eventId,
      trackId: trackId || null,
      teamId: ts.teamId,
      rankPosition: positions[i],
      aggregatedScore: ts.aggregatedScore,
      judgeCount: ts.judgeCount,
      aggregationMethod: 'criterion_average_sum',
      status: RankingStatus.PROVISIONAL,
      tied: tiedFlags[i],
    }));

    // RANK-9, RANK-10. Delete and insert in one transaction, behind a per-event
    // advisory lock. Previously these were two separate statements, so a failure
    // between them left the event with no rankings at all — and submit() fired
    // recalculation without awaiting it, so twelve judges finishing a slot
    // together meant concurrent delete-then-insert cycles over the same rows.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${eventId}))`;
      await tx.rankingResult.deleteMany({
        where: { eventId, trackId: trackId || null },
      });
      if (rankingsData.length > 0) {
        await tx.rankingResult.createMany({ data: rankingsData });
      }
    });

    const warnings: string[] = [];
    if (reopened.length > 0) {
      const names = [...new Set(reopened.map((r) => r.team.name))];
      warnings.push(
        `${reopened.length} scorecard(s) are reopened and are not counted: ` +
          `${names.slice(0, 5).join(', ')}` +
          `${names.length > 5 ? `, and ${names.length - 5} more` : ''}. ` +
          'Those teams are ranked on fewer judges than expected.',
      );
    }
    const short = teamScores.filter(
      (t) => t.expectedJudgeCount > 0 && t.judgeCount < t.expectedJudgeCount,
    );
    if (short.length > 0) {
      warnings.push(
        `${short.length} team(s) have fewer scorecards than judges assigned: ` +
          short
            .slice(0, 5)
            .map((t) => `${t.teamName} (${t.judgeCount}/${t.expectedJudgeCount})`)
            .join(', '),
      );
    }
    const survivingTies = tiedFlags.filter(Boolean).length;
    if (survivingTies > 0) {
      warnings.push(
        `${survivingTies} team(s) are tied on score, best criterion and judge ` +
          'count. Those placements need a coordinator decision.',
      );
    }

    await this.audit.log({
      userId,
      eventId,
      action: AuditAction.UPDATE,
      entityType: 'RankingResult',
      entityId: trackId || 'overall',
      newValues: {
        status: 'PROVISIONAL',
        teamsRanked: teamScores.length,
        scope: trackId ? 'track' : 'overall',
        warnings,
      },
    });

    const track = trackId
      ? await this.prisma.challengeTrack.findUnique({ where: { id: trackId } })
      : null;

    return {
      eventId,
      trackId: trackId || undefined,
      trackName: track?.name || 'Overall',
      status: RankingStatus.PROVISIONAL,
      teamsRanked: teamScores.length,
      teamsWithIncompleteScores,
      calculatedAt: new Date().toISOString(),
      warnings,
      rankings: teamScores.map((ts, i) => ({
        teamId: ts.teamId,
        teamName: ts.teamName,
        projectName: ts.projectName,
        trackName: ts.trackName || undefined,
        trackId: ts.trackId || undefined,
        rankPosition: positions[i],
        aggregatedScore: ts.aggregatedScore,
        judgeCount: ts.judgeCount,
        expectedJudgeCount: ts.expectedJudgeCount,
        judgeNames: ts.judgeNames,
        criterionAverages: ts.criterionAverages,
        tied: tiedFlags[i],
        tieBreakNote: tiedFlags[i]
          ? 'Tied on score, best criterion average and judge count — needs a coordinator decision'
          : i > 0 && equal(ts.aggregatedScore, teamScores[i - 1].aggregatedScore)
            ? 'Tie broken by highest criterion average, then judge count'
            : undefined,
      })),
    };
  }

  async getRankings(
    eventId: string,
    trackId?: string,
  ): Promise<RankingOutput | null> {
    // RANK-5. Ordered by position and then by team id, so a genuine shared
    // position still yields the same order on every read. Ordering by position
    // alone left tied teams to Postgres's discretion.
    const rankings = await this.prisma.rankingResult.findMany({
      where: { eventId, trackId: trackId || null },
      orderBy: [{ rankPosition: 'asc' }, { teamId: 'asc' }],
      include: { team: { include: { track: true } } },
    });

    if (rankings.length === 0) return null;

    const track = trackId
      ? await this.prisma.challengeTrack.findUnique({ where: { id: trackId } })
      : null;

    const template = await this.getActiveTemplate(eventId);
    const parentIds = new Set(
      template.criteria.map((c: any) => c.parentId).filter(Boolean),
    );
    const criteria = template.criteria.filter((c: any) => !parentIds.has(c.id));

    const teamIds = rankings.map((r) => r.teamId);
    const teamJudgeNames = await this.getTeamJudgeNames(eventId, teamIds);
    const expectedCounts = await this.getExpectedJudgeCounts(eventId, teamIds);

    const scorecards = await this.prisma.scorecard.findMany({
      where: {
        eventId,
        teamId: { in: teamIds },
        status: { in: COUNTED },
        judge: { deletedAt: null },
      },
      include: { criterionScores: true },
    });

    const teamCriterionAvgs = new Map<string, any[]>();
    for (const teamId of teamIds) {
      const cards = scorecards.filter((sc) => sc.teamId === teamId);
      teamCriterionAvgs.set(
        teamId,
        criteria.map((cr: any) => {
          const scores = cards
            .flatMap((c) => c.criterionScores)
            .filter((cs) => cs.criterionId === cr.id && cs.score !== null)
            .map((cs) => cs.score!);
          return {
            criterionId: cr.id,
            criterionName: cr.name,
            average: scores.length
              ? this.round2(scores.reduce((a, b) => a + b, 0) / scores.length)
              : 0,
            maxScore: cr.maxScore,
          };
        }),
      );
    }

    const warnings: string[] = [];
    const tiedCount = rankings.filter((r) => (r as any).tied).length;
    if (tiedCount > 0) {
      warnings.push(
        `${tiedCount} team(s) share a rank position and need a coordinator decision.`,
      );
    }

    return {
      eventId,
      trackId,
      trackName: track?.name || 'Overall',
      status: rankings[0]?.status || RankingStatus.CALCULATING,
      teamsRanked: rankings.length,
      teamsWithIncompleteScores: 0,
      calculatedAt: rankings[0]?.createdAt?.toISOString(),
      warnings,
      rankings: rankings.map((r) => ({
        teamId: r.teamId,
        teamName: r.team.name,
        projectName: r.team.projectName,
        trackName: r.team.track?.name || undefined,
        trackId: r.team.trackId || undefined,
        rankPosition: r.rankPosition,
        aggregatedScore: Number(r.aggregatedScore),
        judgeCount: r.judgeCount,
        expectedJudgeCount: expectedCounts.get(r.teamId) ?? 0,
        judgeNames: (teamJudgeNames.get(r.teamId) || []).join(', '),
        criterionAverages: teamCriterionAvgs.get(r.teamId) || [],
        tied: Boolean((r as any).tied),
        tieBreakNote: (r as any).tied
          ? 'Tied on score, best criterion average and judge count — needs a coordinator decision'
          : undefined,
      })),
    };
  }

  async approveRankings(
    eventId: string,
    trackId: string | null,
    userId: string,
  ): Promise<RankingOutput | null> {
    const updated = await this.prisma.rankingResult.updateMany({
      where: { eventId, trackId: trackId || null, status: RankingStatus.PROVISIONAL },
      data: {
        status: RankingStatus.APPROVED,
        approvedBy: userId,
        approvedAt: new Date(),
      },
    });

    // A no-op used to succeed silently, so approving twice — or approving
    // rankings that had never been calculated — looked exactly like approving
    // them for the first time.
    if (updated.count === 0) {
      throw new BadRequestException(
        'Nothing to approve. Calculate rankings first, or they have already been approved.',
      );
    }

    this.logger.log(`Approved ${updated.count} rankings`);
    await this.audit.log({
      userId,
      eventId,
      action: AuditAction.UPDATE,
      entityType: 'RankingResult',
      entityId: trackId || 'overall',
      newValues: { status: 'APPROVED', count: updated.count },
    });

    return this.getRankings(eventId, trackId || undefined);
  }

  async publishRankings(
    eventId: string,
    trackId: string | null,
    userId: string,
  ): Promise<RankingOutput | null> {
    const updated = await this.prisma.rankingResult.updateMany({
      where: { eventId, trackId: trackId || null, status: RankingStatus.APPROVED },
      data: { status: RankingStatus.PUBLISHED, publishedAt: new Date() },
    });

    if (updated.count === 0) {
      throw new BadRequestException(
        'Nothing to publish. Rankings must be approved first.',
      );
    }

    this.logger.log(`Published ${updated.count} rankings`);
    await this.audit.log({
      userId,
      eventId,
      action: AuditAction.UPDATE,
      entityType: 'RankingResult',
      entityId: trackId || 'overall',
      newValues: { status: 'PUBLISHED', count: updated.count },
    });

    return this.getRankings(eventId, trackId || undefined);
  }
}
