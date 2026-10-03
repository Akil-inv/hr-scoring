import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { TeamsService } from './teams.service';
import { TeamEntity, CreateTeamInput, UpdateTeamInput } from './teams.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver(() => TeamEntity)
export class TeamsResolver {
  constructor(private teamsService: TeamsService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => TeamEntity)
  async createTeam(@Args('input') input: CreateTeamInput, @CurrentUser() user: any) {
    return this.teamsService.create(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => TeamEntity)
  async updateTeam(@Args('id') id: string, @Args('input') input: UpdateTeamInput, @CurrentUser() user: any) {
    return this.teamsService.update(id, input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => TeamEntity)
  async deleteTeam(@Args('id') id: string, @CurrentUser() user: any) {
    return this.teamsService.delete(id, user.sub);
  }

  @Query(() => [TeamEntity])
  async teams(
    @Args('eventId') eventId: string,
    @Args('trackId', { nullable: true }) trackId?: string,
    @Args('status', { nullable: true }) status?: string,
  ) {
    return this.teamsService.findAllByEvent(eventId, trackId, status);
  }

  @Query(() => TeamEntity)
  async team(@Args('id') id: string) {
    return this.teamsService.findOne(id);
  }
}
