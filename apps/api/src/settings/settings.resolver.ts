import { BadRequestException, HttpException, Inject } from '@nestjs/common';
import { Args, Field, GraphQLISODateTime, InputType, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AuditAction } from '@prisma/client';
import { AUTH_SERVICE } from '@akil-inv/auth-kit/nest';
import { AuthError, AuthService } from '@akil-inv/auth-kit/server';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { NotEventScoped } from '../auth/event-access';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from './settings.service';

@ObjectType()
export class PlatformSettingsView {
  /** Downloads are locked: the file's first 4 letters + the downloader's HR code. */
  @Field() fileProtection!: boolean;
  /** Two-factor sign-in is offered, and asked for from people who set it up. */
  @Field() twoFactor!: boolean;
  @Field(() => GraphQLISODateTime, { nullable: true }) updatedAt!: Date | null;
}

@InputType()
export class PlatformSettingsInput {
  @Field({ nullable: true }) fileProtection?: boolean;
  @Field({ nullable: true }) twoFactor?: boolean;
}

const LABEL = { fileProtection: 'File passwords on downloads', twoFactor: 'Two-factor sign-in' } as const;

/**
 * The platform switches. Anyone signed in may read them (the app hides what is
 * off); only a super admin changes them, after re-entering their sign-in
 * password, and every change is in the audit log.
 */
@Resolver()
export class SettingsResolver {
  constructor(
    private settings: SettingsService,
    private audit: AuditService,
    @Inject(AUTH_SERVICE) private auth: AuthService,
  ) {}

  @NotEventScoped()
  @Query(() => PlatformSettingsView)
  platformSettings() {
    return this.settings.get();
  }

  @NotEventScoped()
  @Roles('SUPER_ADMIN')
  @Mutation(() => PlatformSettingsView)
  async updatePlatformSettings(
    @Args('input') input: PlatformSettingsInput,
    @Args('signInPassword') signInPassword: string,
    @CurrentUser() user: any,
  ) {
    let ok = false;
    try {
      ok = await this.auth.confirmPassword({ id: user.sub } as any, String(signInPassword ?? ''));
    } catch (err) {
      if (err instanceof AuthError) throw new HttpException({ statusCode: err.status, message: err.message, code: err.code }, err.status);
      throw err;
    }
    if (!ok) throw new BadRequestException('Your sign-in password is not right.');

    const before = await this.settings.get();
    const changes = Object.fromEntries((['fileProtection', 'twoFactor'] as const)
      .filter((k) => typeof input?.[k] === 'boolean' && input[k] !== before[k]).map((k) => [k, input[k]]));
    if (Object.keys(changes).length === 0) return before;
    const after = await this.settings.update(changes, user.sub);
    // Back on: sessions started without a code while it was off end now, so
    // everyone with two-factor set up is asked for their code again.
    if (!before.twoFactor && after.twoFactor) await this.auth.adminSignOutTwoFactorUsers({ id: user.sub, email: user.email, claims: { role: user.role } });
    for (const key of ['fileProtection', 'twoFactor'] as const) {
      if (before[key] === after[key]) continue;
      await this.audit.log({
        userId: user.sub, action: AuditAction.UPDATE, entityType: 'PlatformSetting', entityId: '1',
        reason: `${LABEL[key]} turned ${after[key] ? 'on' : 'off'}`,
        oldValues: { [key]: before[key] }, newValues: { [key]: after[key] },
      });
    }
    return after;
  }
}
