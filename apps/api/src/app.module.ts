import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { APP_GUARD } from '@nestjs/core';
import { join } from 'path';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { EventsModule } from './events/events.module';
import { TracksModule } from './tracks/tracks.module';
import { RoomsModule } from './rooms/rooms.module';
import { TeamsModule } from './teams/teams.module';
import { JudgesModule } from './judges/judges.module';
import { ConflictsModule } from './conflicts/conflicts.module';
import { ScoringTemplatesModule } from './scoring-templates/scoring-templates.module';
import { SchedulingModule } from './scheduling/scheduling.module';
import { SessionsModule } from './sessions/sessions.module';
import { ScorecardsModule } from './scorecards/scorecards.module';
import { RankingsModule } from './rankings/rankings.module';
import { ExportModule } from './export/export.module';
import { NotificationModule } from './notification/notification.module';
import { UsersModule } from './users/users.module';
import { HealthController } from './health.controller';
import { JudgePortalModule } from './judge-portal/judge-portal.module';
import { OperationsModule } from './operations/operations.module';
import { HealthResolver } from './health.resolver';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { EventScopeGuard } from './auth/event-scope.guard';
import { GqlThrottlerGuard } from './common/gql-throttler.guard';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    /**
     * Rate limiting.
     *
     * Deliberately generous. Thirty-three judges polling every thirty seconds
     * is normal use of this platform, and a judge throttled mid-event would
     * have no idea why. The limit exists to stop credential stuffing and token
     * enumeration, not to shape traffic.
     */
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      // On in development, off in production. Introspection publishes the whole
      // schema, which is a map of the API for anyone who asks for it.
      playground: process.env.NODE_ENV !== 'production',
      introspection: process.env.NODE_ENV !== 'production',
      subscriptions: { 'graphql-ws': true },
      /**
       * What a caller sees when something goes wrong.
       *
       * A resolver that receives an id which is not a UUID passes it straight
       * to Prisma, whose cast fails and whose error — naming the model, the
       * invocation, and in development the source file and surrounding lines —
       * was being returned verbatim as an INTERNAL_SERVER_ERROR. Fifty-six
       * resolvers take an id argument, so this is one defect with fifty-six
       * doors rather than fifty-six defects.
       *
       * An id that is not an id is a bad request. Translated here rather than
       * in each resolver, because the doors we have not thought of are the ones
       * that matter.
       */
      formatError: (formatted: any, original: any) => {
        const raw = String(
          original?.originalError?.message ?? formatted?.message ?? '',
        );

        const isPrismaLeak =
          raw.includes('Invalid `prisma.') ||
          raw.includes('Invalid `this.prisma.') ||
          raw.includes('Error creating UUID') ||
          raw.includes('Inconsistent column data') ||
          raw.startsWith('PrismaClient');

        if (isPrismaLeak) {
          const path = formatted?.path?.join('.') ?? 'request';
          return {
            message: /UUID|Inconsistent column data/.test(raw)
              ? 'Invalid identifier'
              : 'Invalid request',
            path: formatted?.path,
            locations: formatted?.locations,
            extensions: { code: 'BAD_USER_INPUT', field: path },
          };
        }

        /**
         * A deliberate exception is not a server error.
         *
         * A service throwing NotFoundException, ConflictException or
         * BadRequestException is answering the caller, not failing. Apollo
         * labels all of them INTERNAL_SERVER_ERROR and attaches a stack trace,
         * so a client cannot tell "that session does not exist" from "the
         * server fell over" — and every such answer leaks internals.
         *
         * The HTTP status is already in extensions.status; it just was not
         * being used.
         */
        const status = Number((formatted?.extensions as any)?.status ?? 0);
        const codeFor: Record<number, string> = {
          400: 'BAD_USER_INPUT',
          401: 'UNAUTHENTICATED',
          403: 'FORBIDDEN',
          404: 'NOT_FOUND',
          409: 'CONFLICT',
          413: 'PAYLOAD_TOO_LARGE',
          422: 'BAD_USER_INPUT',
          429: 'TOO_MANY_REQUESTS',
        };

        if (codeFor[status]) {
          return {
            message: formatted.message,
            path: formatted.path,
            locations: formatted.locations,
            extensions: { code: codeFor[status], status },
          };
        }

        // Stack traces are useful in a log and are nobody's business in a
        // response. Apollo omits them outside development already; stated
        // explicitly so a later config change cannot quietly reinstate them.
        if (process.env.NODE_ENV === 'production' && formatted?.extensions) {
          const { stacktrace, ...rest } = formatted.extensions as any;
          return { ...formatted, extensions: rest };
        }

        return formatted;
      },
      // `res` as well as `req`: the throttler writes its rate-limit headers
      // to the response, and GqlThrottlerGuard reads both from here.
      context: ({ req, res }: { req: Request; res: Response }) => ({ req, res }),
    }),
    PrismaModule,
    AuthModule,
    AuditModule,
    EventsModule,
    TracksModule,
    RoomsModule,
    TeamsModule,
    JudgesModule,
    ConflictsModule,
    ScoringTemplatesModule,
    SchedulingModule,
    SessionsModule,
    ScorecardsModule,
    RankingsModule,
    ExportModule,
    NotificationModule,
    UsersModule,
    JudgePortalModule,
    OperationsModule,
  ],
  providers: [
    HealthResolver,
    // GqlThrottlerGuard, not ThrottlerGuard: the stock guard resolves the
    // request through switchToHttp(), which is undefined under GraphQL, and
    // throws on req.ip before any other guard runs.
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // After RolesGuard: role first, then whether this user may touch this
    // event. A coordinator who fails the role check should be told that rather
    // than being told they are on the wrong event.
    { provide: APP_GUARD, useClass: EventScopeGuard },
  ],
})
export class AppModule {}
