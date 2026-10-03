import { Controller, Get, Post, Param, Query, Body, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { JudgePortalService } from './judge-portal.service';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ScoringCoreService } from '../scorecards/scoring-core.service';

@Controller('api/judge-portal')
export class JudgePortalController {
  constructor(
    private service: JudgePortalService,
    private prisma: PrismaService,
    private audit: AuditService,
    private core: ScoringCoreService,
  ) {}

  @Public()
  @Get(':token')
  async getSchedule(@Param('token') token: string, @Query('event') eventId: string) {
    return this.service.getJudgeSchedule(token, eventId);
  }

  @Public()
  @Get(':token/scorecards')
  async getScorecards(@Param('token') token: string, @Query('event') eventId: string) {
    const judge = await this.service.getJudgeByToken(token, eventId);
    // Sessions this judge has stepped out of. Their scorecards are excluded so
    // the portal does not keep asking for a score they are excused from.
    const breaks = await this.prisma.sessionJudge.findMany({
      where: { judgeId: judge.id, onBreak: true } as any,
      select: { sessionId: true },
    });
    const onBreak = new Set(breaks.map(b => b.sessionId));

    const scorecards = await this.prisma.scorecard.findMany({
      where: { judgeId: judge.id, eventId },
      include: {
        judge: true, team: true,
        criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } },
        session: { include: { room: true, timeSlot: true } },
      },
      orderBy: { session: { scheduledStart: 'asc' } },
    });

    // ─── Auto-create criterion scores for scorecards that have none ───
    // This ensures the judge sees sliders on first load, not just after saving a draft
    const template = await this.prisma.scoringTemplate.findFirst({
      where: { eventId },
      include: { criteria: { orderBy: { displayOrder: 'asc' } } },
    });
    if (template) {
      // Categories group the questions; they are not questions themselves.
      // Creating a score row for one would ask a judge for the same points
      // twice and put the total past 100.
      const categoryIds = new Set(
        template.criteria.map((c: any) => c.parentId).filter(Boolean) as string[],
      );
      const scoreableCriteria = template.criteria.filter((c: any) => !categoryIds.has(c.id));

      for (const sc of scorecards) {
        if (sc.criterionScores.length === 0) {
          for (const c of scoreableCriteria) {
            await this.prisma.criterionScore.upsert({
              where: { scorecardId_criterionId: { scorecardId: sc.id, criterionId: c.id } },
              create: { scorecardId: sc.id, criterionId: c.id },
              update: {},
            });
          }
          // Re-fetch so the response includes the newly created scores
          const updated = await this.prisma.scorecard.findUnique({
            where: { id: sc.id },
            include: { criterionScores: { include: { criterion: { include: { parent: true } } }, orderBy: { criterion: { displayOrder: 'asc' } } } },
          });
          if (updated) (sc as any).criterionScores = updated.criterionScores;
        }
      }
    }

    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    const eventClosed = event?.status === 'COMPLETED' || event?.status === 'ARCHIVED';

    return scorecards
      // A session this judge stepped out of is not theirs to score. Removing it
      // here keeps it out of every quadrant at once, rather than each surface
      // needing to know about breaks.
      .filter(sc => !onBreak.has(sc.sessionId))
      .map(sc => {
      const scoreableStages = ['SCORING', 'COMPLETED', 'QA', 'IN_PROGRESS'];
      const sessionActive = scoreableStages.includes(sc.session?.stage || '');
      const scorecardEditable = ['NOT_STARTED', 'DRAFT', 'REOPENED'].includes(sc.status);

      return {
        id: sc.id,
        sessionId: sc.sessionId,
        judgeId: sc.judgeId,
        teamName: sc.team?.name,
        projectName: sc.team?.projectName,
        roomName: sc.session?.room?.name,
        scheduledStart: sc.session?.timeSlot?.startTime,
        scheduledEnd: sc.session?.timeSlot?.endTime,
        sessionStage: sc.session?.stage,
        status: sc.status,
        totalScore: sc.totalScore,
        overallStrengths: sc.overallStrengths,
        areasForImprovement: sc.areasForImprovement,
        recommendation: sc.recommendation,
        submittedAt: sc.submittedAt,
        reopenReason: sc.reopenReason,
        flaggedForReview: (sc as any).flaggedForReview ?? false,
        canScore: sessionActive && scorecardEditable && !eventClosed,
        canView: sc.status !== 'NOT_STARTED',
        eventClosed,
        criterionScores: sc.criterionScores.map(cs => ({
          id: cs.id,
          criterionId: cs.criterionId,
          criterionName: cs.criterion?.name,
          maxScore: cs.criterion?.maxScore,
          guidanceText: cs.criterion?.guidanceText,
          requiresComment: cs.criterion?.requiresComment,
          scoringAnchors: cs.criterion?.scoringAnchors,
          // Lets the portal group rows under their category and show a
          // running subtotal per section.
          parentId: (cs.criterion as any)?.parentId ?? null,
          categoryName: (cs.criterion as any)?.parent?.name ?? null,
          categoryMaxScore: (cs.criterion as any)?.parent?.maxScore ?? null,
          score: cs.score,
          comment: cs.comment,
        })),
      };
    });
  }

  /**
   * Mark a scorecard for a second look, or clear the mark.
   *
   * Independent of submission on purpose. Flagging is not a substitute for
   * scoring, and wanting another look at something already submitted is the
   * more common case of the two.
   */
  /** The judge has read it. Dismissal is what retires a message. */
  @Public()
  @Post(':token/dismiss-message')
  async dismissMessage(
    @Param('token') token: string,
    @Query('event') eventId: string,
    @Body() body: { messageId: string },
  ) {
    const judge = await this.service.getJudgeByToken(token, eventId);
    await this.prisma.judgeMessage.updateMany({
      where: { id: body.messageId, judgeId: judge.id },
      data: { dismissedAt: new Date() },
    });
    return { success: true };
  }

  /**
   * Step out of one session, or come back.
   *
   * Only an MD. The panel is one MD, one ED or SVP, and one PS — the MD pool is
   * three deep precisely so one can be absent, and the other two seats have no
   * such slack. Refused rather than hidden, because the endpoint is reachable
   * whatever the button does.
   */
  @Public()
  @Post(':token/break')
  async declareBreak(
    @Param('token') token: string,
    @Query('event') eventId: string,
    @Body() body: { sessionId: string; onBreak: boolean },
  ) {
    const judge = await this.service.getJudgeByToken(token, eventId);

    // The two IG seats. The PS is excluded: there is one per session and no
    // cover for them at all.
    if (!['L2', 'L3', 'L4'].includes((judge as any).judgeTier)) {
      throw new ForbiddenException(
        'This seat has no cover, so it cannot be left empty. Ask a coordinator ' +
        'if you need to step out.',
      );
    }

    const assignment = await this.prisma.sessionJudge.findFirst({
      where: { sessionId: body.sessionId, judgeId: judge.id },
    });
    if (!assignment) throw new NotFoundException('You are not on this session');

    // Either IG judge may step out; not both. One of them plus the PS is two
    // scorers, which is the floor. Both out would leave the PS scoring alone,
    // and a single judgement of a team is materially weaker than two.
    if (body.onBreak) {
      const otherIgOnBreak = await this.prisma.sessionJudge.findFirst({
        where: {
          sessionId: body.sessionId,
          judgeId: { not: judge.id },
          onBreak: true,
          judge: { judgeTier: { in: ['L2', 'L3', 'L4'] as any } },
        } as any,
        include: { judge: true },
      });

      if (otherIgOnBreak) {
        throw new BadRequestException(
          `${otherIgOnBreak.judge.name} has already stepped out of this session. ` +
          'Only one of you can — the team would otherwise be scored by one judge.',
        );
      }
    }

    const scorecard = await this.prisma.scorecard.findFirst({
      where: { sessionId: body.sessionId, judgeId: judge.id },
    });

    if (
      body.onBreak &&
      scorecard &&
      ['SUBMITTED', 'RESUBMITTED', 'LOCKED'].includes(scorecard.status)
    ) {
      throw new BadRequestException(
        'You have already submitted a score for this team. Ask a coordinator to ' +
        'reopen it if it should not count.',
      );
    }

    await this.prisma.sessionJudge.update({
      where: { id: assignment.id },
      data: {
        onBreak: body.onBreak,
        breakAt: body.onBreak ? new Date() : null,
      } as any,
    });

    // A draft written before stepping out is discarded. Keeping it would leave
    // a half-formed judgement of a session the judge did not see.
    if (body.onBreak && scorecard && scorecard.status === 'DRAFT') {
      await this.prisma.criterionScore.deleteMany({ where: { scorecardId: scorecard.id } });
      await this.prisma.scorecard.update({
        where: { id: scorecard.id },
        data: { status: 'NOT_STARTED', totalScore: null },
      });
    }

    // AUDIT-4. A break changes who scores a team, so it belongs in the record
    // alongside the scores themselves.
    await this.core.recordBreak({
      eventId,
      sessionId: body.sessionId,
      judgeId: judge.id,
      judgeName: judge.name,
      onBreak: body.onBreak,
      draftDiscarded: Boolean(
        body.onBreak && scorecard && scorecard.status === 'DRAFT',
      ),
      actorId: judge.id,
    });

    return { success: true, onBreak: body.onBreak };
  }

  @Public()
  @Post(':token/flag')
  async flagForReview(
    @Param('token') token: string,
    @Query('event') eventId: string,
    @Body() body: { scorecardId: string; flagged: boolean },
  ) {
    const judge = await this.service.getJudgeByToken(token, eventId);
    const scorecard = await this.prisma.scorecard.findUnique({ where: { id: body.scorecardId } });
    if (!scorecard) throw new NotFoundException('Scorecard not found');
    if (scorecard.judgeId !== judge.id) throw new ForbiddenException('This scorecard does not belong to you');

    await this.prisma.scorecard.update({
      where: { id: body.scorecardId },
      data: { flaggedForReview: body.flagged } as any,
    });
    return { success: true, flagged: body.flagged };
  }

  @Public()
  @Post(':token/score')
  async saveScore(
    @Param('token') token: string,
    @Query('event') eventId: string,
    @Body() body: {
      scorecardId: string;
      scores: Array<{ criterionId: string; score: number | null; comment?: string }>;
      overallStrengths?: string;
      areasForImprovement?: string;
      recommendation?: string;
      submit?: boolean;
    },
  ) {
    const judge = await this.service.getJudgeByToken(token, eventId);

    // Scoring itself lives in ScoringCoreService, shared with the GraphQL path.
    // This endpoint establishes who the judge is and hands over; it does not
    // reimplement validation, totalling, status transitions or audit. The two
    // implementations had drifted badly and the one judges used was the weaker.
    const result = await this.core.writeScores({
      scorecardId: body.scorecardId,
      eventId,
      scores: body.scores ?? [],
      overallStrengths: body.overallStrengths,
      areasForImprovement: body.areasForImprovement,
      recommendation: body.recommendation,
      submit: body.submit === true,
      actorId: judge.id,
      expectedJudgeId: judge.id,
      // conflictConfirmed deliberately not sent: no confirmation is presented
      // to a judge in this portal, and a column that always reads true is worse
      // than an empty one in a dispute.
    });

    return {
      success: true,
      message: result.submitted ? 'Scorecard submitted' : 'Draft saved',
      totalScore: result.totalScore,
      status: result.status,
      // Criterion ids accepted but not stored because they name a category —
      // a page a version behind the rubric. The judge is told rather than
      // being told everything saved when part of it did not.
      ignoredCriterionIds: result.ignoredCriterionIds,
    };
  }
}
