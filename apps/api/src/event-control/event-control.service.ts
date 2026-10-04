import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { AUTH_SERVICE } from '@akil-inv/auth-kit/nest';
import { AuthError, AuthService } from '@akil-inv/auth-kit/server';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReviewService } from '../review/review.service';
import { EVENT_ROLES, EventRoleName, label } from '../auth/event-access';

/**
 * Event Control: the life of each event, who manages it, and how long its
 * candidate data is kept.
 *
 *   Draft → Active → Closed → Archived → Done (a record only)
 *
 * Retention is counted from the day the event is closed: the months chosen at
 * creation (3-6) plus any extensions admins add. Nothing is removed by itself:
 * when the time is up the event is "due", and an admin either extends it or
 * marks it done, which removes the candidates' personal data and keeps the
 * event's record (see DONE_KEEPS / DONE_REMOVES).
 */

/** Platform roles that are staff (may see the list of events and be added to one). */
export const STAFF_ROLES = ['SUPER_ADMIN', 'ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR'];

export const RETENTION_CHOICES = [3, 4, 5, 6];
export const MAX_EXTENSION_MONTHS = 12;

/**
 * What marking an event done does. One place, so it can change with what
 * people expect. Shown on the confirmation screen as written here.
 */
export const DONE_REMOVES = [
  "Candidates' names, contact details and application details",
  'Team members',
  'Report PDFs',
  'HR feedback, judges\' written comments and notes',
  'Messages to judges and judge links',
];
export const DONE_KEEPS = [
  'Event name, dates, admins and totals',
  'Scores and decisions, anonymised ("Candidate #0001")',
  'The audit log: who did what and when, without candidate details',
];

type Actor = { sub: string; role?: string };

export function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out;
}

export function retainUntil(e: { closedAt: Date | null; retentionMonths: number; retentionExtraMonths: number }): Date | null {
  return e.closedAt ? addMonths(e.closedAt, e.retentionMonths + e.retentionExtraMonths) : null;
}

export function lifecycle(e: { status: string; doneAt: Date | null; closedAt: Date | null; retentionMonths: number; retentionExtraMonths: number }, now = new Date()) {
  const until = retainUntil(e);
  const closed = e.status === 'COMPLETED' || e.status === 'ARCHIVED';
  return {
    stage: e.doneAt ? 'DONE' : e.status === 'ARCHIVED' ? 'ARCHIVED' : e.status === 'COMPLETED' ? 'CLOSED' : e.status,
    retainUntil: until,
    due: !e.doneAt && closed && !!until && until.getTime() <= now.getTime(),
  };
}

