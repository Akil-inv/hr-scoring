import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction, ConflictDeclStatus } from '@prisma/client';
import { DeclareConflictInput } from './conflicts.types';

@Injectable()
export class ConflictsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  private enrichConflict(c: any) {
    return {
      ...c,
      judgeName: c.judge?.name || '',
      teamName: c.team?.name || '',
      declaredByEmail: c.declaredBy?.email || '',
      resolvedByEmail: c.resolvedBy?.email || null,
    };
  }

  async declare(input: DeclareConflictInput, userId: string) {
    // Check for existing active conflict
    const existing = await this.prisma.conflictDeclaration.findUnique({
      where: {
        judgeId_teamId_status: {
          judgeId: input.judgeId,
          teamId: input.teamId,
          status: ConflictDeclStatus.ACTIVE,
        },
      },
    });
    if (existing) throw new ConflictException('An active conflict already exists between this judge and team');

    const judge = await this.prisma.judge.findUnique({ where: { id: input.judgeId } });
    if (!judge) throw new NotFoundException('Judge not found');

    const team = await this.prisma.team.findUnique({ where: { id: input.teamId } });
    if (!team) throw new NotFoundException('Team not found');

    const conflict = await this.prisma.conflictDeclaration.create({
      data: {
        eventId: input.eventId,
        judgeId: input.judgeId,
        teamId: input.teamId,
        reason: input.reason,
        source: input.source,
        declaredById: userId,
      },
      include: {
        judge: { select: { name: true } },
        team: { select: { name: true } },
        declaredBy: { select: { email: true } },
        resolvedBy: { select: { email: true } },
      },
    });

    await this.audit.log({
      userId, eventId: input.eventId,
      action: AuditAction.CREATE, entityType: 'ConflictDeclaration',
      entityId: conflict.id,
      newValues: { judge: judge.name, team: team.name, reason: input.reason },
    });

    return this.enrichConflict(conflict);
  }

  async resolve(id: string, userId: string) {
    const existing = await this.prisma.conflictDeclaration.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Conflict not found');

    const resolved = await this.prisma.conflictDeclaration.update({
      where: { id },
      data: {
        status: ConflictDeclStatus.RESOLVED,
        resolvedById: userId,
        resolvedAt: new Date(),
      },
      include: {
        judge: { select: { name: true } },
        team: { select: { name: true } },
        declaredBy: { select: { email: true } },
        resolvedBy: { select: { email: true } },
      },
    });

    await this.audit.log({
      userId, eventId: existing.eventId,
      action: AuditAction.UPDATE, entityType: 'ConflictDeclaration',
      entityId: id, oldValues: { status: 'ACTIVE' }, newValues: { status: 'RESOLVED' },
    });

    return this.enrichConflict(resolved);
  }

  async findByEvent(eventId: string) {
    const conflicts = await this.prisma.conflictDeclaration.findMany({
      where: { eventId },
      orderBy: { createdAt: 'desc' },
      include: {
        judge: { select: { name: true } },
        team: { select: { name: true } },
        declaredBy: { select: { email: true } },
        resolvedBy: { select: { email: true } },
      },
    });
    return conflicts.map(c => this.enrichConflict(c));
  }

  async findByJudge(judgeId: string) {
    const conflicts = await this.prisma.conflictDeclaration.findMany({
      where: { judgeId },
      orderBy: { createdAt: 'desc' },
      include: {
        judge: { select: { name: true } },
        team: { select: { name: true } },
        declaredBy: { select: { email: true } },
        resolvedBy: { select: { email: true } },
      },
    });
    return conflicts.map(c => this.enrichConflict(c));
  }

  async findByTeam(teamId: string) {
    const conflicts = await this.prisma.conflictDeclaration.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      include: {
        judge: { select: { name: true } },
        team: { select: { name: true } },
        declaredBy: { select: { email: true } },
        resolvedBy: { select: { email: true } },
      },
    });
    return conflicts.map(c => this.enrichConflict(c));
  }
}
