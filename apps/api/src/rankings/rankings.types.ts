import { ObjectType, Field, Int, Float, registerEnumType } from '@nestjs/graphql';
import { RankingStatus } from '@prisma/client';

registerEnumType(RankingStatus, { name: 'RankingStatus' });

@ObjectType()
export class CriterionAverage {
  @Field() criterionId!: string;
  @Field() criterionName!: string;
  @Field(() => Float) average!: number;
  @Field(() => Int) maxScore!: number;
}

@ObjectType()
export class TeamRanking {
  @Field() teamId!: string;
  @Field() teamName!: string;
  @Field() projectName!: string;
  @Field({ nullable: true }) trackName?: string;
  @Field({ nullable: true }) trackId?: string;
  @Field(() => Int) rankPosition!: number;
  @Field(() => Float) aggregatedScore!: number;
  @Field(() => Int) judgeCount!: number;
  @Field(() => [CriterionAverage]) criterionAverages!: CriterionAverage[];
  @Field({ nullable: true }) tieBreakNote?: string;
  @Field({ nullable: true }) judgeNames?: string;
  /**
   * True only where a tie survived every tie-break — equal score, equal best
   * criterion average, equal judge count. A shared rank is then a stated
   * outcome for a coordinator to resolve, not an artefact of how the rows were
   * written.
   */
  @Field() tied!: boolean;
  /** Counted scorecards expected for this team, i.e. judges not on break. */
  @Field(() => Int) expectedJudgeCount!: number;
}

@ObjectType()
export class RankingOutput {
  @Field() eventId!: string;
  @Field({ nullable: true }) trackId?: string;
  @Field({ nullable: true }) trackName?: string;
  @Field(() => RankingStatus) status!: RankingStatus;
  @Field(() => [TeamRanking]) rankings!: TeamRanking[];
  @Field(() => Int) teamsRanked!: number;
  @Field(() => Int) teamsWithIncompleteScores!: number;
  @Field({ nullable: true }) calculatedAt?: string;
  /**
   * Conditions a coordinator must see before treating these standings as
   * final — a reopened scorecard, a team short of judges, a surviving tie.
   */
  @Field(() => [String]) warnings!: string[];
}
