import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard.getRequest', () => {
  const guard = new JwtAuthGuard(new Reflector());

  it('finds the request on a REST call', () => {
    const req = { headers: { authorization: 'Bearer abc' } };
    const ctx = new ExecutionContextHost([req, {}, () => undefined]);
    ctx.setType('http');
    expect(guard.getRequest(ctx)).toBe(req);
  });

  it('finds the request on a GraphQL call', () => {
    const req = { headers: { authorization: 'Bearer abc' } };
    // GraphQL resolvers receive (root, args, context, info); the request lives on context.
    const ctx = new ExecutionContextHost([{}, {}, { req }, {}]);
    ctx.setType('graphql');
    expect(guard.getRequest(ctx)).toBe(req);
  });
});
