import { ObjectType, Field, InputType, Int } from '@nestjs/graphql';

@ObjectType()
export class OperationResult {
  @Field() success!: boolean;
  @Field() message!: string;
  @Field(() => [String]) warnings!: string[];
}

@ObjectType()
export class ReplacementJudge {
  @Field() judgeId!: string;
  @Field() judgeName!: string;
  @Field() judgeType!: string;
  @Field(() => Int) currentLoad!: number;
  @Field(() => Int) maxSessions!: number;
  @Field() isAvailable!: boolean;
  @Field() hasConflict!: boolean;
  @Field() isBusyInSlot!: boolean;
  @Field(() => Int) score!: number;
}

@ObjectType()
export class SessionHealthCheck {
  @Field() sessionId!: string;
  @Field() teamName!: string;
  @Field() roomName!: string;
  @Field() stage!: string;
  @Field(() => Int) judgesAssigned!: number;
  @Field(() => Int) judgesRequired!: number;
  @Field() isHealthy!: boolean;
  @Field(() => [String]) issues!: string[];
}

@InputType()
export class UpdateStageInput {
  @Field() sessionId!: string;
  @Field() stage!: string;
  @Field({ nullable: true }) notes?: string;
}

@InputType()
export class SwapJudgeInput {
  @Field() sessionId!: string;
  @Field() oldJudgeId!: string;
  @Field() newJudgeId!: string;
  @Field() reason!: string;
}

@InputType()
export class AddJudgeInput {
  @Field() sessionId!: string;
  @Field() judgeId!: string;
  @Field() reason!: string;
}

@InputType()
export class ChangeRoomInput {
  @Field() sessionId!: string;
  @Field() newRoomId!: string;
  @Field() reason!: string;
}

@InputType()
export class RescheduleInput {
  @Field() sessionId!: string;
  @Field() newTimeSlotId!: string;
  @Field({ nullable: true }) newRoomId?: string;
  @Field() reason!: string;
}

@InputType()
export class SetJudgeBreakInput {
  @Field() sessionId!: string;
  @Field() judgeId!: string;
  @Field() onBreak!: boolean;
}

@InputType()
export class MarkAbsentInput {
  @Field() judgeId!: string;
  @Field() eventId!: string;
  @Field() reason!: string;
}

@InputType()
export class RemoveJudgeInput {
  @Field() sessionId!: string;
  @Field() judgeId!: string;
}

@InputType()
export class CancelSessionInput {
  @Field() sessionId!: string;
  @Field() reason!: string;
}

@InputType()
export class SwapRoomsInput {
  @Field() sessionIdA!: string;
  @Field() sessionIdB!: string;
  @Field() reason!: string;
}

@InputType()
export class SwapSessionsInput {
  @Field() sessionIdA!: string;
  @Field() sessionIdB!: string;
}

@ObjectType()
export class JudgeMessageEntity {
  @Field() id!: string;
  @Field() judgeId!: string;
  @Field() judgeName!: string;
  @Field() body!: string;
  @Field() sentByName!: string;
  @Field() sentAt!: Date;
}

@ObjectType()
export class MessageResult {
  @Field(() => Int) sent!: number;
}

@ObjectType()
export class OutstandingScoring {
  @Field() judgeId!: string;
  @Field() judgeName!: string;
  @Field() judgeEmail!: string;
  @Field({ nullable: true }) judgePhone?: string;
  @Field(() => Int) outstanding!: number;
  @Field(() => Int) notStarted!: number;
  @Field(() => Int) inProgress!: number;
  @Field({ nullable: true }) oldestSessionAt?: string;
  @Field(() => [String]) teams!: string[];
}
