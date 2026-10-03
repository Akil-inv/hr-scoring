import { ObjectType, Field, InputType, registerEnumType } from '@nestjs/graphql';
import { TeamStatus, PresentationMode } from '@prisma/client';

registerEnumType(TeamStatus, { name: 'TeamStatus' });
registerEnumType(PresentationMode, { name: 'PresentationMode' });

@ObjectType()
export class TeamMemberEntity {
  @Field() id!: string;
  @Field() name!: string;
  @Field({ nullable: true }) email?: string;
  @Field({ nullable: true }) roleInTeam?: string;
}

@ObjectType()
export class TeamEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field({ nullable: true }) trackId?: string;
  @Field({ nullable: true }) trackName?: string;
  @Field() name!: string;
  @Field() projectName!: string;
  @Field({ nullable: true }) useCaseTitle?: string;
  @Field({ nullable: true }) problemStatement?: string;
  @Field({ nullable: true }) solutionSummary?: string;
  @Field({ nullable: true }) techStack?: string;
  @Field({ nullable: true }) platform?: string;
  @Field({ nullable: true }) country?: string;
  @Field({ nullable: true }) department?: string;
  @Field({ nullable: true }) useCategory?: string;
  @Field({ nullable: true }) vendorTools?: string;
  @Field({ nullable: true }) organisation?: string;
  @Field() teamLeadName!: string;
  @Field() teamLeadEmail!: string;
  @Field(() => PresentationMode) presentationMode!: PresentationMode;
  @Field(() => TeamStatus) status!: TeamStatus;
  @Field({ nullable: true }) eligibilityNotes?: string;
  @Field() createdAt!: Date;
  @Field(() => [TeamMemberEntity], { nullable: true }) members?: TeamMemberEntity[];
}

@InputType()
export class CreateTeamInput {
  @Field() eventId!: string;
  @Field({ nullable: true }) trackId?: string;
  @Field() name!: string;
  @Field() projectName!: string;
  @Field({ nullable: true }) useCaseTitle?: string;
  @Field({ nullable: true }) problemStatement?: string;
  @Field({ nullable: true }) solutionSummary?: string;
  @Field({ nullable: true }) techStack?: string;
  @Field({ nullable: true }) department?: string;
  @Field({ nullable: true }) useCategory?: string;
  @Field({ nullable: true }) vendorTools?: string;
  @Field({ nullable: true }) organisation?: string;
  @Field({ nullable: true }) country?: string;
  @Field() teamLeadName!: string;
  @Field() teamLeadEmail!: string;
  @Field(() => PresentationMode, { defaultValue: PresentationMode.IN_PERSON }) presentationMode!: PresentationMode;
}

@InputType()
export class UpdateTeamInput {
  @Field({ nullable: true }) trackId?: string;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) projectName?: string;
  @Field({ nullable: true }) useCaseTitle?: string;
  @Field({ nullable: true }) problemStatement?: string;
  @Field({ nullable: true }) solutionSummary?: string;
  @Field({ nullable: true }) techStack?: string;
  @Field({ nullable: true }) department?: string;
  @Field({ nullable: true }) useCategory?: string;
  @Field({ nullable: true }) vendorTools?: string;
  @Field({ nullable: true }) organisation?: string;
  @Field({ nullable: true }) country?: string;
  @Field({ nullable: true }) teamLeadName?: string;
  @Field({ nullable: true }) teamLeadEmail?: string;
  @Field(() => PresentationMode, { nullable: true }) presentationMode?: PresentationMode;
  @Field(() => TeamStatus, { nullable: true }) status?: TeamStatus;
  @Field({ nullable: true }) eligibilityNotes?: string;
}
