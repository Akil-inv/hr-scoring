import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, ScorecardStatus } from '@prisma/client';
import { SaveScorecardInput, SubmitScorecardInput } from './scorecards.types';
import { RankingsService } from '../rankings/rankings.service';
import { ScoringCoreService } from './scoring-core.service';

@Injectable()
export class ScorecardsService {
  private readonly logger = new Logger(ScorecardsService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private rankings: RankingsService,
    private core: ScoringCoreService,
  ) {}

  /**
   * Recompute standings after a scorecard lands.
   *
   * Deliberately not awaited by the caller and deliberately swallowing its own
   * errors: a judge submitting a scorecard should never see a failure because
   * a downstream ranking calculation had a problem. Results stay PROVISIONAL —
   * approving and publishing are still explicit admin actions.
   */
  private recalculateRankings(eventId: string, userId: string) {
    this.rankings.calculateRankings(eventId, null, userId).catch((err) => {
      this.logger.warn(`Ranking recalculation failed for event ${eventId}: ${err?.message}`);
    });
  }

  private enrichScorecard(sc: any) {
    return {
      ...sc,
      flaggedForReview: sc.flaggedForReview ?? false,
      judgeName: sc.judge?.name || '',
      teamName: sc.team?.name || '',
      projectName: sc.team?.projectName || '',
      criterionScores: (sc.criterionScores || []).map((cs: any) => ({
        id: cs.id,
        criterionId: cs.criterionId,
        criterionName: cs.criterion?.name || '',
        maxScore: cs.criterion?.maxScore || 0,
        guidanceText: cs.criterion?.guidanceText || null,
        requiresComment: cs.criterion?.requiresComment || false,
        // Carries the setup-page ordering through to the judge portal so the
        // scoring rows render in the same order they were arranged in setup.
        displayOrder: cs.criterion?.displayOrder ?? 0,
        // Lets the judge portal group rows under their category and show a
        // running subtotal per section.
        parentId: cs.criterion?.parentId || null,
        categoryName: cs.criterion?.parent?.name || null,
        categoryMaxScore: cs.criterion?.parent?.maxScore || null,
        score: cs.score,
        comment: cs.comment,
      })),
    };
  }

  // ─── SECURITY: Check if scoring is allowed ───
  private async assertScoringAllowed(scorecard: any) {
    // Check event is not completed
    const event = await this.prisma.event.findUnique({ where: { id: scorecard.eventId } });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'COMPLETED' || event.status === 'ARCHIVED') {
      throw new BadRequestException('Event is closed. No more scoring allowed.');
    }

    // Check session is in a scoreable stage
    const session = await this.prisma.judgingSession.findUnique({ where: { id: scorecard.sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    const scoreableStages = ['SCORING', 'COMPLETED', 'QA', 'IN_PROGRESS'];
    if (!scoreableStages.includes(session.stage)) {
      throw new BadRequestException(`Scoring not enabled. Session is in ${session.stage} stage. Organizer must start the session first.`);
    }
  }

  async findByJudge(judgeId: string, eventId: string) {
    const scorecards = await this.prisma.scorecard.findMany({
      where: { judgeId, eventId },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
        session: { include: { room: true, timeSlot: true } },
      },
      orderBy: { session: { scheduledStart: 'asc' } },
    });
    return scorecards.map(sc => this.enrichScorecard(sc));
  }

  async findByTeam(teamId: string) {
    const scorecards = await this.prisma.scorecard.findMany({
      where: { teamId },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
      },
    });
    return scorecards.map(sc => this.enrichScorecard(sc));
  }

