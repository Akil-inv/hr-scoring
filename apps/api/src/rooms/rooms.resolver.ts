import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { RoomsService } from './rooms.service';
import { TimeSlotsService } from './time-slots.service';
import { RoomEntity, CreateRoomInput, UpdateRoomInput, TimeSlotEntity, GenerateTimeSlotsInput, RoomUnavailabilityEntity, OperationOk } from './rooms.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';

@Resolver()
export class RoomsResolver {
  constructor(
    private roomsService: RoomsService,
    private timeSlotsService: TimeSlotsService,
    private prisma: PrismaService,
  ) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => RoomEntity)
  async createRoom(@Args('input') input: CreateRoomInput, @CurrentUser() user: any) {
    return this.roomsService.create(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => RoomEntity)
  async updateRoom(@Args('id') id: string, @Args('input') input: UpdateRoomInput, @CurrentUser() user: any) {
    return this.roomsService.update(id, input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => RoomEntity)
  async deleteRoom(@Args('id') id: string, @CurrentUser() user: any) {
    return this.roomsService.delete(id, user.sub);
  }

  @Query(() => [RoomEntity])
  async rooms(@Args('eventId') eventId: string) {
    return this.roomsService.findAllByEvent(eventId);
  }

  @Query(() => RoomEntity)
  async room(@Args('id') id: string) {
    return this.roomsService.findOne(id);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => [TimeSlotEntity])
  async generateTimeSlots(@Args('input') input: GenerateTimeSlotsInput, @CurrentUser() user: any) {
    return this.timeSlotsService.generate(input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => Boolean)
  async clearTimeSlots(
    @Args('eventId') eventId: string,
    @Args('date') date: string,
    @CurrentUser() user: any,
  ) {
    const dateStart = new Date(date + 'T00:00:00.000Z');
    const dateEnd = new Date(date + 'T23:59:59.999Z');
    await this.prisma.timeSlot.deleteMany({
      where: { eventId, date: { gte: dateStart, lte: dateEnd } },
    });
    return true;
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => OperationOk)
  async setRoomAvailability(
    @Args('eventId') eventId: string,
    @Args('roomId') roomId: string,
    @Args('date') date: Date,
    @Args('session') session: string,
    @Args('unavailable') unavailable: boolean,
    @CurrentUser() user: any,
  ) {
    return this.timeSlotsService.setRoomAvailability(
      eventId, roomId, date, session, unavailable, user?.sub || user?.id,
    );
  }

  @Query(() => [RoomUnavailabilityEntity])
  async roomUnavailability(@Args('eventId') eventId: string) {
    return this.timeSlotsService.unavailabilityByEvent(eventId);
  }

  @Query(() => [TimeSlotEntity])
  async timeSlots(
    @Args('eventId') eventId: string,
    @Args('date', { nullable: true }) date?: Date,
  ) {
    if (date) return this.timeSlotsService.findByEventAndDate(eventId, date);
    return this.timeSlotsService.findAllByEvent(eventId);
  }
}