@Injectable()
export class EventControlService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private review: ReviewService,
    @Inject(AUTH_SERVICE) private auth: AuthService,
  ) {}

  // ─── The list everyone (staff) sees ───────────────────────────────────────

  /**
   * Every event, with its admins, so anyone can see whom to ask. What's inside
   * an event (progress, people other than admins) only for those on it.
   */
  async directory(user: Actor) {
    const events = await this.prisma.event.findMany({
      where: { deletedAt: null },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        eventUsers: {
          where: { role: 'ADMIN' },
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const mine = new Map(
      (await this.prisma.eventUser.findMany({ where: { userId: user.sub }, select: { eventId: true, role: true } }))
        .map((r) => [r.eventId, r.role as string]),
    );
    const superAdmin = user.role === 'SUPER_ADMIN';
    const visible = events.filter((e) => superAdmin || mine.has(e.id)).map((e) => e.id);
    const progress = await this.progress(visible);
    return events.map((e) => {
      const myRole = mine.get(e.id) ?? (superAdmin ? 'ADMIN' : null);
      return {
        ...this.summary(e),
        myRole,
        onEvent: mine.has(e.id),
        admins: e.eventUsers.map((a) => ({ userId: a.user.id, name: a.user.name, email: a.user.email })),
        progress: myRole ? progress.get(e.id) ?? null : null,
      };
    });
  }

  /** One event's page: everything about it for the people on it. */
  async detail(eventId: string, user: Actor, myRole: EventRoleName) {
    const e = await this.prisma.event.findFirst({ where: { id: eventId, deletedAt: null } });
    if (!e) throw new NotFoundException('Event not found.');
    const people = await this.prisma.eventUser.findMany({
      where: { eventId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const adders = await this.names(people.map((p) => p.addedById).filter(Boolean) as string[]);
    const changes = await this.prisma.auditLog.findMany({
      where: { eventId, entityType: { in: ['Event', 'EventUser'] } },
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { user: { select: { name: true, email: true } } },
    });
    const onEvent = people.some((p) => p.userId === user.sub);
    return {
      ...this.summary(e),
      myRole,
      onEvent,
      admins: people.filter((p) => p.role === 'ADMIN').map((p) => ({ userId: p.user.id, name: p.user.name, email: p.user.email })),
      progress: (await this.progress([eventId])).get(eventId) ?? null,
      people: people.map((p) => ({
        userId: p.user.id, name: p.user.name, email: p.user.email, role: p.role,
        addedAt: p.createdAt, addedBy: p.addedById ? adders.get(p.addedById) ?? null : null,
      })),
      recentChanges: changes.map((c) => ({ at: c.createdAt, by: c.user?.name || c.user?.email || '', what: c.reason || `${c.action.toLowerCase()} ${c.entityType}` })),
      doneRemoves: DONE_REMOVES,
      doneKeeps: DONE_KEEPS,
    };
  }

  private summary(e: any) {
    const l = lifecycle(e);
    return {
      id: e.id, name: e.name, description: e.description ?? null, status: e.status, setupMode: e.setupMode,
      stage: l.stage, startDate: e.startDate, endDate: e.endDate, closedAt: e.closedAt ?? null, doneAt: e.doneAt ?? null,
      retentionMonths: e.retentionMonths, retentionExtraMonths: e.retentionExtraMonths,
      retainUntil: l.retainUntil, due: l.due, createdAt: e.createdAt,
    };
  }

  private async progress(eventIds: string[]) {
    const out = new Map<string, { candidates: number; interviewsDone: number; interviewsTotal: number; daysClosed: number; daysTotal: number }>();
    if (!eventIds.length) return out;
    const [teams, sessions, done, days, closedDays] = await Promise.all([
      this.prisma.team.groupBy({ by: ['eventId'], where: { eventId: { in: eventIds }, deletedAt: null }, _count: true }),
      this.prisma.judgingSession.groupBy({ by: ['eventId'], where: { eventId: { in: eventIds }, stage: { notIn: ['CANCELLED', 'NO_SHOW'] } }, _count: true }),
      this.prisma.judgingSession.groupBy({ by: ['eventId'], where: { eventId: { in: eventIds }, stage: 'COMPLETED' }, _count: true }),
      this.prisma.judgingDay.groupBy({ by: ['eventId'], where: { eventId: { in: eventIds } }, _count: true }),
      this.prisma.judgingDay.groupBy({ by: ['eventId'], where: { eventId: { in: eventIds }, status: 'CLOSED' }, _count: true }),
    ]);
    const n = (rows: { eventId: string; _count: number }[], id: string) => rows.find((r) => r.eventId === id)?._count ?? 0;
    for (const id of eventIds) {
      out.set(id, {
        candidates: n(teams as any, id), interviewsTotal: n(sessions as any, id), interviewsDone: n(done as any, id),
        daysTotal: n(days as any, id), daysClosed: n(closedDays as any, id),
      });
    }
    return out;
  }

  private async names(ids: string[]) {
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name || u.email]));
  }

  // ─── Creating ─────────────────────────────────────────────────────────────

  async create(
    input: { name: string; description?: string | null; startDate: Date; endDate: Date; timezone?: string; setupMode?: string; retentionMonths?: number; coAdminIds?: string[] },
    user: Actor,
  ) {
    const name = (input.name ?? '').trim();
    if (!name) throw new BadRequestException('Give the event a name.');
    if (name.length > 120) throw new BadRequestException('Keep the name under 120 characters.');
    const months = input.retentionMonths ?? 6;
    if (!RETENTION_CHOICES.includes(months)) throw new BadRequestException('Keep candidate data for 3, 4, 5 or 6 months after the event closes.');
    if (!(input.startDate instanceof Date) || !(input.endDate instanceof Date) || isNaN(+input.startDate) || isNaN(+input.endDate)) {
      throw new BadRequestException('Give the first and last interview days.');
    }
    if (input.endDate < input.startDate) throw new BadRequestException('The last day is before the first day.');
    const setupMode = input.setupMode === 'WIZARD' ? 'WIZARD' : 'UPLOAD';
    const coAdmins = [...new Set((input.coAdminIds ?? []).filter((id) => id && id !== user.sub))];
    if (coAdmins.length > 20) throw new BadRequestException('Add up to 20 co-admins here; more can be added later.');
    const valid = coAdmins.length ? await this.staff(coAdmins) : [];
    if (valid.length !== coAdmins.length) throw new BadRequestException('One of the co-admins is not a staff account.');

    const event = await this.prisma.$transaction(async (tx) => {
      const ev = await tx.event.create({
        data: {
          name, description: input.description?.trim() || null, startDate: input.startDate, endDate: input.endDate,
          judgingStart: input.startDate, judgingEnd: input.endDate, timezone: input.timezone || 'Asia/Singapore',
          setupMode: setupMode as any, retentionMonths: months, status: 'DRAFT',
        },
      });
      await tx.eventUser.createMany({
        data: [user.sub, ...coAdmins].map((userId) => ({ userId, eventId: ev.id, role: 'ADMIN' as const, addedById: user.sub })),
        skipDuplicates: true,
      });
      return ev;
    });
    await this.audit.log({
      userId: user.sub, eventId: event.id, action: AuditAction.CREATE, entityType: 'Event', entityId: event.id,
      reason: `Event created (${setupMode === 'UPLOAD' ? 'Excel upload' : 'wizard'}, keep data ${months} months after closing)`,
      newValues: { name, retentionMonths: months, coAdmins: coAdmins.length },
    });
    return this.summary(event);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  private async load(eventId: string) {
    const e = await this.prisma.event.findFirst({ where: { id: eventId, deletedAt: null } });
    if (!e) throw new NotFoundException('Event not found.');
    return e;
  }

  private notDone(e: { doneAt: Date | null }) {
    if (e.doneAt) throw new BadRequestException('This event is done: only its record is kept.');
  }

  async start(eventId: string, user: Actor) {
    const e = await this.load(eventId);
    this.notDone(e);
    if (e.status !== 'DRAFT') throw new BadRequestException('Only a draft event can be started.');
    const out = await this.prisma.event.update({ where: { id: eventId }, data: { status: 'ACTIVE' } });
    await this.log(user, eventId, 'Event started');
    return this.summary(out);
  }

  /**
   * Close the event. Interview (upload) events need every day closed first and
   * go through the same close as the Results page; wizard events close here.
   */
  async close(eventId: string, user: Actor) {
    const e = await this.load(eventId);
    this.notDone(e);
    if (e.status === 'COMPLETED' || e.status === 'ARCHIVED') throw new BadRequestException('This event is already closed.');
    if (e.status === 'DRAFT') throw new BadRequestException('Start the event before closing it.');
    if (e.setupMode === 'UPLOAD') {
      await this.review.closeEvent(eventId, user.sub);
    } else {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.event.update({ where: { id: eventId }, data: { status: 'COMPLETED', closedAt: now, closedById: user.sub } }),
        this.prisma.judgeLink.updateMany({ where: { eventId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'Event closed' } }),
      ]);
      await this.log(user, eventId, 'Event closed');
    }
    return this.summary(await this.load(eventId));
  }

  async archive(eventId: string, user: Actor) {
    const e = await this.load(eventId);
    this.notDone(e);
    if (e.status !== 'COMPLETED') throw new BadRequestException('Close the event before archiving it.');
    const out = await this.prisma.event.update({ where: { id: eventId }, data: { status: 'ARCHIVED' } });
    await this.log(user, eventId, 'Event archived');
    return this.summary(out);
  }

  // ─── Retention ───────────────────────────────────────────────────────────

  async setRetention(eventId: string, months: number, user: Actor) {
    const e = await this.load(eventId);
    this.notDone(e);
    if (!RETENTION_CHOICES.includes(months)) throw new BadRequestException('Choose 3, 4, 5 or 6 months; extend for longer.');
    const out = await this.prisma.event.update({ where: { id: eventId }, data: { retentionMonths: months } });
    await this.log(user, eventId, `Retention set to ${months} months after closing (was ${e.retentionMonths})`);
    return this.summary(out);
  }

  async extendRetention(eventId: string, months: number, reason: string, user: Actor) {
    const e = await this.load(eventId);
    this.notDone(e);
    if (!Number.isInteger(months) || months < 1 || months > MAX_EXTENSION_MONTHS) {
      throw new BadRequestException(`Extend by 1 to ${MAX_EXTENSION_MONTHS} months at a time.`);
    }
    const why = (reason ?? '').trim();
    if (why.length < 5) throw new BadRequestException('Say why the data is still needed.');
    if (why.length > 500) throw new BadRequestException('Keep the reason under 500 characters.');
    const out = await this.prisma.event.update({ where: { id: eventId }, data: { retentionExtraMonths: { increment: months } } });
    const until = retainUntil(out);
    await this.log(user, eventId, `Retention extended by ${months} month${months === 1 ? '' : 's'}${until ? ` (to ${until.toISOString().slice(0, 10)})` : ''}: ${why}`);
    return this.summary(out);
  }

  /**
   * Mark the event done: remove the candidates' personal data and keep the
   * event's record. Only after the retention period, only by an admin who
   * types the event's name and their sign-in password. Cannot be undone.
   */
  async markDone(eventId: string, confirmName: string, password: string, user: Actor) {
    const e = await this.load(eventId);
    this.notDone(e);
    const l = lifecycle(e);
    if (!l.due) {
      throw new BadRequestException(
        e.closedAt ? `Its data is kept until ${l.retainUntil!.toISOString().slice(0, 10)}.` : 'Close the event first; data is kept for its retention period after that.',
      );
    }
    if ((confirmName ?? '').trim() !== e.name.trim()) throw new BadRequestException('Type the event name exactly as shown.');
    let ok = false;
    try {
      ok = await this.auth.confirmPassword({ id: user.sub } as any, String(password ?? ''));
    } catch (err) {
      if (err instanceof AuthError) throw new HttpException({ statusCode: err.status, message: err.message, code: err.code }, err.status);
      throw err;
    }
    if (!ok) throw new BadRequestException('Your sign-in password is not right.');

    const counts = await this.removeCandidateData(eventId, user.sub, e.name);
    await this.audit.log({
      userId: user.sub, eventId, action: AuditAction.DELETE, entityType: 'Event', entityId: eventId,
      reason: 'Event marked done: candidate data removed, record kept', newValues: counts,
    });
    return this.summary(await this.load(eventId));
  }

  /** The removal itself, in one transaction: all of it happens or none. */
  private async removeCandidateData(eventId: string, userId: string, name: string) {
    return this.prisma.$transaction(async (tx) => {
      // Checked again under a lock: another admin may have extended retention,
      // or marked it done, since the checks above.
      const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      if (!row) throw new NotFoundException('Event not found.');
      const now = await tx.event.findUnique({ where: { id: eventId } });
      if (!now || now.doneAt) throw new BadRequestException('This event is already done.');
      if (!lifecycle(now).due) throw new BadRequestException('Its retention was extended meanwhile; nothing was removed.');
      if (now.name !== name) throw new BadRequestException('The event was renamed meanwhile; nothing was removed.');
      const teams = await tx.team.findMany({ where: { eventId }, select: { id: true, name: true, teamLeadName: true, teamLeadEmail: true, projectName: true }, orderBy: { createdAt: 'asc' } });
      const members = await tx.teamMember.findMany({ where: { team: { eventId } }, select: { name: true, email: true } });
      // Labels for the audit log, longest names first so "Ann Lee" goes before "Ann".
      const labels = new Map<string, string>();
      teams.forEach((t, i) => {
        const tag = `Candidate #${String(i + 1).padStart(4, '0')}`;
        for (const v of [t.name, t.teamLeadName, t.teamLeadEmail, t.projectName]) if (v && v.trim().length > 2) labels.set(v.trim(), tag);
      });
      for (const m of members) for (const v of [m.name, m.email]) if (v && v.trim().length > 2 && !labels.has(v.trim())) labels.set(v.trim(), 'a candidate');
      const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = [...labels].sort((a, b) => b[0].length - a[0].length).map(([v, tag]) => [new RegExp(escape(v), 'gi'), tag] as const);
      const scrub = (text: string | null) => {
        if (!text) return text;
        let out = text;
        for (const [re, tag] of patterns) out = out.replace(re, tag);
        return out;
      };

      // Two passes so new names never collide with old ones on the (event, name) key.
      for (const t of teams) await tx.team.update({ where: { id: t.id }, data: { name: `removed-${t.id}` } });
      let i = 0;
      for (const t of teams) {
        i += 1;
        await tx.team.update({
          where: { id: t.id },
          data: {
            name: `Candidate #${String(i).padStart(4, '0')}`, projectName: '', teamLeadName: '', teamLeadEmail: '',
            useCaseTitle: null, problemStatement: null, solutionSummary: null, techStack: null, platform: null,
            department: null, useCategory: null, vendorTools: null, organisation: null, country: null, eligibilityNotes: null,
          },
        });
      }
      const removedMembers = await tx.teamMember.deleteMany({ where: { team: { eventId } } });
      const removedReports = await tx.decisionReport.deleteMany({ where: { eventId } });
      await tx.teamDecision.updateMany({ where: { eventId }, data: { feedback: null, reopenReason: null } });
      await tx.scorecard.updateMany({ where: { eventId }, data: { overallStrengths: null, areasForImprovement: null, recommendation: null, reopenReason: null } });
      await tx.criterionScore.updateMany({ where: { scorecard: { eventId } }, data: { comment: null } });
      await tx.judgingSession.updateMany({ where: { eventId }, data: { notes: null, delayReason: null } });
      await tx.sessionJudge.updateMany({ where: { session: { eventId }, removedReason: { not: null } }, data: { removedReason: 'Removed when the event was marked done' } });
      await tx.conflictDeclaration.updateMany({ where: { eventId }, data: { reason: 'Removed when the event was marked done' } });
      const removedMessages = await tx.judgeMessage.deleteMany({ where: { eventId } });
      const removedLinks = await tx.judgeLink.deleteMany({ where: { eventId } });

      // The audit log stays, without candidate details: the before/after
      // values go, and names in the reasons become labels.
      const logs = await tx.auditLog.findMany({ where: { eventId }, select: { id: true, reason: true } });
      for (const log of logs) {
        await tx.auditLog.update({
          where: { id: log.id },
          data: { oldValues: Prisma.DbNull, newValues: Prisma.DbNull, reason: scrub(log.reason) },
        });
      }
      await tx.event.update({ where: { id: eventId }, data: { status: 'ARCHIVED', doneAt: new Date(), doneById: userId } });
      return {
        candidates: teams.length, teamMembers: removedMembers.count, reports: removedReports.count,
        judgeMessages: removedMessages.count, judgeLinks: removedLinks.count, auditEntriesCleaned: logs.length,
      };
    }, { timeout: 300_000, maxWait: 10_000 });
  }

  // ─── People ──────────────────────────────────────────────────────────────

  /** Staff accounts (not deleted) among these ids. */
  private async staff(ids: string[]) {
    return this.prisma.user.findMany({
      where: { id: { in: ids }, role: { in: STAFF_ROLES as any }, NOT: { email: { endsWith: '@deleted.invalid' } } },
      select: { id: true, name: true, email: true },
    });
  }

  async searchPeople(eventId: string, query: string) {
    const q = (query ?? '').trim();
    if (q.length < 2) return [];
    const on = new Set((await this.prisma.eventUser.findMany({ where: { eventId }, select: { userId: true } })).map((r) => r.userId));
    const users = await this.prisma.user.findMany({
      where: {
        role: { in: STAFF_ROLES as any },
        NOT: { email: { endsWith: '@deleted.invalid' } },
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }],
      },
      select: { id: true, name: true, email: true },
      take: 25,
      orderBy: { name: 'asc' },
    });
    return users.filter((u) => !on.has(u.id)).slice(0, 10).map((u) => ({ userId: u.id, name: u.name, email: u.email }));
  }

  async searchStaff(query: string, exceptUserId: string) {
    const q = (query ?? '').trim();
    if (q.length < 2) return [];
    const users = await this.prisma.user.findMany({
      where: {
        id: { not: exceptUserId },
        role: { in: STAFF_ROLES as any },
        NOT: { email: { endsWith: '@deleted.invalid' } },
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }],
      },
      select: { id: true, name: true, email: true },
      take: 10,
      orderBy: { name: 'asc' },
    });
    return users.map((u) => ({ userId: u.id, name: u.name, email: u.email }));
  }

  private role(r: string): EventRoleName {
    if (!(EVENT_ROLES as readonly string[]).includes(r)) throw new BadRequestException('Choose Admin, Coordinator, Panel chair or Auditor.');
    return r as EventRoleName;
  }

  async addPerson(eventId: string, userId: string, role: string, by: Actor) {
    const r = this.role(role);
    await this.load(eventId);
    const [person] = await this.staff([userId]);
    if (!person) throw new BadRequestException('That person has no staff account. A super admin can create one (Users & roles).');
    const existing = await this.prisma.eventUser.findUnique({ where: { userId_eventId: { userId, eventId } } });
    if (existing) throw new ConflictException(`${person.name || person.email} is already on this event.`);
    try {
      await this.prisma.eventUser.create({ data: { userId, eventId, role: r, addedById: by.sub } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException(`${person.name || person.email} is already on this event.`);
      throw e;
    }
    await this.log(by, eventId, `${person.name || person.email} added as ${label(r)}`, 'EventUser', userId);
    return true;
  }

  async changeRole(eventId: string, userId: string, role: string, by: Actor) {
    const r = this.role(role);
    return this.lastAdminSafe(eventId, async (tx) => {
      const row = await tx.eventUser.findUnique({ where: { userId_eventId: { userId, eventId } }, include: { user: { select: { name: true, email: true } } } });
      if (!row) throw new NotFoundException('That person is not on this event.');
      if (row.role === r) return { changed: false, who: '', from: r };
      await tx.eventUser.update({ where: { id: row.id }, data: { role: r } });
      return { changed: true, who: row.user.name || row.user.email, from: row.role };
    }).then(async (res) => {
      if (res.changed) await this.log(by, eventId, `${res.who} changed from ${label(res.from)} to ${label(r)}`, 'EventUser', userId);
      return true;
    });
  }

  async removePerson(eventId: string, userId: string, by: Actor) {
    const res = await this.lastAdminSafe(eventId, async (tx) => {
      const row = await tx.eventUser.findUnique({ where: { userId_eventId: { userId, eventId } }, include: { user: { select: { name: true, email: true } } } });
      if (!row) throw new NotFoundException('That person is not on this event.');
      await tx.eventUser.delete({ where: { id: row.id } });
      return { who: row.user.name || row.user.email, role: row.role };
    });
    await this.log(by, eventId, `${res.who} removed (was ${label(res.role)})`, 'EventUser', userId);
    return true;
  }

  /**
   * Run a change to an event's people, refusing it if the event would be left
   * with no admin. Serialised per event (a row lock on the event), so two admins
   * removing each other at the same moment can't both succeed.
   */
  private async lastAdminSafe<T>(eventId: string, change: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM events WHERE id = ${eventId}::uuid FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Event not found.');
      const before = await tx.eventUser.count({ where: { eventId, role: 'ADMIN' } });
      const out = await change(tx);
      const after = await tx.eventUser.count({ where: { eventId, role: 'ADMIN' } });
      if (before > 0 && after === 0) throw new BadRequestException('An event must keep at least one admin. Add another admin first.');
      return out;
    });
  }

  private async log(user: Actor, eventId: string, reason: string, entityType = 'Event', entityId = eventId) {
    await this.audit.log({ userId: user.sub, eventId, action: AuditAction.UPDATE, entityType, entityId, reason });
  }

  /** For the existing super-admin screens (Users & roles): the same rules. */
  async assign(eventId: string, userId: string, role: string, by: Actor) {
    const on = await this.prisma.eventUser.findUnique({ where: { userId_eventId: { userId, eventId } } });
    return on ? this.changeRole(eventId, userId, role, by) : this.addPerson(eventId, userId, role, by);
  }

  static assertStaff(user: { role?: string } | undefined) {
    if (!user?.role || !STAFF_ROLES.includes(user.role)) throw new ForbiddenException('Only staff accounts can see events.');
  }
}
