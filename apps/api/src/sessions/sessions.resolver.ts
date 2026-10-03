import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { SessionsService } from './sessions.service';
import { SessionEntity, SaveScheduleInput } from './sessions.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver(() => SessionEntity)
export class SessionsResolver {
  constructor(private sessionsService: SessionsService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => [SessionEntity])
  async saveScheduleSessions(
    @Args({ name: 'inputs', type: () => [SaveScheduleInput] }) inputs: SaveScheduleInput[],
    @CurrentUser() user: any,
  ) {
    return this.sessionsService.saveFromSchedule(inputs, user.sub);
  }

  @Query(() => [SessionEntity])
  async sessions(@Args('eventId') eventId: string) {
    return this.sessionsService.findByEvent(eventId);
  }

  @Query(() => SessionEntity)
  async session(@Args('id') id: string) {
    return this.sessionsService.findOne(id);
  }
}
