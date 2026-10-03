import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction } from '@prisma/client';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(params: {
    userId: string;
    eventId?: string;
    action: AuditAction;
    entityType: string;
    entityId: string;
    oldValues?: any;
    newValues?: any;
    reason?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        userId: params.userId,
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
      include: { user: { select: { id: true, email: true, role: true } } },
    });
  }

  async findByEntity(entityType: string, entityId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, role: true } } },
    });
  }
}
