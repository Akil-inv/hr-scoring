import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { GqlArgumentsHost, GqlContextType } from '@nestjs/graphql';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: any, host: ArgumentsHost) {
    // Handle GraphQL context differently
    if (host.getType<GqlContextType>() === 'graphql') {
      const gqlHost = GqlArgumentsHost.create(host);
      const info = gqlHost.getInfo();
      // Prisma's message is a multi-line invocation dump. Useful in a log,
      // unreadable in one, so it is collapsed to its first line here — and
      // what the caller sees is decided by formatError in app.module.ts, not
      // by this string.
      const rawMessage = exception instanceof HttpException
        ? exception.message
        : exception.message || 'Internal server error';
      const message = String(rawMessage).split('\n')[0].trim();

      this.logger.error(
        `GraphQL ${info?.fieldName || 'unknown'}: ${message}`,
        exception instanceof HttpException ? undefined : exception.stack,
      );

      // Re-throw for GraphQL error handling
      throw exception;
    }

    // Handle HTTP context
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (!request || !response) {
      this.logger.error('Non-HTTP exception', exception.stack);
      throw exception;
    }

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof HttpException
      ? exception.message
      : 'Internal server error';

    // Log with context
    this.logger.error(
      `${request.method} ${request.url} ${status} - ${message}`,
      status >= 500 ? exception.stack : undefined,
    );

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
