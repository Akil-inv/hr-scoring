import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { EventsService } from './events.service';
import { EventEntity, CreateEventInput, UpdateEventInput } from './events.types';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { ObjectType, Field, Int } from '@nestjs/graphql';
import { PrismaService } from '../prisma/prisma.service';

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

@Resolver(() => EventEntity)
export class EventsResolver {
  constructor(
    private eventsService: EventsService,
    private prisma: PrismaService,
  ) {}

  @Roles('ADMIN')
  @Mutation(() => EventEntity)
  async createEvent(@Args('input') input: CreateEventInput, @CurrentUser() user: any) {
    return this.eventsService.create(input, user.sub);
  }

  @Roles('ADMIN')
  @Mutation(() => EventEntity)
  async updateEvent(@Args('id') id: string, @Args('input') input: UpdateEventInput, @CurrentUser() user: any) {
    return this.eventsService.update(id, input, user.sub);
  }

  @Roles('ADMIN', 'COORDINATOR', 'AUDITOR')
  @Query(() => EventEntity)
  async event(@Args('id') id: string) {
    return this.eventsService.findOne(id);
  }

  @Roles('ADMIN', 'COORDINATOR', 'AUDITOR')
  @Query(() => [EventEntity])
  async events(@CurrentUser() user: any) {
    return this.eventsService.findAll(user);
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Query(() => [JudgingRoundType])
  async judgingRounds(@Args('eventId') eventId: string) {
    return this.prisma.judgingRound.findMany({ where: { eventId }, orderBy: { roundNumber: 'asc' } });
  }

  @Roles('ADMIN')
  @Mutation(() => EventEntity)
  async deleteEvent(@Args('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.softDelete(id, user.sub);
  }
}
