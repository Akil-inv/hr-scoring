import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { CreateRoomInput, UpdateRoomInput } from './rooms.types';

@Injectable()
export class RoomsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(input: CreateRoomInput, userId: string) {
    const existing = await this.prisma.room.findUnique({
      where: { eventId_name: { eventId: input.eventId, name: input.name } },
    });
    if (existing) throw new ConflictException('A room with this name already exists in this event');

    const room = await this.prisma.room.create({ data: input });

    await this.audit.log({
      userId, eventId: input.eventId,
      action: AuditAction.CREATE, entityType: 'Room',
      entityId: room.id, newValues: room,
    });

    return room;
  }

  async update(id: string, input: UpdateRoomInput, userId: string) {
    const existing = await this.prisma.room.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Room not found');

    const updated = await this.prisma.room.update({ where: { id }, data: input });

    await this.audit.log({
      userId, eventId: existing.eventId,
      action: AuditAction.UPDATE, entityType: 'Room',
      entityId: id, oldValues: existing, newValues: updated,
    });

    return updated;
  }

  async findAllByEvent(eventId: string) {
    return this.prisma.room.findMany({
      where: { eventId, deletedAt: null },
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const room = await this.prisma.room.findUnique({ where: { id } });
    if (!room) throw new NotFoundException('Room not found');
    return room;
  }

  async delete(id: string, userId: string) {
    const room = await this.prisma.room.findUniqueOrThrow({ where: { id } });
    await this.prisma.room.delete({ where: { id } });
    await this.audit.log({ userId, eventId: room.eventId, action: 'DELETE' as any, entityType: 'Room', entityId: id, oldValues: room, reason: 'Room deleted' });
    return room;
  }

}
