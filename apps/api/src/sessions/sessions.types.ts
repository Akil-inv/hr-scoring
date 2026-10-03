import { ObjectType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { SessionStage } from '@prisma/client';

registerEnumType(SessionStage, { name: 'SessionStage' });

@ObjectType()
export class SessionJudgeEntity {
  @Field() id!: string;
  @Field() judgeId!: string;
  /** The judge has stepped out of this session and will not score it. */
  @Field({ defaultValue: false }) onBreak?: boolean;
  /** Only an MD may take a break, so the control is shown by tier. */
  @Field({ nullable: true }) judgeTier?: string;
  @Field() judgeName!: string;
  @Field() attended!: boolean;
}

@ObjectType()
export class SessionEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() teamId!: string;
  @Field() teamName!: string;
  @Field() projectName!: string;
  @Field({ nullable: true }) trackName?: string;
  // Drives the day's logistics: country decides whether the room needs the
  // video link, platform decides which vendor is expected.
  @Field({ nullable: true }) teamCountry?: string;
  @Field({ nullable: true }) teamPlatform?: string;
  @Field() roomId!: string;
  @Field() roomName!: string;
  @Field() timeSlotId!: string;
  @Field(() => SessionStage) stage!: SessionStage;
  @Field({ nullable: true }) scheduledStart?: Date;
  @Field({ nullable: true }) scheduledEnd?: Date;
  @Field({ nullable: true }) actualStart?: Date;
  @Field({ nullable: true }) actualEnd?: Date;
  @Field(() => Int) delayMinutes!: number;
  @Field({ nullable: true }) delayReason?: string;
  @Field({ nullable: true }) notes?: string;
  @Field(() => [SessionJudgeEntity]) judges!: SessionJudgeEntity[];
  @Field(() => Int) scorecardsSubmitted!: number;
  @Field(() => Int) scorecardsTotal!: number;
  /** MDs who stepped out. Shown so a shorter panel has a visible reason. */
  @Field(() => Int, { defaultValue: 0 }) judgesOnBreak?: number;
}

@InputType()
export class SaveScheduleInput {
  @Field() eventId!: string;
  @Field() teamId!: string;
  @Field() roomId!: string;
  @Field() timeSlotId!: string;
  @Field(() => [String]) judgeIds!: string[];
}
