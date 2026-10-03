import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { GqlExecutionContext } from '@nestjs/graphql';

/**
 * ThrottlerGuard for GraphQL.
 *
 * The stock guard reads the request via `switchToHttp().getRequest()`, which
 * returns undefined under GraphQL. `getTracker()` then dereferences `req.ip`
 * and throws — and because ThrottlerGuard is registered first in APP_GUARD, it
 * throws before authentication is even attempted, so every authenticated
 * operation fails with "Cannot read properties of undefined (reading 'ip')".
 *
 * GqlExecutionContext exposes the underlying req/res instead.
 *
 * Note this is invisible to a unit test suite that never boots the HTTP layer:
 * the guard is registered at module level and only runs against a real request.
 */
@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext) {
    const ctx = GqlExecutionContext.create(context).getContext();

    // The GraphQL context factory supplies `req`. `res` is taken from the
    // context when present and from Express's `req.res` otherwise, because the
    // throttler writes its rate-limit headers to it.
    const req = ctx?.req;
    const res = ctx?.res ?? req?.res;

    return { req, res };
  }

  /**
   * Subscriptions arrive over a websocket with no HTTP request, and there is
   * nothing to rate-limit by IP. Skipping is safer than throwing: the failure
   * mode we are fixing is exactly a guard that throws when it cannot find a
   * request.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    if (!req) return true;
    return super.canActivate(context);
  }
}