  async findOne(id: string) {
    const sc = await this.prisma.scorecard.findUnique({
      where: { id },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
      },
    });
    if (!sc) throw new NotFoundException('Scorecard not found');
    return this.enrichScorecard(sc);
  }

  async findByEvent(eventId: string) {
    const scorecards = await this.prisma.scorecard.findMany({
      where: { eventId },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return scorecards.map(sc => this.enrichScorecard(sc));
  }

  // ─── SCORING BY TOKEN (judge portal) ───
  async findByJudgeToken(judgeId: string, eventId: string) {
    const scorecards = await this.prisma.scorecard.findMany({
      where: { judgeId, eventId },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
        session: { include: { room: true, timeSlot: true } },
      },
      orderBy: { session: { scheduledStart: 'asc' } },
    });

    return scorecards.map(sc => {
      const session = sc.session;
      const scoreableStages = ['SCORING', 'COMPLETED', 'QA', 'IN_PROGRESS'];
      const canScore = scoreableStages.includes(session?.stage || '') &&
        ['NOT_STARTED', 'DRAFT', 'REOPENED'].includes(sc.status);

      return {
        ...this.enrichScorecard(sc),
        sessionStage: session?.stage || 'UNKNOWN',
        roomName: session?.room?.name || '',
        scheduledStart: session?.timeSlot?.startTime,
        scheduledEnd: session?.timeSlot?.endTime,
        canScore,
      };
    });
  }

  /**
   * Kept for callers that seed a scorecard outside a save. The leaf-versus-
   * category rule lives in ScoringCoreService so there is exactly one of it.
   */
  async initializeCriterionScores(scorecardId: string, templateId: string) {
    const { leaves } = await this.core.getCriteria(templateId);
    for (const c of leaves) {
      await this.prisma.criterionScore.upsert({
        where: { scorecardId_criterionId: { scorecardId, criterionId: c.id } },
        create: { scorecardId, criterionId: c.id },
        update: {},
      });
    }
  }

  /**
   * Scoring lives in ScoringCoreService — see the note at the top of that file
   * for why. These two methods exist only to adapt the GraphQL input types and
   * return the enriched shape the resolver expects.
   */
  async saveDraft(input: SaveScorecardInput, userId: string) {
    const sc = await this.prisma.scorecard.findUnique({
      where: { id: input.scorecardId },
      select: { eventId: true },
    });
    if (!sc) throw new NotFoundException('Scorecard not found');

    await this.core.writeScores({
      scorecardId: input.scorecardId,
      eventId: sc.eventId,
      scores: input.scores,
      overallStrengths: input.overallStrengths,
      areasForImprovement: input.areasForImprovement,
      recommendation: input.recommendation,
      submit: false,
      actorId: userId,
    });

    return this.findOne(input.scorecardId);
  }

  async submit(input: SubmitScorecardInput, userId: string) {
    const sc = await this.prisma.scorecard.findUnique({
      where: { id: input.scorecardId },
      select: { eventId: true },
    });
    if (!sc) throw new NotFoundException('Scorecard not found');

    await this.core.writeScores({
      scorecardId: input.scorecardId,
      eventId: sc.eventId,
      scores: (input as any).scores ?? [],
      overallStrengths: (input as any).overallStrengths,
      areasForImprovement: (input as any).areasForImprovement,
      recommendation: (input as any).recommendation,
      submit: true,
      // Optional now. The portal never asked a judge to confirm anything, so a
      // hard requirement here would have rejected every judge submission once
      // the two paths merged. Recorded when a caller genuinely asked.
      conflictConfirmed: input.conflictConfirmed,
      actorId: userId,
    });

    this.recalculateRankings(sc.eventId, userId);

    return this.findOne(input.scorecardId);
  }

  async reopen(scorecardId: string, reason: string, userId: string) {
    const sc = await this.prisma.scorecard.findUnique({ where: { id: scorecardId } });
    if (!sc) throw new NotFoundException('Scorecard not found');
    if (!['SUBMITTED', 'RESUBMITTED'].includes(sc.status)) {
      throw new BadRequestException('Can only reopen submitted scorecards');
    }

    const updated = await this.prisma.scorecard.update({
      where: { id: scorecardId },
      data: { status: 'REOPENED', reopenReason: reason },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
      },
    });

    await this.audit.log({
      userId, eventId: sc.eventId,
      action: AuditAction.UPDATE, entityType: 'Scorecard', entityId: scorecardId,
      oldValues: { status: sc.status }, newValues: { status: 'REOPENED', reason },
    });

    this.recalculateRankings(sc.eventId, userId);

    return this.enrichScorecard(updated);
  }

  async lock(scorecardId: string, userId: string) {
    const updated = await this.prisma.scorecard.update({
      where: { id: scorecardId },
      data: { status: 'LOCKED', lockedAt: new Date() },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
      },
    });
    return this.enrichScorecard(updated);
  }
}
