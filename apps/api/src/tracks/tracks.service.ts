import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { CreateTrackInput, UpdateTrackInput, ReorderTrackInput } from './tracks.types';

@Injectable()
export class TracksService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(input: CreateTrackInput, userId: string) {
    const existing = await this.prisma.challengeTrack.findUnique({
      where: { eventId_name: { eventId: input.eventId, name: input.name } },
    });
    if (existing) throw new ConflictException('A track with this name already exists in this event');

    const maxOrder = await this.prisma.challengeTrack.aggregate({
      where: { eventId: input.eventId, deletedAt: null },
      _max: { displayOrder: true },
    });

    const track = await this.prisma.challengeTrack.create({
      data: {
        ...input,
        displayOrder: (maxOrder._max.displayOrder ?? -1) + 1,
      },
    });

    await this.audit.log({
      userId, eventId: input.eventId,
      action: AuditAction.CREATE, entityType: 'ChallengeTrack',
      entityId: track.id, newValues: track,
    });

    return { ...track, teamCount: 0 };
  }

  async update(id: string, input: UpdateTrackInput, userId: string) {
    const existing = await this.prisma.challengeTrack.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Track not found');

    if (input.name) {
      const duplicate = await this.prisma.challengeTrack.findUnique({
        where: { eventId_name: { eventId: existing.eventId, name: input.name } },
      });
      if (duplicate && duplicate.id !== id) {
        throw new ConflictException('A track with this name already exists in this event');
      }
    }

    const updated = await this.prisma.challengeTrack.update({ where: { id }, data: input });

    await this.audit.log({
      userId, eventId: existing.eventId,
      action: AuditAction.UPDATE, entityType: 'ChallengeTrack',
      entityId: id, oldValues: existing, newValues: updated,
    });

    const teamCount = await this.prisma.team.count({ where: { trackId: id, deletedAt: null } });
    return { ...updated, teamCount };
  }

  async reorder(inputs: ReorderTrackInput[], userId: string) {
    const results = [];
    for (const input of inputs) {
      const updated = await this.prisma.challengeTrack.update({
        where: { id: input.id },
        data: { displayOrder: input.displayOrder },
      });
      results.push(updated);
    }
    return results.map(r => ({ ...r, teamCount: 0 }));
  }

  async findAllByEvent(eventId: string) {
    const tracks = await this.prisma.challengeTrack.findMany({
      where: { eventId, deletedAt: null },
      orderBy: { displayOrder: 'asc' },
      include: { _count: { select: { teams: { where: { deletedAt: null } } } } },
    });
    return tracks.map(t => ({ ...t, teamCount: t._count.teams }));
  }

  async findOne(id: string) {
    const track = await this.prisma.challengeTrack.findUnique({
      where: { id },
      include: { _count: { select: { teams: { where: { deletedAt: null } } } } },
    });
    if (!track) throw new NotFoundException('Track not found');
    return { ...track, teamCount: track._count.teams };
  }

  async delete(id: string, userId: string) {
    const track = await this.prisma.challengeTrack.findUniqueOrThrow({ where: { id } });
    await this.prisma.challengeTrack.delete({ where: { id } });
    await this.audit.log({ userId, eventId: track.eventId, action: 'DELETE' as any, entityType: 'ChallengeTrack', entityId: id, oldValues: track, reason: 'Track deleted' });
    return track;
  }

}
