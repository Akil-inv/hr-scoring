import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { TracksService } from './tracks.service';
import { TrackEntity, CreateTrackInput, UpdateTrackInput, ReorderTrackInput } from './tracks.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver(() => TrackEntity)
export class TracksResolver {
  constructor(private tracksService: TracksService) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => TrackEntity)
  async createTrack(
    @Args('input') input: CreateTrackInput,
    @CurrentUser() user: any,
  ) {
    return this.tracksService.create(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => TrackEntity)
  async updateTrack(
    @Args('id') id: string,
    @Args('input') input: UpdateTrackInput,
    @CurrentUser() user: any,
  ) {
    return this.tracksService.update(id, input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => [TrackEntity])
  async reorderTracks(
    @Args({ name: 'inputs', type: () => [ReorderTrackInput] }) inputs: ReorderTrackInput[],
    @CurrentUser() user: any,
  ) {
    return this.tracksService.reorder(inputs, user.sub);
  }

  @Query(() => [TrackEntity])
  async tracks(@Args('eventId') eventId: string) {
    return this.tracksService.findAllByEvent(eventId);
  }

  @Query(() => TrackEntity)
  async track(@Args('id') id: string) {
    return this.tracksService.findOne(id);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => TrackEntity)
  async deleteTrack(@Args('id') id: string, @CurrentUser() user: any) {
    return this.tracksService.delete(id, user.sub);
  }

}
