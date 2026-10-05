import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /** Who did it: userId for a signed-in person, judgeId for a judge acting through their link. */
  async log(params: {
    userId?: string | null;
    judgeId?: string | null;
    eventId?: string;
    action: AuditAction;
    entityType: string;
    entityId: string;
    oldValues?: any;
    newValues?: any;
    reason?: string;
  }) {
    if (!params.userId && !params.judgeId) throw new Error('An audit entry needs who did it (userId or judgeId).');
    return this.prisma.auditLog.create({
      data: {
        userId: params.userId || null,
        judgeId: params.judgeId || null,
        eventId: params.eventId || null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        oldValues: params.oldValues || undefined,
        newValues: params.newValues || undefined,
        reason: params.reason || null,
      },
    });
  }

  async findByEvent(eventId: string, take = 50, skip = 0) {
    return this.prisma.auditLog.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      include: { user: { select: { id: true, email: true, role: true } }, judge: { select: { id: true, name: true } } },
    });
  }

  async findByEntity(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, role: true } }, judge: { select: { id: true, name: true } } },
    });
  }
}
