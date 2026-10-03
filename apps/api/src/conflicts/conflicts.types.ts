import { ObjectType, Field, InputType, registerEnumType } from '@nestjs/graphql';
import { ConflictSource, ConflictDeclStatus } from '@prisma/client';

registerEnumType(ConflictSource, { name: 'ConflictSource' });
registerEnumType(ConflictDeclStatus, { name: 'ConflictDeclStatus' });

@ObjectType()
export class ConflictEntity {
  @Field() id!: string;
  @Field() eventId!: string;
  @Field() judgeId!: string;
  @Field() teamId!: string;
  @Field() judgeName!: string;
  @Field() teamName!: string;
  @Field() reason!: string;
  @Field(() => ConflictSource) source!: ConflictSource;
  @Field(() => ConflictDeclStatus) status!: ConflictDeclStatus;
  @Field() declaredByEmail!: string;
  @Field({ nullable: true }) resolvedByEmail?: string;
  @Field({ nullable: true }) resolvedAt?: Date;
  @Field() createdAt!: Date;
}

@InputType()
export class DeclareConflictInput {
  @Field() eventId!: string;
  @Field() judgeId!: string;
  @Field() teamId!: string;
  @Field() reason!: string;
  @Field(() => ConflictSource, { defaultValue: ConflictSource.ADMIN_IMPOSED }) source!: ConflictSource;
}
