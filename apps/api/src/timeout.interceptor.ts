import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  RequestTimeoutException,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Observable, throwError, TimeoutError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

/**
 * Per-operation timeouts.
 *
 * The default of 30s is right for ordinary queries — a request still running
 * after 30 seconds is almost certainly stuck, and failing fast frees the
 * connection. But a few operations legitimately take longer, and a blanket
 * 30s silently discarded work the scheduler had already completed.
 *
 * Every value here must stay BELOW the nginx proxy_read_timeout (180s), so a
 * slow operation fails inside the API with a clear message rather than as an
 * opaque 504 from the proxy.
 *
 * Layers, innermost first:
 *   solver (CP-SAT)          120s   apps/scheduler/src/solver.py
 *   this interceptor         150s   for generateSchedule
 *   nginx proxy_read_timeout 180s   nginx/default.conf
 *   ALB idle timeout         720s   AWS console
 */
const GRAPHQL_TIMEOUTS_MS: Record<string, number> = {
  // Solver is allowed 120s; this leaves headroom for HTTP overhead and for
  // persisting the returned assignments.
  // Guided mode runs a sequence of solves rather than one, so it is
  // legitimately slower. 150s was sized for a single 65-team solve.
  generateSchedule: 300_000,

  // Writes one session row per team plus judge assignments.
  saveScheduleSessions: 60_000,

  // Averages every criterion across every judge for every team.
  calculateRankings: 60_000,
};

/** Matched by URL prefix, longest prefix wins. */
const HTTP_TIMEOUTS_MS: Record<string, number> = {
  '/api/export': 120_000,
  '/api/import': 60_000,
};

const DEFAULT_TIMEOUT_MS = 30_000;

@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const timeoutMs = this.resolveTimeout(context);

    return next.handle().pipe(
      timeout(timeoutMs),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(
            () =>
              new RequestTimeoutException(
                `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
              ),
          );
        }
        return throwError(() => err);
      }),
    );
  }

  private resolveTimeout(context: ExecutionContext): number {
    if (context.getType<'graphql' | 'http'>() === 'graphql') {
      const fieldName = GqlExecutionContext.create(context).getInfo()?.fieldName;
      return GRAPHQL_TIMEOUTS_MS[fieldName] ?? this.timeoutMs;
    }

    const url: string = context.switchToHttp().getRequest()?.url ?? '';
    const match = Object.keys(HTTP_TIMEOUTS_MS)
      .filter((prefix) => url.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];

    return match ? HTTP_TIMEOUTS_MS[match] : this.timeoutMs;
  }
}
