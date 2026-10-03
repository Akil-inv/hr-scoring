import { Resolver, Mutation, Args } from '@nestjs/graphql';
import { SchedulingService } from './scheduling.service';
import { ScheduleResult, GenerateScheduleInput } from './scheduling.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';

@Resolver()
export class SchedulingResolver {
  constructor(
    private schedulingService: SchedulingService,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => ScheduleResult)
  async generateSchedule(
    @Args('input') input: GenerateScheduleInput,
    @CurrentUser() user: any,
  ) {
    return this.schedulingService.generateSchedule(
      input.eventId,
      input.minJudgesPerTeam,
      input.maxJudgesPerTeam,
      user.sub,
      input.guided ?? false,
    );
  }

  @Roles('ADMIN', 'COORDINATOR')
  @Mutation(() => Boolean)
  async resetSchedule(
    @Args('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    const event = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!event) throw new Error('Event not found');
    if (event.status === 'ACTIVE' || event.status === 'COMPLETED') {
      throw new Error('Cannot reset schedule once the event is live. Use Command Centre for changes.');
    }

    await this.prisma.criterionScore.deleteMany({ where: { scorecard: { eventId } } });
    await this.prisma.scorecard.deleteMany({ where: { eventId } });
    await this.prisma.sessionJudge.deleteMany({ where: { session: { eventId } } });
    await this.prisma.judgingSession.deleteMany({ where: { eventId } });
    await this.prisma.rankingResult.deleteMany({ where: { eventId } });

    await this.audit.log({
      userId: user.sub, eventId,
      action: AuditAction.DELETE, entityType: 'Schedule', entityId: eventId,
      newValues: { action: 'Pre-event schedule reset' },
    });

    return true;
  }
}
