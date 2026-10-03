import { ObjectType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { TrackStatus } from '@prisma/client';

registerEnumType(TrackStatus, { name: 'TrackStatus' });

@ObjectType()
export class TrackEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => Int) displayOrder!: number;
  @Field(() => TrackStatus) status!: TrackStatus;
  @Field() createdAt!: Date;
  @Field() updatedAt!: Date;
  @Field(() => Int) teamCount!: number;
}

@InputType()
export class CreateTrackInput {
  @Field() eventId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
}

@InputType()
export class UpdateTrackInput {
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => TrackStatus, { nullable: true }) status?: TrackStatus;
}

@InputType()
export class ReorderTrackInput {
  @Field() id!: string;
  @Field(() => Int) displayOrder!: number;
}
