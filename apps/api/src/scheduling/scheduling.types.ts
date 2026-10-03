import { ObjectType, Field, InputType, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class SessionAssignment {
  @Field() teamId!: string;
  @Field() teamName!: string;
  @Field() roomId!: string;
  @Field() roomName!: string;
  @Field() slotId!: string;
  @Field() slotDate!: string;
  @Field() slotStart!: string;
  @Field() slotEnd!: string;
  @Field(() => [String]) judgeIds!: string[];
  @Field(() => [String]) judgeNames!: string[];
}

@ObjectType()
export class ScheduleResult {
  @Field() success!: boolean;
  @Field(() => [SessionAssignment]) sessions!: SessionAssignment[];
  @Field(() => [String]) unscheduledTeams!: string[];
  @Field(() => [String]) warnings!: string[];
  @Field(() => Float) qualityScore!: number;
  @Field(() => Float) solveTimeSeconds!: number;
}

@InputType()
export class GenerateScheduleInput {
  @Field() eventId!: string;
  @Field(() => Int, { defaultValue: 3 }) minJudgesPerTeam!: number;
  @Field(() => Int, { defaultValue: 5 }) maxJudgesPerTeam!: number;
  /**
   * Guided scheduling: anchor an L2 and a PS to each room for the day, hold
   * vendors back for a coordinator to invite, and fill only the third seat.
   *
   * Off by default. The scheduler behaves exactly as it did before anchoring
   * existed, so there is always a way back if guided output looks wrong.
   */
  @Field({ defaultValue: false }) guided!: boolean;
}
