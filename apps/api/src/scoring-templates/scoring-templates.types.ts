import { ObjectType, Field, InputType, Int, Float, registerEnumType } from '@nestjs/graphql';
import { ScoringTemplateStatus } from '@prisma/client';
import { GraphQLJSON } from 'graphql-type-json';

registerEnumType(ScoringTemplateStatus, { name: 'ScoringTemplateStatus' });

@ObjectType()
export class ScoringCriterionEntity {
  @Field() id!: string;
  @Field() templateId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => Int) maxScore!: number;
  @Field(() => Float) weight!: number;
  @Field(() => Int) displayOrder!: number;
  @Field({ nullable: true }) guidanceText?: string;
  @Field(() => GraphQLJSON, { nullable: true }) scoringAnchors?: any;
  @Field() requiresComment!: boolean;
  @Field(() => Float) scoreIncrement!: number;
  /** Null for a category, set for a scoring row. */
  @Field({ nullable: true }) parentId?: string;
  /** Sum of this category's rows. Zero for a row. */
  @Field(() => Int) childrenTotal!: number;
}

@ObjectType()
export class ScoringLockState {
  @Field() locked!: boolean;
  @Field(() => Int) submittedCount!: number;
}

@ObjectType()
export class ScoringTemplateEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => Int) maxTotal!: number;
  @Field(() => ScoringTemplateStatus) status!: ScoringTemplateStatus;
  @Field() createdAt!: Date;
  @Field(() => [ScoringCriterionEntity]) criteria!: ScoringCriterionEntity[];
  @Field(() => Int) criteriaTotal!: number;
}

@InputType()
export class CreateScoringTemplateInput {
  @Field() eventId!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
}

@InputType()
export class UpdateScoringTemplateInput {
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => ScoringTemplateStatus, { nullable: true }) status?: ScoringTemplateStatus;
}

@InputType()
export class AddCriterionInput {
  @Field() templateId!: string;
  /** Omit to create a category, set to add a row beneath one. */
  @Field({ nullable: true }) parentId?: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => Int) maxScore!: number;
  @Field(() => Float, { defaultValue: 1.0 }) weight!: number;
  @Field({ nullable: true }) guidanceText?: string;
  @Field(() => GraphQLJSON, { nullable: true }) scoringAnchors?: any;
  @Field({ defaultValue: false }) requiresComment!: boolean;
  @Field(() => Float, { defaultValue: 1.0 }) scoreIncrement!: number;
}

@InputType()
export class UpdateCriterionInput {
  /** Set to move a row to a different category. */
  @Field({ nullable: true }) parentId?: string;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => Int, { nullable: true }) maxScore?: number;
  @Field(() => Float, { nullable: true }) weight?: number;
  @Field({ nullable: true }) guidanceText?: string;
  @Field(() => GraphQLJSON, { nullable: true }) scoringAnchors?: any;
  @Field({ nullable: true }) requiresComment?: boolean;
  @Field(() => Float, { nullable: true }) scoreIncrement?: number;
}

@InputType()
export class ReorderCriterionInput {
  @Field() id!: string;
  @Field(() => Int) displayOrder!: number;
}

@ObjectType()
export class LoadRubricResult {
  @Field() templateId!: string;
  @Field(() => Int) categoriesCreated!: number;
  @Field(() => Int) rowsCreated!: number;
}
