import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const start = Date.now();

    if (context.getType<GqlContextType>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const info = gqlContext.getInfo();
      const operationType = info.parentType?.name || 'Query';
      const fieldName = info.fieldName;

      return next.handle().pipe(
        tap({
          next: () => {
            const ms = Date.now() - start;
            if (ms > 1000) {
              this.logger.warn(`${operationType}.${fieldName} ${ms}ms (slow)`);
            }
          },
          error: (err) => {
            const ms = Date.now() - start;
            this.logger.error(`${operationType}.${fieldName} ${ms}ms - ${err.message}`);
          },
        }),
      );
    }

    const request = context.switchToHttp().getRequest();
    if (!request?.method) return next.handle();

    const { method, url } = request;

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          if (ms > 1000) {
            this.logger.warn(`${method} ${url} ${ms}ms (slow)`);
          }
        },
        error: (err) => {
          const ms = Date.now() - start;
          this.logger.error(`${method} ${url} ${ms}ms - ${err.message}`);
        },
      }),
    );
  }
}
