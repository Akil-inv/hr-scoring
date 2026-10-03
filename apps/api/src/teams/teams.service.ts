import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '@prisma/client';
import { CreateTeamInput, UpdateTeamInput } from './teams.types';

/** Countries taking part. Anything else is rejected at import. */
const VALID_COUNTRIES = ['TH', 'SG', 'MY', 'ID', 'VN', 'HK', 'CN'];

/**
 * Platforms a use case can be built on.
 *
 * A fixed list rather than free text: clustering groups by this, and vendors
 * are matched against it. "AWS" and "aws lambda" would be different groups,
 * and an AWS vendor would match neither reliably.
 *
 * INTERNAL means no external platform, so no vendor is involved.
 */
const VALID_PLATFORMS = ['AWS', 'GCP', 'CLOUDERA', 'PURPLE FABRIC', 'QLIK SENSE', 'INTERNAL', 'OTHER'];

@Injectable()
export class TeamsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(input: CreateTeamInput, userId: string) {
    const existing = await this.prisma.team.findUnique({
      where: { eventId_name: { eventId: input.eventId, name: input.name } },
    });
    if (existing) throw new ConflictException(`Team "${input.name}" already exists in this event`);

    if (input.trackId) {
      const track = await this.prisma.challengeTrack.findUnique({ where: { id: input.trackId } });
      if (!track) throw new NotFoundException('Track not found');
    }

    const team = await this.prisma.team.create({
      data: input,
      include: { track: true, members: true },
    });

    await this.audit.log({
      userId, eventId: input.eventId,
      action: AuditAction.CREATE, entityType: 'Team',
      entityId: team.id, newValues: { name: team.name, projectName: team.projectName },
    });

