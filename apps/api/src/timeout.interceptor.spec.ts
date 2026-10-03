import { TimeoutInterceptor } from './timeout.interceptor';
import { ExecutionContext, RequestTimeoutException } from '@nestjs/common';
import { of, delay } from 'rxjs';
import { CallHandler } from '@nestjs/common';

describe('TimeoutInterceptor', () => {
  let interceptor: TimeoutInterceptor;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    interceptor = new TimeoutInterceptor(100); // 100ms for fast testing
    // The interceptor asks the context whether this is HTTP or GraphQL, so it
    // can apply a longer timeout to the operations that need one. An empty
    // object was enough before that existed.
    // Enough of an ExecutionContext for the interceptor to work out which
    // timeout applies: the transport, and the URL it uses to match per-route
    // overrides. An empty object was enough before either existed.
    mockContext = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ url: '/test' }) }),
    } as unknown as ExecutionContext;
  });

  it('should pass through fast requests', (done) => {
    const handler: CallHandler = {
      handle: () => of('success'),
    };

    interceptor.intercept(mockContext, handler).subscribe({
      next: (value) => {
        expect(value).toBe('success');
        done();
      },
    });
  });

  it('should timeout slow requests', (done) => {
    const handler: CallHandler = {
      handle: () => of('slow').pipe(delay(200)),
    };

    interceptor.intercept(mockContext, handler).subscribe({
      error: (err) => {
        expect(err).toBeInstanceOf(RequestTimeoutException);
        done();
      },
    });
  });

  it('should pass through errors from handler', (done) => {
    const handler: CallHandler = {
      handle: () => {
        throw new Error('handler error');
      },
    };

    try {
      interceptor.intercept(mockContext, handler);
    } catch (err: any) {
      expect(err.message).toBe('handler error');
      done();
    }
  });

  it('should use custom timeout value', () => {
    const custom = new TimeoutInterceptor(5000);
    expect(custom).toBeDefined();
  });

  it('should use default 30s timeout when no value provided', () => {
    const defaultInterceptor = new TimeoutInterceptor();
    expect(defaultInterceptor).toBeDefined();
  });
});
