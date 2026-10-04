import { BadRequestException, ForbiddenException, Global, Injectable, Module, NotFoundException, SetMetadata } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Who may touch which event.
 *
 * Every event is private to the people assigned to it (EventUser). A person's
 * role on an event (Admin, Coordinator, Panel chair, Auditor) is what decides
 * what they may do there; their platform role only decides what they may do
 * outside any event (create events, manage accounts). Super admins see and do
 * everything.
 *
 * An operation is checked on every id it names, not just `eventId`: a team id,
 * a session id, a judge id... each is looked up, and all of them must belong
 * to one event the caller is on. So a team id copied from another event is
 * refused even when it is sent alongside an event the caller is on.
 */

/** Kinds of record an id can name, each of which belongs to one event. */
export type EntityKind =
  | 'event' | 'team' | 'judge' | 'room' | 'track' | 'session' | 'scorecard'
  | 'template' | 'criterion' | 'conflict' | 'timeSlot' | 'judgeLink' | 'judgingDay';

/** Argument and input field names that carry ids, and what they name. */
export const ID_FIELDS: Record<string, EntityKind> = {
  eventId: 'event',
  teamId: 'team',
  judgeId: 'judge', judgeIds: 'judge', oldJudgeId: 'judge', newJudgeId: 'judge',
  roomId: 'room', newRoomId: 'room',
  trackId: 'track',
  sessionId: 'session', sessionIdA: 'session', sessionIdB: 'session',
  timeSlotId: 'timeSlot', newTimeSlotId: 'timeSlot', toSlotId: 'timeSlot',
  templateId: 'template',
  parentId: 'criterion',
  linkId: 'judgeLink',
  scorecardId: 'scorecard',
  criterionId: 'criterion',
};

/** Id fields that name something outside any event (a person's account). */
export const NON_EVENT_ID_FIELDS = new Set(['userId']);

export type Ref = { kind: EntityKind; id: string };

/** Event roles, as stored on EventUser. */
export const EVENT_ROLES = ['ADMIN', 'COORDINATOR', 'PANEL_CHAIR', 'AUDITOR'] as const;
export type EventRoleName = (typeof EVENT_ROLES)[number];

export type ScopeOptions = {
  /** What a plain `id` argument (or an `id` inside an input or list) names. */
  id?: EntityKind;
  /** Extra ids an operation names in a way the field names can't say. */
  refs?: (args: Record<string, any>) => Ref[] | 'super-admin-only';
};

export const EVENT_SCOPE_KEY = 'eventScope';
export const NOT_EVENT_SCOPED_KEY = 'notEventScoped';
export const CHECKED_IN_HANDLER_KEY = 'eventCheckedInHandler';
export const ALLOWED_WHEN_DONE_KEY = 'allowedWhenDone';

/** A change still allowed once an event is done (its people). */
export const AllowedWhenDone = () => SetMetadata(ALLOWED_WHEN_DONE_KEY, true);

/** How this resolver's (or operation's) ids are read. */
export const EventScope = (options: ScopeOptions) => SetMetadata(EVENT_SCOPE_KEY, options);

/** Not about any one event (sign-in, own account, the event list, creating an event). */
export const NotEventScoped = () => SetMetadata(NOT_EVENT_SCOPED_KEY, true);

/** A REST handler that calls EventAccessService.assert itself (multipart bodies are parsed after guards). */
export const EventCheckedInHandler = () => SetMetadata(CHECKED_IN_HANDLER_KEY, true);

export const DONE_MESSAGE = 'This event is done: only its record is kept, so nothing in it can change.';

export class NotOnEventError extends ForbiddenException {
  constructor() {
    super({ statusCode: 403, code: 'not_on_event', message: "You're not on this event. Ask one of its admins to add you (see Event Control)." });
  }
}

