import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuthError, hashPassword } from '@akil-inv/auth-kit/server';
import { DocumentPasswordService } from './document-password.service';

/** A user store and auth service just big enough for the rules. */
async function setup(opts: { documentPassword?: string | null; confirm?: (p: string) => Promise<boolean> } = {}) {
  const user: any = {
    id: 'u1', email: 'priya.menon@example.com',
    passwordHash: await hashPassword('sign-in-password-1'),
    documentPassword: opts.documentPassword ?? null,
    documentPasswordSetAt: opts.documentPassword ? new Date() : null,
  };
  const prisma: any = {
    user: {
      findUnique: async ({ select }: any) => Object.fromEntries(Object.keys(select).map((k) => [k, user[k]])),
      update: async ({ data }: any) => Object.assign(user, data),
    },
  };
  const logged: any[] = [];
  const audit: any = { log: async (e: any) => logged.push(e) };
  const auth: any = { confirmPassword: async (_: any, p: string) => (opts.confirm ? opts.confirm(p) : p === 'sign-in-password-1') };
  return { service: new DocumentPasswordService(prisma, audit, auth), user, logged };
}

describe('document password', () => {
  it('is set only after the sign-in password is confirmed', async () => {
    const { service, user } = await setup();
    await expect(service.set('u1', 'wrong', 'a-good-document-pass')).rejects.toThrow(BadRequestException);
    expect(user.documentPassword).toBeNull();
  });

  it('follows the sign-in password rules', async () => {
    const { service } = await setup();
    await expect(service.set('u1', 'sign-in-password-1', 'short')).rejects.toThrow(/at least 10/);
    await expect(service.set('u1', 'sign-in-password-1', 'priya.menon-docs')).rejects.toThrow(/email/);
    await expect(service.set('u1', 'sign-in-password-1', 'line\nbreak-password')).rejects.toThrow(/line breaks/);
  });

  it('must differ from the sign-in password', async () => {
    const { service } = await setup();
    await expect(service.set('u1', 'sign-in-password-1', 'sign-in-password-1')).rejects.toThrow(/different/);
  });

  it('is stored, reported as set (never returned), and audited', async () => {
    const { service, user, logged } = await setup();
    const r = await service.set('u1', 'sign-in-password-1', 'a-good-document-pass');
    expect(r.set).toBe(true);
    expect(user.documentPassword).toBe('a-good-document-pass');   // the Prisma middleware encrypts it at rest
    const status = await service.status('u1');
    expect(status).toEqual({ set: true, setAt: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain('a-good-document-pass');
    expect(logged[0]).toMatchObject({ entityType: 'User', reason: 'Document password set' });
  });

  it('refuses a download until one is set, and audits downloads', async () => {
    const none = await setup();
    await expect(none.service.xlsx('u1', Buffer.from('x'), 'data-export')).rejects.toThrow(ConflictException);
    const some = await setup({ documentPassword: 'a-good-document-pass' });
    const xlsx = require('xlsx');
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['a']]), 'S');
    const out = await some.service.xlsx('u1', xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'data-export', 'ev1', { export: 'scores' });
    expect(out.subarray(0, 2).toString()).not.toBe('PK');
    expect(some.logged.at(-1)).toMatchObject({ entityType: 'Download', eventId: 'ev1', reason: 'Protected download: data-export' });
  });

  it('passes on "too many attempts" (429) rather than failing with a server error', async () => {
    const { service } = await setup({ confirm: async () => { throw new AuthError(429, 'Too many attempts. Wait 15 minutes and try again.', 'too_many_attempts'); } });
    const e: any = await service.set('u1', 'x', 'a-good-document-pass').catch((x) => x);
    expect(e.getStatus?.()).toBe(429);
    expect(e.message).toMatch(/Too many attempts/);
  });
});
