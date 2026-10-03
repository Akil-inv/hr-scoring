import { ObjectType, Field, Int } from '@nestjs/graphql';

@ObjectType()
export class JudgingRoundType {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() name!: string;
  @Field(() => Int) roundNumber!: number;
  @Field() status!: string;
  @Field(() => [String]) allowedTiers!: string[];
  @Field(() => Int, { nullable: true }) teamCount?: number;
  @Field(() => Int, { nullable: true }) advanceCount?: number;
}