    return { ...team, trackName: team.track?.name || null };
  }

  async update(id: string, input: UpdateTeamInput, userId: string) {
    const existing = await this.prisma.team.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Team not found');

    if (input.name) {
      const dup = await this.prisma.team.findUnique({
        where: { eventId_name: { eventId: existing.eventId, name: input.name } },
      });
      if (dup && dup.id !== id) throw new ConflictException(`Team "${input.name}" already exists`);
    }

    const updated = await this.prisma.team.update({
      where: { id }, data: input,
      include: { track: true, members: true },
    });

    await this.audit.log({
      userId, eventId: existing.eventId,
      action: AuditAction.UPDATE, entityType: 'Team',
      entityId: id, oldValues: existing, newValues: updated,
    });

    return { ...updated, trackName: updated.track?.name || null };
  }

  async findAllByEvent(eventId: string, trackId?: string, status?: string) {
    const where: any = { eventId, deletedAt: null };
    if (trackId) where.trackId = trackId;
    if (status) where.status = status;

    const teams = await this.prisma.team.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { track: true, members: true },
    });
    return teams.map(t => ({ ...t, trackName: t.track?.name || null }));
  }

  async findOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { track: true, members: true },
    });
    if (!team) throw new NotFoundException('Team not found');
    return { ...team, trackName: team.track?.name || null };
  }

  async importFromCsv(eventId: string, rows: any[], userId: string) {
    const errors: Array<{ row: number; field: string; message: string }> = [];
    let imported = 0;

    // Load tracks for name lookup
    const tracks = await this.prisma.challengeTrack.findMany({
      where: { eventId, deletedAt: null },
    });
    const trackMap = new Map(tracks.map(t => [t.name.toLowerCase(), t.id]));

    // Load existing teams for duplicate check
    const existingTeams = await this.prisma.team.findMany({
      where: { eventId, deletedAt: null },
      select: { name: true },
    });
    const existingNames = new Set(existingTeams.map(t => t.name.toLowerCase()));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // +2 for 1-based + header row

      // Validate required fields
      if (!row.team_name?.trim()) { errors.push({ row: rowNum, field: 'team_name', message: 'Required' }); continue; }
      if (!row.project_name?.trim()) { errors.push({ row: rowNum, field: 'project_name', message: 'Required' }); continue; }
      if (!row.team_lead_email?.trim()) { errors.push({ row: rowNum, field: 'team_lead_email', message: 'Required' }); continue; }

      const teamName = row.team_name.trim();
      const trackName = row.track_name?.trim();

      // Almost every two-letter typo is a valid country somewhere, so an
      // unchecked code would render the wrong flag rather than no flag.
      let countryCode: string | null = null;
      const rawCountry = row.country?.trim().toUpperCase();
      if (rawCountry) {
        if (!VALID_COUNTRIES.includes(rawCountry)) {
          errors.push({
            row: rowNum,
            field: 'country',
            message: `"${row.country}" is not a recognised code. Use one of: ${VALID_COUNTRIES.join(', ')}`,
          });
          continue;
        }
        countryCode = rawCountry;
      }

      let platform: string | null = null;
      const rawPlatform = row.platform?.trim().toUpperCase();
      if (rawPlatform) {
        if (!VALID_PLATFORMS.includes(rawPlatform)) {
          errors.push({
            row: rowNum,
            field: 'platform',
            message: `"${row.platform}" is not a recognised platform. Use one of: ${VALID_PLATFORMS.join(', ')}`,
          });
          continue;
        }
        platform = rawPlatform;
      }

      // Check duplicate
      if (existingNames.has(teamName.toLowerCase())) {
        errors.push({ row: rowNum, field: 'team_name', message: `"${teamName}" already exists` });
        continue;
      }

      // Resolve track
      let trackId: string | null = null;
      if (trackName) {
        trackId = trackMap.get(trackName.toLowerCase()) || null;
        if (!trackId) {
          const avail = tracks.map(t => t.name).join(", "); errors.push({ row: rowNum, field: 'track_name', message: `Track "${trackName}" not found. Available: ${avail}` });
          continue;
        }
      }

      try {
        await this.prisma.team.create({
          data: {
            eventId,
            trackId,
            name: teamName,
            projectName: row.project_name.trim(),
            useCaseTitle: row.use_case_title?.trim() || null,
            problemStatement: row.problem_statement?.trim() || null,
            solutionSummary: row.solution_summary?.trim() || null,
            teamLeadName: row.team_lead_name?.trim() || teamName,
            teamLeadEmail: row.team_lead_email.trim(),
            organisation: row.organisation?.trim() || null,
            country: countryCode,
            techStack: row.tech_stack?.trim() || null,
            platform,
          },
        });
        existingNames.add(teamName.toLowerCase());
        imported++;
      } catch (e: any) {
        errors.push({ row: rowNum, field: 'general', message: e.message?.substring(0, 100) || 'Unknown error' });
      }
    }

    await this.audit.log({
      userId, eventId,
      action: AuditAction.CREATE, entityType: 'Team',
      entityId: `import-batch`,
      newValues: { imported, skipped: errors.length, totalRows: rows.length },
    });

    return { imported, skipped: errors.length, errors };
  }
  async delete(id: string, userId: string) {
    const team = await this.prisma.team.findUniqueOrThrow({ where: { id } });
    // Five tables reference a team and none cascade, so a bare delete fails as
    // soon as the team has any history — which is every team, once a schedule
    // exists. Clearing teams to re-import a corrected spreadsheet is a
    // reasonable thing to want to do.
    const submitted = await this.prisma.scorecard.count({
      where: {
        teamId: id,
        status: { in: ['SUBMITTED', 'RESUBMITTED', 'LOCKED'] },
      },
    });

    if (submitted > 0) {
      throw new BadRequestException(
        `This team has ${submitted} submitted scorecard(s). Deleting it would ` +
        'remove scores that have already counted toward the rankings.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const cards = await tx.scorecard.findMany({
        where: { teamId: id },
        select: { id: true },
      });
      if (cards.length > 0) {
        await tx.criterionScore.deleteMany({
          where: { scorecardId: { in: cards.map(c => c.id) } },
        });
        await tx.scorecard.deleteMany({ where: { teamId: id } });
      }

      const sessions = await tx.judgingSession.findMany({
        where: { teamId: id },
        select: { id: true },
      });
      if (sessions.length > 0) {
        await tx.sessionJudge.deleteMany({
          where: { sessionId: { in: sessions.map(s => s.id) } },
        });
        await tx.judgingSession.deleteMany({ where: { teamId: id } });
      }

      await tx.rankingResult.deleteMany({ where: { teamId: id } });
      await tx.conflictDeclaration.deleteMany({ where: { teamId: id } });
      await tx.teamMember.deleteMany({ where: { teamId: id } });

      await tx.team.delete({ where: { id } });
    });
    await this.audit.log({ userId, eventId: team.eventId, action: 'DELETE' as any, entityType: 'Team', entityId: id, oldValues: { name: team.name }, reason: 'Team deleted' });
    return team;
  }

}
