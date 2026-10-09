import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuthError, hashPassword } from '@akil-inv/auth-kit/server';
import { DocumentPasswordService, filePrefix } from './document-password.service';

/** A user store and auth service just big enough for the rules. */
async function setup(opts: { documentPassword?: string | null; confirm?: (p: string) => Promise<boolean>; protection?: boolean } = {}) {
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
  const settings: any = { fileProtection: async () => opts.protection ?? true };
  return { service: new DocumentPasswordService(prisma, audit, auth, settings), user, logged };
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
    await expect(service.set('u1', 'sign-in-password-1', '-dash-first-password')).rejects.toThrow(/cannot start with "-"/);
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
    expect(status).toEqual({ set: true, setAt: expect.any(String), required: true });
    expect(JSON.stringify(status)).not.toContain('a-good-document-pass');
    expect(logged[0]).toMatchObject({ entityType: 'User', reason: 'HR code set' });
  });

  it('refuses a download until one is set, and audits downloads', async () => {
    const none = await setup();
    await expect(none.service.xlsx('u1', Buffer.from('x'), 'data-export', 'Graduate Hiring')).rejects.toThrow(ConflictException);
    const some = await setup({ documentPassword: 'a-good-document-pass' });
    const xlsx = require('xlsx');
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['a']]), 'S');
    const out = await some.service.xlsx('u1', xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'data-export', 'Graduate Hiring', 'ev1', { export: 'scores' });
    expect(out.file.subarray(0, 2).toString()).not.toBe('PK');
    expect(out.prefix).toBe('GRAD');
    expect(some.logged.at(-1)).toMatchObject({ entityType: 'Download', eventId: 'ev1', reason: 'Protected download: data-export' });
    // Opens with the prefix + HR code, and not with the HR code alone.
    const officeCrypto = require('officecrypto-tool');
    await expect(officeCrypto.decrypt(out.file, { password: 'GRADa-good-document-pass' })).resolves.toBeTruthy();
    await expect(officeCrypto.decrypt(out.file, { password: 'a-good-document-pass' })).rejects.toBeTruthy();
  });

  it('passes on "too many attempts" (429) rather than failing with a server error', async () => {
    const { service } = await setup({ confirm: async () => { throw new AuthError(429, 'Too many attempts. Wait 15 minutes and try again.', 'too_many_attempts'); } });
    const e: any = await service.set('u1', 'x', 'a-good-document-pass').catch((x) => x);
    expect(e.getStatus?.()).toBe(429);
    expect(e.message).toMatch(/Too many attempts/);
  });

  it('asks for a new password, rather than failing, if the old one starts with "-"', async () => {
    const { service } = await setup({ documentPassword: '-set-before-the-rule' });
    const e: any = await service.pdf('u1', Buffer.from('%PDF'), 'report', 'Priya').catch((x) => x);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.message).toMatch(/Set a new one/);
  });
});

describe('file passwords switched off (Settings)', () => {
  it('files go out as they are, with no HR code needed, and the download is still audited', async () => {
    const { service, logged } = await setup({ protection: false });
    const pdf = Buffer.from('%PDF-1.4 not really');
    const out = await service.pdf('u1', pdf, 'report', 'Priya Menon', 'e1');
    expect(out).toEqual({ file: pdf, prefix: null });
    const xlsx = Buffer.from('PK not really');
    expect(await service.xlsx('u1', xlsx, 'data-export', 'October Interviews', 'e1')).toEqual({ file: xlsx, prefix: null });
    const many = await service.pdfs('u1', [{ name: 'a.pdf', pdf, subject: 'Ann' }], 'day-reports', 'e1');
    expect(many).toEqual([{ name: 'a.pdf', pdf }]);
    expect(logged.map((l) => l.reason)).toEqual(['Unprotected download: report', 'Unprotected download: data-export', 'Unprotected download: day-reports']);
    expect((await service.status('u1')).required).toBe(false);
  });
});

describe('file passwords', () => {
  it('start with the first four letters of the name, in capitals', () => {
    expect(filePrefix('Priya Menon')).toBe('PRIY');
    expect(filePrefix("O'Brien")).toBe('OBRI');
    expect(filePrefix('Zoë Ang')).toBe('ZOEA');
    expect(filePrefix('Li')).toBe('LIXX');
    expect(filePrefix('Candidate #0001')).toBe('CAND');
    expect(filePrefix('李明')).toBe('XXXX');
  });

  it('each report opens only with its own candidate\'s prefix + the HR code', async () => {
    const { execFileSync } = require('child_process');
    const fs = require('fs'), os = require('os'), path = require('path');
    const PDFDocument = require('pdfkit');
    const sample = await new Promise<Buffer>((resolve) => { const d = new PDFDocument(); const p: Buffer[] = []; d.on('data', (c: Buffer) => p.push(c)); d.on('end', () => resolve(Buffer.concat(p))); d.text('x'); d.end(); });
    const { service } = await setup({ documentPassword: 'a-good-document-pass' });
    const [priya, daniel] = await service.pdfs('u1', [{ name: 'a.pdf', pdf: sample, subject: 'Priya Menon' }, { name: 'b.pdf', pdf: sample, subject: 'Daniel Koh' }], 'day-reports');
    const opens = (pdf: Buffer, pw: string) => {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-')), 'f.pdf');
      fs.writeFileSync(f, pdf);
      try { execFileSync('qpdf', ['--check', `--password=${pw}`, f], { stdio: 'pipe' }); return true; } catch { return false; }
    };
    expect(opens(priya.pdf, 'PRIYa-good-document-pass')).toBe(true);
    expect(opens(priya.pdf, 'a-good-document-pass')).toBe(false);
    expect(opens(daniel.pdf, 'PRIYa-good-document-pass')).toBe(false);
    expect(opens(daniel.pdf, 'DANIa-good-document-pass')).toBe(true);
  });
});
