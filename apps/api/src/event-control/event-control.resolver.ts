import { Args, Context, Field, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { GraphQLISODateTime } from '@nestjs/graphql';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { AllowedWhenDone, NotEventScoped } from '../auth/event-access';
import { EventControlService } from './event-control.service';

@ObjectType()
export class EventPerson {
  @Field() userId!: string;
  @Field() name!: string;
  @Field() email!: string;
}

@ObjectType()
export class EventMember extends EventPerson {
  @Field() role!: string;
  @Field(() => GraphQLISODateTime) addedAt!: Date;
  @Field(() => String, { nullable: true }) addedBy!: string | null;
}

@ObjectType()
export class EventProgress {
  @Field(() => Int) candidates!: number;
  @Field(() => Int) interviewsDone!: number;
  @Field(() => Int) interviewsTotal!: number;
  @Field(() => Int) daysClosed!: number;
  @Field(() => Int) daysTotal!: number;
}

@ObjectType()
export class EventChange {
  @Field(() => GraphQLISODateTime) at!: Date;
  @Field() by!: string;
  @Field() what!: string;
}

@ObjectType()
export class ControlledEvent {
  @Field() id!: string;
  @Field() name!: string;
  @Field(() => String, { nullable: true }) description!: string | null;
  @Field() status!: string;
  /** DRAFT, ACTIVE, CLOSED, ARCHIVED or DONE. */
  @Field() stage!: string;
  @Field() setupMode!: string;
  @Field(() => GraphQLISODateTime) startDate!: Date;
  @Field(() => GraphQLISODateTime) endDate!: Date;
  @Field(() => GraphQLISODateTime, { nullable: true }) closedAt!: Date | null;
  @Field(() => GraphQLISODateTime, { nullable: true }) doneAt!: Date | null;
  @Field(() => Int) retentionMonths!: number;
  @Field(() => Int) retentionExtraMonths!: number;
  @Field(() => GraphQLISODateTime, { nullable: true }) retainUntil!: Date | null;
  /** Retention is over and nobody has extended it or marked the event done. */
  @Field() due!: boolean;
  @Field(() => GraphQLISODateTime) createdAt!: Date;
  /** The caller's role on it, or null if not on it. */
  @Field(() => String, { nullable: true }) myRole!: string | null;
  @Field() onEvent!: boolean;
  @Field(() => [EventPerson]) admins!: EventPerson[];
  @Field(() => EventProgress, { nullable: true }) progress!: EventProgress | null;
}

@ObjectType()
export class EventControlDetail extends ControlledEvent {
  @Field(() => [EventMember]) people!: EventMember[];
  @Field(() => [EventChange]) recentChanges!: EventChange[];
  @Field(() => [String]) doneRemoves!: string[];
  @Field(() => [String]) doneKeeps!: string[];
}

@InputType()
export class NewEventInput {
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => GraphQLISODateTime) startDate!: Date;
  @Field(() => GraphQLISODateTime) endDate!: Date;
  @Field({ nullable: true }) timezone?: string;
  /** UPLOAD (Excel workbook) or WIZARD. */
  @Field({ nullable: true }) setupMode?: string;
  /** 3, 4, 5 or 6 months after the event closes. */
  @Field(() => Int, { nullable: true }) retentionMonths?: number;
  /** Staff accounts to add as admins alongside the creator. */
  @Field(() => [String], { nullable: true }) coAdminUserIds?: string[];
}

const ANY_STAFF = ['ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR'];

/**
 * Event Control. The list of events (with their admins) is open to all staff;
 * an event's own page and changes to it go through the event-scope guard, so
 * only the people on it get there, and @Roles is checked against their role
 * on that event.
 */
@Resolver()
export class EventControlResolver {
  constructor(private service: EventControlService) {}

  @NotEventScoped()
  @Roles(...ANY_STAFF)
  @Query(() => [ControlledEvent])
  eventDirectory(@CurrentUser() user: any) {
    return this.service.directory(user);
  }

  @Roles(...ANY_STAFF)
  @Query(() => EventControlDetail)
  eventControl(@Args('eventId') eventId: string, @CurrentUser() user: any, @Context() ctx: any) {
    return this.service.detail(eventId, user, ctx.req.eventAccess.role);
  }

  @Roles('ADMIN')
  @Query(() => [EventPerson])
  eventPeopleSearch(@Args('eventId') eventId: string, @Args('query') query: string) {
    return this.service.searchPeople(eventId, query);
  }

  /** For choosing co-admins while creating an event (before there is an event to search within). */
  @NotEventScoped()
  @Roles('ADMIN')
  @Query(() => [EventPerson])
  staffSearch(@Args('query') query: string, @CurrentUser() user: any) {
    return this.service.searchStaff(query, user.sub);
  }

  /** Platform admins (and super admins) create events; the creator becomes the event's first admin. */
  @NotEventScoped()
  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async createControlledEvent(@Args('input') input: NewEventInput, @CurrentUser() user: any) {
    const e = await this.service.create({ ...input, coAdminIds: input.coAdminUserIds }, user);
    return { ...e, myRole: 'ADMIN', onEvent: true, admins: [], progress: null };
  }

  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async startEvent(@Args('eventId') eventId: string, @CurrentUser() user: any) {
    return this.wrap(await this.service.start(eventId, user));
  }

  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async closeControlledEvent(@Args('eventId') eventId: string, @CurrentUser() user: any) {
    return this.wrap(await this.service.close(eventId, user));
  }

  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async archiveEvent(@Args('eventId') eventId: string, @CurrentUser() user: any) {
    return this.wrap(await this.service.archive(eventId, user));
  }

  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async setEventRetention(@Args('eventId') eventId: string, @Args('months', { type: () => Int }) months: number, @CurrentUser() user: any) {
    return this.wrap(await this.service.setRetention(eventId, months, user));
  }

  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async extendEventRetention(
    @Args('eventId') eventId: string,
    @Args('months', { type: () => Int }) months: number,
    @Args('reason') reason: string,
    @CurrentUser() user: any,
  ) {
    return this.wrap(await this.service.extendRetention(eventId, months, reason, user));
  }

  @Roles('ADMIN')
  @Mutation(() => ControlledEvent)
  async markEventDone(
    @Args('eventId') eventId: string,
    @Args('confirmName') confirmName: string,
    @Args('password') password: string,
    @CurrentUser() user: any,
  ) {
    return this.wrap(await this.service.markDone(eventId, confirmName, password, user));
  }

  @AllowedWhenDone()
  @Roles('ADMIN')
  @Mutation(() => Boolean)
  addEventPerson(@Args('eventId') eventId: string, @Args('userId') userId: string, @Args('role') role: string, @CurrentUser() user: any) {
    return this.service.addPerson(eventId, userId, role, user);
  }

  @AllowedWhenDone()
  @Roles('ADMIN')
  @Mutation(() => Boolean)
  changeEventPersonRole(@Args('eventId') eventId: string, @Args('userId') userId: string, @Args('role') role: string, @CurrentUser() user: any) {
    return this.service.changeRole(eventId, userId, role, user);
  }

  @AllowedWhenDone()
  @Roles('ADMIN')
  @Mutation(() => Boolean)
  removeEventPerson(@Args('eventId') eventId: string, @Args('userId') userId: string, @CurrentUser() user: any) {
    return this.service.removePerson(eventId, userId, user);
  }

  private wrap(e: any) {
    return { ...e, myRole: 'ADMIN', onEvent: true, admins: [], progress: null };
  }
}
