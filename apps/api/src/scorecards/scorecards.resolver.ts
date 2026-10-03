import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { ScorecardsService } from './scorecards.service';
import { ScorecardEntity, SaveScorecardInput, SubmitScorecardInput } from './scorecards.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver(() => ScorecardEntity)
export class ScorecardsResolver {
  constructor(private service: ScorecardsService) {}

  @Query(() => [ScorecardEntity])
  async scorecardsByJudge(
    @Args('judgeId') judgeId: string,
    @Args('eventId') eventId: string,
  ) {
    return this.service.findByJudge(judgeId, eventId);
  }

  @Query(() => [ScorecardEntity])
  async scorecardsByTeam(@Args('teamId') teamId: string) {
    return this.service.findByTeam(teamId);
  }

  @Query(() => ScorecardEntity)
  async scorecard(@Args('id') id: string) {
    return this.service.findOne(id);
  }

  @Query(() => [ScorecardEntity])
  async scorecardsByEvent(@Args('eventId') eventId: string) {
    return this.service.findByEvent(eventId);
  }

  @Mutation(() => ScorecardEntity)
  async saveScorecardDraft(
    @Args('input') input: SaveScorecardInput,
    @CurrentUser() user: any,
  ) {
    return this.service.saveDraft(input, user.sub);
  }

  @Mutation(() => ScorecardEntity)
  async submitScorecard(
    @Args('input') input: SubmitScorecardInput,
    @CurrentUser() user: any,
  ) {
    return this.service.submit(input, user.sub);
  }

  @Roles('ADMIN')
  @Mutation(() => ScorecardEntity)
  async reopenScorecard(
    @Args('scorecardId') scorecardId: string,
    @Args('reason') reason: string,
    @CurrentUser() user: any,
  ) {
    return this.service.reopen(scorecardId, reason, user.sub);
  }

  @Roles('ADMIN')
  @Mutation(() => ScorecardEntity)
  async lockScorecard(
    @Args('scorecardId') scorecardId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.lock(scorecardId, user.sub);
  }
}
