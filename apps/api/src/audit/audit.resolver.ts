import { Resolver, Query, Args } from '@nestjs/graphql';
import { AuditService } from './audit.service';
import { AuditLogEntry } from './audit.types';
import { Roles } from '../auth/roles.decorator';

@Resolver()
export class AuditResolver {
  constructor(private auditService: AuditService) {}

  @Roles('ADMIN', 'AUDITOR')
  @Query(() => [AuditLogEntry])
  async auditLogsByEvent(
    @Args('eventId') eventId: string,
    @Args('take', { defaultValue: 50 }) take: number,
    @Args('skip', { defaultValue: 0 }) skip: number,
  ) {
    return this.auditService.findByEvent(eventId, take, skip);
  }

  @Roles('ADMIN', 'AUDITOR')
  @Query(() => [AuditLogEntry])
  async auditLogsByEntity(
    @Args('entityType') entityType: string,
    @Args('entityId') entityId: string,
  ) {
    return this.auditService.findByEntity(entityType, entityId);
  }
}
