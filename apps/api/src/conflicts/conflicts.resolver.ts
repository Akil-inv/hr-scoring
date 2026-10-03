import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { ConflictsService } from './conflicts.service';
import { ConflictEntity, DeclareConflictInput } from './conflicts.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver(() => ConflictEntity)
export class ConflictsResolver {
  constructor(private conflictsService: ConflictsService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => ConflictEntity)
  async declareConflict(
    @Args('input') input: DeclareConflictInput,
    @CurrentUser() user: any,
  ) {
    return this.conflictsService.declare(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => ConflictEntity)
  async resolveConflict(
    @Args('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.conflictsService.resolve(id, user.sub);
  }

  @Query(() => [ConflictEntity])
  async conflicts(@Args('eventId') eventId: string) {
    return this.conflictsService.findByEvent(eventId);
  }

  @Query(() => [ConflictEntity])
  async conflictsByJudge(@Args('judgeId') judgeId: string) {
    return this.conflictsService.findByJudge(judgeId);
  }

  @Query(() => [ConflictEntity])
  async conflictsByTeam(@Args('teamId') teamId: string) {
    return this.conflictsService.findByTeam(teamId);
  }
}
