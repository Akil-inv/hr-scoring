import { ObjectType, Field, InputType, registerEnumType } from '@nestjs/graphql';
import { Role } from '@prisma/client';

registerEnumType(Role, { name: 'Role' });

@ObjectType()
export class UserResponse {
  @Field() id!: string;
  @Field() email!: string;
  @Field(() => Role) role!: Role;
}

@ObjectType()
export class LoginResponse {
  @Field() accessToken!: string;
  @Field(() => UserResponse) user!: UserResponse;
}

@InputType()
export class LoginInput {
  @Field() email!: string;
  @Field() password!: string;
}

@InputType()
export class RegisterInput {
  @Field() email!: string;
  @Field() password!: string;
  @Field(() => Role) role!: Role;
}
