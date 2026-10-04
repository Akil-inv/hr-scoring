import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import {
  collectRefs,
  EVENT_SCOPE_KEY,
  EventAccessService,
  NOT_EVENT_SCOPED_KEY,
  ALLOWED_WHEN_DONE_KEY,
  ScopeOptions,
} from './event-access';

/**
 * Every GraphQL operation is either about one event or explicitly not
 * (@NotEventScoped). For one about an event, every id it names must belong to
 * that one event and the caller must be on it (src/auth/event-access.ts). The
 * caller's role on the event is then left on the request for RolesGuard, which
 * runs next and checks @Roles() against it.
 *
 * Fails closed: an operation that names no event and isn't marked
 * @NotEventScoped, or that names an id-like field nobody has mapped, is
 * refused, so a new operation can't be added without deciding its scope.
 *
 * REST handlers check inside the handler (multipart bodies are only parsed
 * after guards run); a test makes sure each one does or is marked otherwise.
 * The judge portal is @Public and authenticates by its link token.
 */
/** The root field being checked, by its name in the request (its alias if it has one). */
export function fieldKey(ctx: GqlExecutionContext): string {
  const info = ctx.getInfo();
  return String(info?.path?.key ?? info?.fieldName ?? '');
}

@Injectable()
export class EventScopeGuard implements CanActivate {
  private readonly logger = new Logger('EventScope');

  constructor(
    private reflector: Reflector,
    private access: EventAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (context.getType<string>() !== 'graphql') return true;

    const ctx = GqlExecutionContext.create(context);
    const req = ctx.getContext().req;
    // One request can hold several root fields (queries run them at the same
    // time), so the role found is kept per field, never shared across them.
    const field = fieldKey(ctx);
    if (req) {
      req.eventAccessByField ??= {};
      delete req.eventAccessByField[field];
    }
    const user = req?.user;
    if (!user) return true; // the auth guard has already answered

    if (this.reflector.getAllAndOverride<boolean>(NOT_EVENT_SCOPED_KEY, targets)) return true;

    const options = this.reflector.getAllAndOverride<ScopeOptions>(EVENT_SCOPE_KEY, targets) ?? {};
    const name = ctx.getInfo()?.fieldName ?? context.getHandler().name;
    let extra: ReturnType<NonNullable<ScopeOptions['refs']>> = [];
    if (options.refs) {
      extra = options.refs(ctx.getArgs());
      if (extra === 'super-admin-only') {
        if (user.role === 'SUPER_ADMIN') return true;
        throw new ForbiddenException('Only a super admin can do this.');
      }
    }
    const { refs, unknown } = collectRefs(ctx.getArgs(), options.id);
    if (unknown.length && !options.refs) {
      this.logger.error(`${name}: id fields with no event mapping: ${unknown.join(', ')}`);
      throw new ForbiddenException('This operation is not set up for event access checks.');
    }
    refs.push(...extra);
    if (!refs.length) {
      this.logger.error(`${name}: names no event and is not marked @NotEventScoped`);
      throw new ForbiddenException('This operation is not set up for event access checks.');
    }

    // A done event is a record: no mutation changes it, except who is on it.
    const write = ctx.getInfo()?.operation?.operation === 'mutation'
      && !this.reflector.getAllAndOverride<boolean>(ALLOWED_WHEN_DONE_KEY, targets);
    const { eventId, role } = await this.access.assert(user, null, [], refs, { write });
    req.eventAccessByField[field] = { eventId, role };
    return true;
  }
}
