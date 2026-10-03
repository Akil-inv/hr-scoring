import { ObjectType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { EventStatus } from '@prisma/client';

registerEnumType(EventStatus, { name: 'EventStatus' });

@ObjectType()
export class EventEntity {
  @Field() id!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) location?: string;
  @Field() timezone!: string;
  @Field() startDate!: Date;
  @Field() endDate!: Date;
  @Field({ nullable: true }) judgingStart?: Date;
  @Field({ nullable: true }) judgingEnd?: Date;
  @Field(() => Int) sessionDurationMinutes!: number;
  @Field(() => Int) presentationDurationMinutes!: number;
  @Field(() => Int) qaDurationMinutes!: number;
  @Field(() => Int) scoringDurationMinutes!: number;
  @Field(() => Int) transitionBufferMinutes!: number;
  @Field(() => Int) minJudgesPerTeam!: number;
  @Field(() => Int) maxJudgesPerTeam!: number;
  @Field(() => EventStatus) status!: EventStatus;
  @Field() createdAt!: Date;
  @Field() updatedAt!: Date;
}

@InputType()
export class CreateEventInput {
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) location?: string;
  @Field({ defaultValue: 'UTC' }) timezone!: string;
  @Field() startDate!: Date;
  @Field() endDate!: Date;
  @Field({ nullable: true }) judgingStart?: Date;
  @Field({ nullable: true }) judgingEnd?: Date;
  @Field(() => Int, { defaultValue: 20 }) sessionDurationMinutes!: number;
  @Field(() => Int, { defaultValue: 10 }) presentationDurationMinutes!: number;
  @Field(() => Int, { defaultValue: 5 }) qaDurationMinutes!: number;
  @Field(() => Int, { defaultValue: 3 }) scoringDurationMinutes!: number;
  @Field(() => Int, { defaultValue: 2 }) transitionBufferMinutes!: number;
  @Field(() => Int, { defaultValue: 3 }) minJudgesPerTeam!: number;
  @Field(() => Int, { defaultValue: 5 }) maxJudgesPerTeam!: number;
}

@InputType()
export class UpdateEventInput {
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) location?: string;
  @Field({ nullable: true }) timezone?: string;
  @Field({ nullable: true }) startDate?: Date;
  @Field({ nullable: true }) endDate?: Date;
  @Field({ nullable: true }) judgingStart?: Date;
  @Field({ nullable: true }) judgingEnd?: Date;
  @Field(() => Int, { nullable: true }) sessionDurationMinutes?: number;
  @Field(() => Int, { nullable: true }) presentationDurationMinutes?: number;
  @Field(() => Int, { nullable: true }) qaDurationMinutes?: number;
  @Field(() => Int, { nullable: true }) scoringDurationMinutes?: number;
  @Field(() => Int, { nullable: true }) transitionBufferMinutes?: number;
  @Field(() => Int, { nullable: true }) minJudgesPerTeam?: number;
  @Field(() => Int, { nullable: true }) maxJudgesPerTeam?: number;
  @Field(() => EventStatus, { nullable: true }) status?: EventStatus;
}
