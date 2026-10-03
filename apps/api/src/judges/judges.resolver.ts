import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { JudgesService } from './judges.service';
import { JudgeEntity, JudgeAvailabilityEntity, JudgeExpertiseEntity, CreateJudgeInput, UpdateJudgeInput, SetJudgeAvailabilityInput, SetJudgeExpertiseInput } from './judges.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver(() => JudgeEntity)
export class JudgesResolver {
  constructor(private judgesService: JudgesService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => JudgeEntity)
  async createJudge(@Args('input') input: CreateJudgeInput, @CurrentUser() user: any) {
    return this.judgesService.create(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => JudgeEntity)
  async updateJudge(@Args('id') id: string, @Args('input') input: UpdateJudgeInput, @CurrentUser() user: any) {
    return this.judgesService.update(id, input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => JudgeEntity)
  async deleteJudge(@Args('id') id: string, @CurrentUser() user: any) {
    return this.judgesService.deleteJudge(id, user.sub);
  }

  @Query(() => [JudgeEntity])
  async judges(
    @Args('eventId') eventId: string,
    @Args('judgeType', { nullable: true }) judgeType?: string,
    @Args('status', { nullable: true }) status?: string,
  ) {
    return this.judgesService.findAllByEvent(eventId, judgeType, status);
  }

  @Query(() => JudgeEntity)
  async judge(@Args('id') id: string) {
    return this.judgesService.findOne(id);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => JudgeAvailabilityEntity)
  async setJudgeAvailability(@Args('input') input: SetJudgeAvailabilityInput, @CurrentUser() user: any) {
    return this.judgesService.setAvailability(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => JudgeExpertiseEntity)
  async setJudgeExpertise(@Args('input') input: SetJudgeExpertiseInput, @CurrentUser() user: any) {
    return this.judgesService.setExpertise(input, user.sub);
  }
}
