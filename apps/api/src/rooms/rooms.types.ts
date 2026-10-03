import { ObjectType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { RoomStatus, SlotType } from '@prisma/client';

registerEnumType(RoomStatus, { name: 'RoomStatus' });
registerEnumType(SlotType, { name: 'SlotType' });

@ObjectType()
export class RoomEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() name!: string;
  @Field(() => Int, { nullable: true }) capacity?: number;
  @Field({ nullable: true }) locationDescription?: string;
  @Field() isVirtual!: boolean;
  @Field() hasVideoConferencing!: boolean;
  @Field(() => RoomStatus) status!: RoomStatus;
  @Field() createdAt!: Date;
}

@InputType()
export class CreateRoomInput {
  @Field() eventId!: string;
  @Field() name!: string;
  @Field(() => Int, { nullable: true }) capacity?: number;
  @Field({ nullable: true }) locationDescription?: string;
  @Field({ defaultValue: false }) isVirtual!: boolean;
  @Field({ defaultValue: false }) hasVideoConferencing!: boolean;
}

@InputType()
export class UpdateRoomInput {
  @Field({ nullable: true }) name?: string;
  @Field(() => Int, { nullable: true }) capacity?: number;
  @Field({ nullable: true }) locationDescription?: string;
  @Field({ nullable: true }) isVirtual?: boolean;
  @Field({ nullable: true }) hasVideoConferencing?: boolean;
  @Field(() => RoomStatus, { nullable: true }) status?: RoomStatus;
}

@ObjectType()
export class OperationOk {
  @Field() success!: boolean;
}

@ObjectType()
export class RoomUnavailabilityEntity {
  @Field() id!: string;
  @Field() roomId!: string;
  @Field() date!: Date;
  @Field() session!: string;
  @Field({ nullable: true }) reason?: string;
}

@ObjectType()
export class TimeSlotEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() date!: Date;
  @Field() startTime!: Date;
  @Field() endTime!: Date;
  @Field(() => SlotType) slotType!: SlotType;
  @Field() createdAt!: Date;
}

@InputType()
export class RoomHalfDayInput {
  @Field() roomId!: string;
  /// 'AM' or 'PM'.
  @Field() session!: string;
  @Field({ nullable: true }) reason?: string;
}

@InputType()
export class GenerateTimeSlotsInput {
  @Field() eventId!: string;
  @Field() date!: Date;
  /// Rooms that cannot be used for part of this day. Empty means all rooms are
  /// available, which is the ordinary case.
  @Field(() => [RoomHalfDayInput], { nullable: true })
  unavailableRooms?: RoomHalfDayInput[];
  @Field() operatingStart!: string;
  @Field() operatingEnd!: string;
  /// @deprecated Ignored. Session duration is derived from the event
  /// (event.sessionDurationMinutes) so slot length and the schedule can never
  /// disagree with event setup. Retained as optional only so existing clients
  /// that still send it do not fail validation.
  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Derived from event.sessionDurationMinutes; value is ignored.',
  })
  sessionDurationMinutes?: number;
  /// @deprecated Ignored. Sessions run back-to-back with no break so slot
  /// length reflects the event's session duration exactly. Retained as optional
  /// only so existing clients that still send it do not fail validation.
  @Field(() => Int, {
    nullable: true,
    deprecationReason: 'Ignored; sessions are generated back-to-back with no break.',
  })
  breakDurationMinutes?: number;
  @Field({ nullable: true }) lunchStart?: string;
  @Field({ nullable: true }) lunchEnd?: string;
}
