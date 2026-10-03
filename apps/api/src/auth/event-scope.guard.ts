import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Restrict a user to the events they have been assigned to.
 *
 * `EventUser` has recorded who belongs on which event since the beginning, and
 * nothing ever read it. So an admin brought in for one hackathon has identical
 * rights on every other event on the platform, and a coordinator can start
 * sessions on an event they have never heard of.
 *
 * This reads the `eventId` argument off any guarded operation and refuses when
 * the caller is not assigned. It deliberately does not chase indirect
 * references — an operation taking a session id could belong to any event, and
 * resolving that needs a lookup table per entity type. Those remain open, which
 * is a real gap and a smaller one than it sounds: reaching them requires a UUID
 * from an event the user cannot see, which means going after it deliberately
 * rather than wandering in.
 *
 * **Assignment is opt-in.** A user with no rows in `EventUser` keeps global
 * access. Nobody has any today, so denying by default would lock out every
 * account on deploy including the one that would fix it. Access tightens as
 * assignments are added rather than being switched off at once.
 *
 * **The judge portal is untouched.** It is a REST controller marked `@Public()`,
 * authenticates by token rather than login, and has no user to scope. Anything
 * that would gate it — a Prisma middleware, for instance — would break judging
 * on the day, so scoping belongs at the resolver rather than the data layer.
 */
@Injectable()
export class EventScopeGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // REST requests are the judge portal, which has no user and no event scope.
    if (context.getType<string>() !== 'graphql') return true;

    const ctx = GqlExecutionContext.create(context);
    const user = ctx.getContext().req?.user;
    if (!user) return true; // let the auth guard produce the error

    // Owns the platform, sees everything. Consistent with RolesGuard.
    if (user.role === 'SUPER_ADMIN') return true;

    const eventId = this.eventIdFrom(ctx.getArgs());
    if (!eventId) return true; // nothing to scope against

    const assignments = await this.prisma.eventUser.count({
      where: { userId: user.sub },
    });

    // No assignments at all means nobody has scoped this user yet.
    if (assignments === 0) return true;

    const assigned = await this.prisma.eventUser.findUnique({
      where: { userId_eventId: { userId: user.sub, eventId } },
      select: { id: true },
    });

    if (!assigned) {
      throw new ForbiddenException(
        'You are not assigned to this event. Ask a super admin to add you.',
      );
    }

    return true;
  }

  /**
   * The event an operation concerns, if it says so plainly.
   *
   * Checked both as a direct argument and inside an input object, since
   * mutations tend to wrap their arguments and queries tend not to.
   */
  private eventIdFrom(args: Record<string, any>): string | null {
    if (typeof args?.eventId === 'string') return args.eventId;
    if (typeof args?.input?.eventId === 'string') return args.input.eventId;
    return null;
  }
}
