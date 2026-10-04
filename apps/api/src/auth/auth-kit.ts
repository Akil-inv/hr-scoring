import { ConfigService } from '@nestjs/config';
import { AuditAction } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthKitModule } from '@akil-inv/auth-kit/nest';
import { AuthEvent, AuthUser, UserAdapter } from '@akil-inv/auth-kit/server';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { decryptText, encryptText } from '../crypto/field-crypto';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Sign-in for HR Scoring, through the reusable auth-kit module: password and
 * two-factor sign-in, invite and reset links (copied by an admin, nothing is
 * emailed), email changes, and the admin's account actions. Routes are under
 * /api/auth. This file is the connection to our users table.
 */

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

type Row = { id: string; email: string; passwordHash: string; name: string; role: string };
const toAuthUser = (u: Row | null): (AuthUser & { role: string }) | null =>
  u && { id: u.id, email: u.email, passwordHash: u.passwordHash || null, name: u.name || null, role: u.role };

export function hrUsers(prisma: PrismaService): UserAdapter {
  return {
    async findByEmail(email) {
      return toAuthUser(await prisma.user.findFirst({ where: { email: { equals: email.trim(), mode: 'insensitive' } } }));
    },
    async findById(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      return toAuthUser(await prisma.user.findUnique({ where: { id } }));
    },
    async setPasswordHash(id, passwordHash) {
      await prisma.user.update({ where: { id }, data: { passwordHash } });
    },
    async setEmail(id, email) {
      await prisma.user.update({ where: { id }, data: { email } });
    },
    /**
     * Remove the account. If it made records that must keep pointing at it
     * (decisions, audit entries, closed days), keep the row but anonymise
     * it: no email, no name, no password, no event access.
     */
    async deleteUser(id) {
      await prisma.eventUser.deleteMany({ where: { userId: id } });
      try {
        await prisma.user.delete({ where: { id } });
      } catch (e) {
        // P2003: other records still point at this user.
        if ((e as { code?: string })?.code !== 'P2003') throw e;
        await prisma.user.update({
          where: { id },
          data: { email: `deleted-${id}@deleted.invalid`, name: 'Deleted user', phone: null, passwordHash: '' },
        });
      }
    },
    claims: (u) => ({ role: (u as any).role }),
    isAdmin: (actor) => ADMIN_ROLES.includes(String(actor.claims.role)),
    // Only a super admin manages a super admin.
    canManage: (actor, target) => (target as any).role !== 'SUPER_ADMIN' || actor.claims.role === 'SUPER_ADMIN',
    // Passwords set before auth-kit are bcrypt; they are moved to scrypt on next sign-in.
    verifyLegacyHash: (password, hash) => (hash.startsWith('$2') ? bcrypt.compare(password, hash) : Promise.resolve(false)),
  };
}

const EVENT_TEXT: Partial<Record<AuthEvent['type'], string>> = {
  login: 'Signed in',
  password_changed: 'Changed own password',
  password_reset: 'Set password from a link',
  email_changed: 'Sign-in email changed',
  email_change_requested: 'Asked to change email',
  link_created: 'Sign-in link created',
  two_factor_enabled: 'Two-factor turned on',
  two_factor_disabled: 'Two-factor turned off',
  two_factor_reset: 'Two-factor reset by an admin',
  recovery_codes_regenerated: 'New recovery codes',
  signed_out_everywhere: 'Signed out everywhere',
  user_deleted: 'User deleted',
  request_dismissed: 'Sign-in request dismissed',
  password_reset_requested: 'Asked for a password reset',
};

export const authKitModule = AuthKitModule.forRootAsync({
  inject: [PrismaService, ConfigService, AuditService],
  useFactory: (prisma: PrismaService, config: ConfigService, audit: AuditService) => ({
    config: {
      jwtSecret: config.get<string>('JWT_SECRET', 'dev-secret-change-in-production'),
      appName: 'HR Scoring',
      accessTokenTtl: 24 * 3600,
      // No publicUrl: nothing is emailed, so links use whatever address the admin has open
      // (the IP or the tailnet name), which is the one the person can reach too.
      // Two-factor secrets are encrypted like candidate data (AWS KMS when on).
      secretBox: { seal: (s: string) => encryptText(s), open: (s: string) => decryptText(s) },
      onEvent: async (e: AuthEvent) => {
        const text = EVENT_TEXT[e.type];
        // Failed sign-ins are not written: the actor may not exist, and the audit log needs a real user.
        if (!text || !e.actorId || !e.userId) return;
        const actor = await prisma.user.findUnique({ where: { id: e.actorId }, select: { id: true } });
        if (!actor) return;
        await audit.log({
          userId: e.actorId,
          action: e.type === 'user_deleted' ? AuditAction.DELETE : AuditAction.UPDATE,
          entityType: 'User',
          entityId: e.userId,
          reason: text,
          newValues: e.detail ?? undefined,
        });
      },
    },
    users: hrUsers(prisma),
    db: { query: (sql: string, params: unknown[] = []) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]> },
  }),
  publicRoute: { key: IS_PUBLIC_KEY, value: true },
});
