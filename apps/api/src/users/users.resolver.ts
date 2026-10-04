import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { UsersService } from './users.service';
import { EventControlService } from '../event-control/event-control.service';
import { Roles } from '../auth/roles.decorator';
import { NotEventScoped } from '../auth/event-access';
import { CurrentUser } from '../auth/current-user.decorator';
import { ObjectType, Field, InputType, Int } from '@nestjs/graphql';

@ObjectType()
export class UserEntity {
  @Field() id!: string;
  @Field() email!: string;
  @Field() name!: string;
  @Field() role!: string;
}

/** An event the caller is on, with what the pages need to work on it, and their role there. */
@ObjectType()
export class MyEvent {
  @Field() id!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) location?: string;
  @Field() timezone!: string;
  @Field() startDate!: Date;
  @Field() endDate!: Date;
  @Field() status!: string;
  @Field() setupMode!: string;
  @Field(() => Int) sessionDurationMinutes!: number;
  @Field(() => Int) minJudgesPerTeam!: number;
  @Field(() => Int) maxJudgesPerTeam!: number;
  @Field({ nullable: true }) doneAt?: Date;
  /** Role on this event: ADMIN, COORDINATOR, PANEL_CHAIR or AUDITOR (super admins: ADMIN). */
  @Field() role!: string;
}

/** A user's role on one specific event, plus enough identity to render a row. */
@ObjectType()
export class EventUserEntity {
  @Field() userId!: string;
  @Field() email!: string;
  @Field() name!: string;
  /** Platform-wide role from the Role enum. */
  @Field() globalRole!: string;
  /** Role on this event, from the EventRole enum. */
  @Field() role!: string;
}

@InputType()
export class CreateUserInput {
  @Field() email!: string;
  /** Ignored: new accounts choose their own password from an invite link. Kept so older clients still work. */
  @Field({ nullable: true }) password?: string;
  @Field() name!: string;
  @Field({ nullable: true }) phone?: string;
  @Field({ nullable: true }) globalRole?: string;
}

@InputType()
export class AssignEventRoleInput {
  @Field() userId!: string;
  @Field() eventId!: string;
  @Field() role!: string;
}

@Resolver()
export class UsersResolver {
  constructor(private usersService: UsersService, private control: EventControlService) {}

  @NotEventScoped()
  @Roles('SUPER_ADMIN')
  @Mutation(() => UserEntity)
  async createUser(@Args('input') input: CreateUserInput) {
    return this.usersService.createUser(input);
  }

  @NotEventScoped()
  @Roles('SUPER_ADMIN')
  @Query(() => [UserEntity])
  async users() {
    return this.usersService.listUsers();
  }

  @Roles('SUPER_ADMIN')
  @Query(() => [EventUserEntity])
  async eventUsers(@Args('eventId') eventId: string) {
    return this.usersService.listEventUsers(eventId);
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => Boolean)
  async assignEventRole(@Args('input') input: AssignEventRoleInput, @CurrentUser() user: any) {
    await this.control.assign(input.eventId, input.userId, input.role, user);
    return true;
  }

  @Roles('SUPER_ADMIN')
  @Mutation(() => Boolean)
  async removeEventRole(@Args('userId') userId: string, @Args('eventId') eventId: string, @CurrentUser() user: any) {
    await this.control.removePerson(eventId, userId, user);
    return true;
  }

  // Deleting users and resetting passwords are in auth-kit (/api/auth/admin/...):
  // reset links instead of admin-set passwords, and sessions end.

  @NotEventScoped()
  @Query(() => [MyEvent])
  async myEvents(@CurrentUser() user: any) {
    return this.usersService.getMyEvents(user.sub);
  }
}
