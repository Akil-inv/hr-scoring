import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { OperationsService } from './operations.service';
import {
  OperationResult, ReplacementJudge, SessionHealthCheck,
  SwapJudgeInput, ChangeRoomInput, RescheduleInput, MarkAbsentInput,
  AddJudgeInput, RemoveJudgeInput, SetJudgeBreakInput, CancelSessionInput, UpdateStageInput, SwapRoomsInput, SwapSessionsInput,
  OutstandingScoring, JudgeMessageEntity, MessageResult,
} from './operations.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver()
export class OperationsResolver {
  constructor(private service: OperationsService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async updateSessionStage(@Args('input') input: UpdateStageInput, @CurrentUser() user: any) {
    return this.service.updateStage(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async swapJudge(@Args('input') input: SwapJudgeInput, @CurrentUser() user: any) {
    return this.service.swapJudge(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async addJudgeToSession(@Args('input') input: AddJudgeInput, @CurrentUser() user: any) {
    return this.service.addJudge(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async cancelSession(@Args('input') input: CancelSessionInput, @CurrentUser() user: any) {
    return this.service.cancelSession(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async changeRoom(@Args('input') input: ChangeRoomInput, @CurrentUser() user: any) {
    return this.service.changeRoom(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async rescheduleSession(@Args('input') input: RescheduleInput, @CurrentUser() user: any) {
    return this.service.reschedule(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async markJudgeAbsent(@Args('input') input: MarkAbsentInput, @CurrentUser() user: any) {
    return this.service.markJudgeAbsent(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async swapRooms(@Args('input') input: SwapRoomsInput, @CurrentUser() user: any) {
    return this.service.swapRooms(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async swapTeams(@Args('sessionIdA') sessionIdA: string, @Args('sessionIdB') sessionIdB: string, @CurrentUser() user: any) {
    return this.service.swapTeams(sessionIdA, sessionIdB, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async swapSessions(@Args('input') input: SwapSessionsInput, @CurrentUser() user: any) {
    return this.service.swapSessions(input.sessionIdA, input.sessionIdB, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Query(() => [ReplacementJudge])
  async findReplacementJudges(@Args('sessionId') sessionId: string) {
    return this.service.findReplacementJudges(sessionId);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Query(() => [SessionHealthCheck])
  async sessionHealthCheck(@Args('eventId') eventId: string) {
    return this.service.healthCheck(eventId);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async setJudgeBreak(@Args('input') input: SetJudgeBreakInput, @CurrentUser() user: any) {
    return this.service.setJudgeBreak(input, user?.sub || user?.id);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationResult)
  async removeJudge(@Args('input') input: RemoveJudgeInput, @CurrentUser() user: any) {
    return this.service.removeJudge(input, user?.sub || user?.id);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => MessageResult)
  async messageJudges(
    @Args('eventId') eventId: string,
    @Args('judgeIds', { type: () => [String] }) judgeIds: string[],
    @Args('body') body: string,
    @CurrentUser() user: any,
  ) {
    return this.service.messageJudges(eventId, judgeIds, body, user?.name || user?.email || 'Coordinator');
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Query(() => [JudgeMessageEntity])
  async judgeMessages(@Args('eventId') eventId: string) {
    return this.service.judgeMessages(eventId);
  }

  @Query(() => [OutstandingScoring])
  async outstandingScoring(@Args('eventId') eventId: string) {
    return this.service.outstandingScoring(eventId);
  }
}
