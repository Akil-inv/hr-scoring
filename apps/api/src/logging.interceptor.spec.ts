import { LoggingInterceptor } from './logging.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of, throwError } from 'rxjs';

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let mockContext: ExecutionContext;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  it('should pass through successful HTTP requests', (done) => {
    mockContext = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'GET', url: '/test' }),
      }),
    } as any;

    const handler: CallHandler = { handle: () => of({ data: 'success' }) };

    interceptor.intercept(mockContext, handler).subscribe({
      next: (value) => {
        expect(value).toEqual({ data: 'success' });
        done();
      },
    });
  });

  it('should handle requests without method gracefully', (done) => {
    mockContext = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({}),
      }),
    } as any;

    const handler: CallHandler = { handle: () => of('ok') };

    interceptor.intercept(mockContext, handler).subscribe({
      next: (value) => {
        expect(value).toBe('ok');
        done();
      },
    });
  });

  it('should propagate errors from handler', (done) => {
    mockContext = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', url: '/api/test' }),
      }),
    } as any;

    const handler: CallHandler = { handle: () => throwError(() => new Error('test error')) };

    interceptor.intercept(mockContext, handler).subscribe({
      error: (err) => {
        expect(err.message).toBe('test error');
        done();
      },
    });
  });
});
