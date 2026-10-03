import { ObjectType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { ScorecardStatus } from '@prisma/client';

registerEnumType(ScorecardStatus, { name: 'ScorecardStatus' });

@ObjectType()
export class CriterionScoreEntity {
  @Field() id!: string;
  @Field() criterionId!: string;
  @Field() criterionName!: string;
  @Field(() => Int) maxScore!: number;
  @Field({ nullable: true }) guidanceText?: string;
  @Field() requiresComment!: boolean;
  @Field(() => Int, { nullable: true }) displayOrder?: number;
  @Field(() => Int, { nullable: true }) score?: number;
  @Field({ nullable: true }) comment?: string;
}

@ObjectType()
export class ScorecardEntity {
  @Field() id!: string;
  @Field() sessionId!: string;
  @Field() judgeId!: string;
  @Field() judgeName!: string;
  @Field() teamId!: string;
  @Field() teamName!: string;
  @Field() projectName!: string;
  @Field(() => ScorecardStatus) status!: ScorecardStatus;
  @Field(() => Int, { nullable: true }) totalScore?: number;
  @Field({ nullable: true }) overallStrengths?: string;
  @Field({ nullable: true }) areasForImprovement?: string;
  @Field({ nullable: true }) recommendation?: string;
  @Field() conflictConfirmed!: boolean;
  @Field({ nullable: true }) submittedAt?: Date;
  @Field({ nullable: true }) reopenReason?: string;
  @Field(() => [CriterionScoreEntity]) criterionScores!: CriterionScoreEntity[];
}

@InputType()
export class CriterionScoreInput {
  @Field() criterionId!: string;
  @Field(() => Int) score!: number;
  @Field({ nullable: true }) comment?: string;
}

@InputType()
export class SaveScorecardInput {
  @Field() scorecardId!: string;
  @Field(() => [CriterionScoreInput]) scores!: CriterionScoreInput[];
  @Field({ nullable: true }) overallStrengths?: string;
  @Field({ nullable: true }) areasForImprovement?: string;
  @Field({ nullable: true }) recommendation?: string;
}

@InputType()
export class SubmitScorecardInput {
  @Field() scorecardId!: string;
  @Field() conflictConfirmed!: boolean;
}
