import { ObjectType, Field, registerEnumType } from '@nestjs/graphql';
import { AuditAction } from '@prisma/client';
import { GraphQLJSON } from 'graphql-type-json';

registerEnumType(AuditAction, { name: 'AuditAction' });

@ObjectType()
export class AuditUser {
  @Field() id!: string;
  @Field() email!: string;
  @Field() role!: string;
}

@ObjectType()
export class AuditJudge {
  @Field() id!: string;
  @Field() name!: string;
}

@ObjectType()
export class AuditLogEntry {
  @Field() id!: string;
  @Field({ nullable: true }) eventId?: string;
  @Field({ nullable: true }) userId?: string;
  /** Set when a judge did it through their link (they have no user account). */
  @Field({ nullable: true }) judgeId?: string;
  @Field(() => AuditAction) action!: AuditAction;
  @Field() entityType!: string;
  @Field() entityId!: string;
  @Field(() => GraphQLJSON, { nullable: true }) oldValues?: any;
  @Field(() => GraphQLJSON, { nullable: true }) newValues?: any;
  @Field({ nullable: true }) reason?: string;
  @Field() createdAt!: Date;
  @Field(() => AuditUser, { nullable: true }) user?: AuditUser;
  @Field(() => AuditJudge, { nullable: true }) judge?: AuditJudge;
}