/** Every id in an operation's arguments, by field name; unknown id-like fields are reported. */
export function collectRefs(args: unknown, idKind?: EntityKind): { refs: Ref[]; unknown: string[] } {
  const refs: Ref[] = [];
  const unknown: string[] = [];
  const add = (kind: EntityKind, v: unknown) => {
    if (typeof v === 'string' && v) refs.push({ kind, id: v });
    else if (Array.isArray(v)) v.forEach((x) => add(kind, x));
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== 'object' || v instanceof Date) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'id') {
        if (idKind) add(idKind, val);
        else unknown.push(k);
      } else if (ID_FIELDS[k]) {
        add(ID_FIELDS[k], val);
      } else if (/(Id|Ids)$/.test(k) && !NON_EVENT_ID_FIELDS.has(k)) {
        unknown.push(k);
      } else if (typeof val === 'object') {
        walk(val, depth + 1);
      }
    }
  };
  walk(args, 0);
  return { refs, unknown };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class EventAccessService {
  constructor(private prisma: PrismaService) {}

  /** The event an id belongs to, or null when there is no such record. */
  async eventOf(ref: Ref): Promise<string | null> {
    // Only the canonical form: the database also accepts ids without hyphens,
    // in braces or as urn:uuid:..., and an id this check skipped as "not a
    // record" must not be one the operation then finds.
    if (!UUID.test(ref.id)) throw new BadRequestException(`Not a valid id: ${String(ref.id).slice(0, 60)}`);
    const where = { id: ref.id };
    const p = this.prisma as any;
    const pick = async (model: string) => (await p[model].findUnique({ where, select: { eventId: true } }))?.eventId ?? null;
    switch (ref.kind) {
      case 'event': return (await p.event.findUnique({ where, select: { id: true } }))?.id ?? null;
      case 'team': return pick('team');
      case 'judge': return pick('judge');
      case 'room': return pick('room');
      case 'track': return pick('challengeTrack');
      case 'session': return pick('judgingSession');
      case 'scorecard': return pick('scorecard');
      case 'template': return pick('scoringTemplate');
      case 'conflict': return pick('conflictDeclaration');
      case 'timeSlot': return pick('timeSlot');
      case 'judgeLink': return pick('judgeLink');
      case 'judgingDay': return pick('judgingDay');
      case 'criterion': {
        const c = await p.scoringCriterion.findUnique({ where, select: { template: { select: { eventId: true } } } });
        return c?.template?.eventId ?? null;
      }
    }
  }

  /**
   * The one event these ids belong to. Ids of records that don't exist are
   * skipped (the operation itself will report them missing); ids from two
   * events are refused.
   */
  async eventFor(refs: Ref[]): Promise<string | null> {
    let eventId: string | null = null;
    const seen = new Set<string>();
    for (const r of refs) {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const e = await this.eventOf(r);
      if (!e) {
        // An event id must name an event: nothing else can stand in for it.
        if (r.kind === 'event') throw new NotFoundException('Event not found.');
        continue;
      }
      if (eventId && e !== eventId) throw new ForbiddenException('These records belong to different events.');
      eventId = e;
    }
    if (eventId) {
      const ev = await this.prisma.event.findUnique({ where: { id: eventId }, select: { deletedAt: true } });
      if (!ev || ev.deletedAt) throw new NotFoundException('Event not found.');
    }
    return eventId;
  }

  /** Marked done: candidate data removed, only the record is kept. */
  async isDone(eventId: string): Promise<boolean> {
    const e = await this.prisma.event.findUnique({ where: { id: eventId }, select: { doneAt: true } });
    return !!e?.doneAt;
  }

  /** The caller's role on an event (null if not on it). Super admins act as admins. */
  async roleOn(user: { sub?: string; role?: string }, eventId: string): Promise<EventRoleName | null> {
    if (user.role === 'SUPER_ADMIN') return 'ADMIN';
    if (!user.sub) return null;
    const row = await this.prisma.eventUser.findUnique({
      where: { userId_eventId: { userId: user.sub, eventId } },
      select: { role: true },
    });
    return (row?.role as EventRoleName) ?? null;
  }

  /**
   * The check every event operation goes through. Returns the event and the
   * caller's role on it. `roles` empty = any role on the event.
   */
  async assert(
    user: { sub?: string; role?: string } | undefined,
    eventId: string | null | undefined,
    roles: readonly string[] = [],
    refs: Ref[] = [],
    opts: { write?: boolean } = {},
  ): Promise<{ eventId: string; role: EventRoleName }> {
    if (!user?.sub) throw new ForbiddenException('Sign in first.');
    if (eventId !== undefined && eventId !== null && typeof eventId !== 'string') throw new BadRequestException('Not a valid event id.');
    const all: Ref[] = eventId ? [{ kind: 'event', id: eventId }, ...refs] : refs;
    const resolved = await this.eventFor(all);
    if (!resolved) throw new NotFoundException('Not found.');
    // A done event is a record: nothing in it changes any more.
    if (opts.write && (await this.isDone(resolved))) throw new ForbiddenException(DONE_MESSAGE);
    if (user.role === 'SUPER_ADMIN') return { eventId: resolved, role: 'ADMIN' };
    const role = await this.roleOn(user, resolved);
    if (!role) throw new NotOnEventError();
    if (roles.length && !roles.includes(role)) {
      throw new ForbiddenException(`Your role on this event (${label(role)}) can't do this.`);
    }
    return { eventId: resolved, role };
  }
}

export function label(role: string): string {
  return ({ ADMIN: 'Admin', COORDINATOR: 'Coordinator', PANEL_CHAIR: 'Panel chair', AUDITOR: 'Auditor', SUPER_ADMIN: 'Super admin' } as Record<string, string>)[role] ?? role;
}

@Global()
@Module({ providers: [EventAccessService], exports: [EventAccessService] })
export class EventAccessModule {}
