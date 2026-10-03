import { ObjectType, Field, InputType, Int, registerEnumType } from '@nestjs/graphql';
import { JudgeType, JudgeStatus, ExpertiseLevel } from '@prisma/client';

registerEnumType(JudgeType, { name: 'JudgeType' });
registerEnumType(JudgeStatus, { name: 'JudgeStatus' });
registerEnumType(ExpertiseLevel, { name: 'ExpertiseLevel' });

@ObjectType()
export class JudgeAvailabilityEntity {
  @Field() id!: string;
  @Field() date!: Date;
  @Field() startTime!: Date;
  @Field() endTime!: Date;
}

@ObjectType()
export class JudgeExpertiseEntity {
  @Field() id!: string;
  @Field() trackId!: string;
  @Field({ nullable: true }) trackName?: string;
  @Field(() => ExpertiseLevel) expertiseLevel!: ExpertiseLevel;
}

@ObjectType()
export class JudgeEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() name!: string;
  @Field() email!: string;
  @Field({ nullable: true }) phone?: string;
  @Field({ nullable: true }) organisation?: string;
  @Field({ nullable: true }) designation?: string;
  @Field(() => JudgeType) judgeType!: JudgeType;
  @Field({ nullable: true }) judgeTier?: string;
  @Field(() => Int) maxSessions!: number;
  @Field() isPanelChairEligible!: boolean;
  @Field(() => JudgeStatus) status!: JudgeStatus;
  @Field() createdAt!: Date;
  @Field(() => Int) availabilityCount!: number;
  @Field(() => Int) conflictCount!: number;
  @Field(() => [JudgeAvailabilityEntity], { nullable: true }) availability?: JudgeAvailabilityEntity[];
  @Field(() => [JudgeExpertiseEntity], { nullable: true }) expertise?: JudgeExpertiseEntity[];
}

@InputType()
export class CreateJudgeInput {
  @Field() eventId!: string;
  @Field() name!: string;
  @Field() email!: string;
  @Field({ nullable: true }) organisation?: string;
  @Field({ nullable: true }) designation?: string;
  @Field(() => JudgeType) judgeType!: JudgeType;
  @Field({ nullable: true }) judgeTier?: string;
  @Field(() => Int, { defaultValue: 10 }) maxSessions!: number;
  @Field({ defaultValue: false }) isPanelChairEligible!: boolean;
}

@InputType()
export class UpdateJudgeInput {
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) email?: string;
  @Field({ nullable: true }) organisation?: string;
  @Field({ nullable: true }) designation?: string;
  @Field(() => JudgeType, { nullable: true }) judgeType?: JudgeType;
  @Field(() => Int, { nullable: true }) maxSessions?: number;
  @Field({ nullable: true }) isPanelChairEligible?: boolean;
  @Field(() => JudgeStatus, { nullable: true }) status?: JudgeStatus;
}

@InputType()
export class SetJudgeAvailabilityInput {
  @Field() judgeId!: string;
  @Field() date!: Date;
  @Field() startTime!: string;
  @Field() endTime!: string;
}

@InputType()
export class SetJudgeExpertiseInput {
  @Field() judgeId!: string;
  @Field() trackId!: string;
  @Field(() => ExpertiseLevel, { defaultValue: ExpertiseLevel.PRIMARY }) expertiseLevel!: ExpertiseLevel;
}
