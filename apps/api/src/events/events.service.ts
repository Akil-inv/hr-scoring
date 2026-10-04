import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { CreateEventInput, UpdateEventInput } from './events.types';

@Injectable()
export class EventsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(input: CreateEventInput, userId: string) {
    // The creator is the event's first admin (EventUser), so they can reach it.
    const event = await this.prisma.$transaction(async (tx) => {
      const ev = await tx.event.create({ data: input });
      await tx.eventUser.create({ data: { userId, eventId: ev.id, role: 'ADMIN', addedById: userId } });
      return ev;
    });

    await this.audit.log({
      userId,
      eventId: event.id,
      action: AuditAction.CREATE,
      entityType: 'Event',
      entityId: event.id,
      newValues: event,
    });

    return event;
  }

  async update(id: string, input: UpdateEventInput, userId: string) {
    const existing = await this.prisma.event.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event not found');
    if (existing.doneAt) throw new BadRequestException('This event is done: only its record is kept.');
    if (input.status && input.status !== existing.status) {
      // Closing, archiving and reopening go through Event Control (which keeps
      // the close date retention counts from); here only Draft <-> Active.
      const ok = (existing.status === 'DRAFT' && input.status === 'ACTIVE') || (existing.status === 'ACTIVE' && input.status === 'DRAFT');
      if (!ok) throw new BadRequestException('Close or archive the event from Event Control.');
    }

    const updated = await this.prisma.event.update({
      where: { id },
      data: input,
    });

    await this.audit.log({
      userId,
      eventId: id,
      action: AuditAction.UPDATE,
      entityType: 'Event',
      entityId: id,
      oldValues: existing,
      newValues: updated,
    });

    return updated;
  }

  async findOne(id: string) {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  /** The events a user is on (super admins: all). */
  async findAll(user?: { sub?: string; role?: string } | null) {
    const where: any = { deletedAt: null };
    if (user?.role !== 'SUPER_ADMIN') where.eventUsers = { some: { userId: user?.sub ?? '00000000-0000-0000-0000-000000000000' } };
    return this.prisma.event.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async softDelete(id: string, userId: string) {
    const existing = await this.prisma.event.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Event not found');

    const deleted = await this.prisma.event.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.audit.log({
      userId,
      eventId: id,
      action: AuditAction.DELETE,
      entityType: 'Event',
      entityId: id,
      oldValues: existing,
    });

    return deleted;
  }
}
