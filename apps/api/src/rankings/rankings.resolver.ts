import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { RankingsService } from './rankings.service';
import { RankingOutput } from './rankings.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver()
export class RankingsResolver {
  constructor(private service: RankingsService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => RankingOutput)
  async calculateRankings(
    @Args('eventId') eventId: string,
    @Args('trackId', { type: () => String, nullable: true }) trackId: string | null,
    @CurrentUser() user: any,
  ) {
    return this.service.calculateRankings(eventId, trackId, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Query(() => RankingOutput, { nullable: true })
  async rankings(
    @Args('eventId') eventId: string,
    @Args('trackId', { type: () => String, nullable: true }) trackId?: string,
  ) {
    return this.service.getRankings(eventId, trackId);
  }

  @Roles('ADMIN')
  @Mutation(() => RankingOutput, { nullable: true })
  async approveRankings(
    @Args('eventId') eventId: string,
    @Args('trackId', { type: () => String, nullable: true }) trackId: string | null,
    @CurrentUser() user: any,
  ) {
    return this.service.approveRankings(eventId, trackId, user.sub);
  }

  @Roles('ADMIN')
  @Mutation(() => RankingOutput, { nullable: true })
  async publishRankings(
    @Args('eventId') eventId: string,
    @Args('trackId', { type: () => String, nullable: true }) trackId: string | null,
    @CurrentUser() user: any,
  ) {
    return this.service.publishRankings(eventId, trackId, user.sub);
  }
}
