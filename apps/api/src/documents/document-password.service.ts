import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AUTH_SERVICE } from '@akil-inv/auth-kit/nest';
import { AuthError, AuthService, passwordProblem, verifyPassword } from '@akil-inv/auth-kit/server';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { pdfProtectionAvailable, protectPdf, protectXlsx, ProtectionUnavailable, unsafeForProtection } from './protect';

/**
 * Each user's document password, and the protection of what they download.
 *
 * Every report PDF and Excel export is locked with the document password of
 * the person downloading it, at the moment of download. The stored reports are
 * untouched (they stay encrypted in the database as before). Someone else's
 * download of the same report opens only with their own password.
 *
 * The document password is not the sign-in password (refused if it is the
 * same), is stored encrypted, and is set or changed only by its owner after
 * re-entering their sign-in password. Forgotten: set a new one and download
 * again; files already downloaded keep the old one.
 */

/**
 * Each file opens with its own password: the first four letters of what the
 * file is about (the candidate for a report, the event for an export) in
 * capitals, followed by the downloader's HR code. "Priya Menon" with HR code
 * k7#pQ29xLm opens with PRIYk7#pQ29xLm. Sharing one file's password gives
 * away the HR code, so the code stays the secret; the prefix keeps a password
 * typed for one candidate's report from opening another candidate's.
 *
 * Letters only, accents dropped; digits count; short names are padded with X.
 */
export function filePrefix(subject: string): string {
  const plain = String(subject ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (plain + 'XXXX').slice(0, 4);
}

/** As long as a sign-in password must be (auth-kit's default). */
const MIN_LENGTH = 10;

export type DownloadKind = 'report' | 'report-preview' | 'day-reports' | 'results-export' | 'data-export';

@Injectable()
export class DocumentPasswordService implements OnModuleInit {
  private readonly logger = new Logger('Documents');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    @Inject(AUTH_SERVICE) private auth: AuthService,
    private settings: SettingsService,
  ) {}

  async onModuleInit() {
    if (!(await pdfProtectionAvailable())) {
      this.logger.warn('qpdf is not installed: PDF downloads will be refused until it is (apt-get install qpdf).');
    }
  }

  /** `required`: whether downloads are locked at all (a super admin can switch file passwords off). */
  async status(userId: string): Promise<{ set: boolean; setAt: string | null; required: boolean }> {
    const required = await this.settings.fileProtection();
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { documentPasswordSetAt: true } });
    return { set: !!u?.documentPasswordSetAt, setAt: u?.documentPasswordSetAt?.toISOString() ?? null, required };
  }

  async set(userId: string, signInPassword: string, password: string): Promise<{ set: true; setAt: string }> {
    password = String(password ?? '');
    let confirmed = false;
    try {
      confirmed = await this.auth.confirmPassword({ id: userId } as any, String(signInPassword ?? ''));
    } catch (e) {
      // auth-kit's own errors (too many attempts: 429) keep their status and message.
      if (e instanceof AuthError) throw new HttpException({ statusCode: e.status, message: e.message, code: e.code }, e.status);
      throw e;
    }
    if (!confirmed) throw new BadRequestException('Your sign-in password is not right.');
    // After a successful confirm the stored hash is auth-kit's own, so the same-password check is exact.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true, email: true } });
    // The same rules as sign-in passwords (length, not the email, not a common one).
    const problem = passwordProblem(password, user?.email ?? '', MIN_LENGTH);
    if (problem) throw new BadRequestException(problem);
    if (unsafeForProtection(password)) throw new BadRequestException('The HR code cannot start with "-" or contain line breaks.');
    if (user?.passwordHash && (await verifyPassword(password, user.passwordHash))) {
      throw new BadRequestException('Use an HR code different from the password you sign in with.');
    }
    const setAt = new Date();
    await this.prisma.user.update({ where: { id: userId }, data: { documentPassword: password, documentPasswordSetAt: setAt } });
    await this.audit.log({ userId, action: AuditAction.UPDATE, entityType: 'User', entityId: userId, reason: 'HR code set' });
    return { set: true, setAt: setAt.toISOString() };
  }

  /** The password to lock this user's download with; a clear refusal if they have none yet. */
  private async passwordFor(userId: string): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { documentPassword: true } });
    if (u?.documentPassword && unsafeForProtection(u.documentPassword)) {
      // Set before this rule existed: ask for a new one rather than failing the download.
      throw new ConflictException({
        statusCode: 409,
        code: 'document_password_unusable',
        message: 'Your HR code starts with "-", which files can\'t be locked with. Set a new one (My account → HR code).',
      });
    }
    if (!u?.documentPassword) {
      throw new ConflictException({
        statusCode: 409,
        code: 'document_password_required',
        message: 'Set your HR code first (My account → HR code). Each file opens with the first four letters of its name plus your HR code.',
      });
    }
    return u.documentPassword;
  }

  private async record(userId: string, kind: DownloadKind, eventId: string | undefined, detail: Record<string, unknown>, locked = true) {
    await this.audit.log({ userId, eventId, action: AuditAction.CREATE, entityType: 'Download', entityId: eventId ?? userId, reason: `${locked ? 'Protected' : 'Unprotected'} download: ${kind}`, newValues: detail });
  }

  /*
   * With file passwords switched off (Settings, super admin), files go out as
   * they are: no HR code needed, prefix null, and the download is still in
   * the audit log, marked unprotected.
   */

  /** `subject`: who or what the file is about; its first four letters start the file's password. */
  async pdf(userId: string, pdf: Buffer, kind: DownloadKind, subject: string, eventId?: string, detail: Record<string, unknown> = {}): Promise<{ file: Buffer; prefix: string | null }> {
    if (!(await this.settings.fileProtection())) {
      await this.record(userId, kind, eventId, detail, false);
      return { file: pdf, prefix: null };
    }
    const code = await this.passwordFor(userId);
    const prefix = filePrefix(subject);
    const file = await this.guard(() => protectPdf(pdf, prefix + code));
    await this.record(userId, kind, eventId, { ...detail, prefix });
    return { file, prefix };
  }

  /** Several PDFs for one download (a day's reports), each with its own candidate's prefix. */
  async pdfs(userId: string, files: { name: string; pdf: Buffer; subject: string }[], kind: DownloadKind, eventId?: string, detail: Record<string, unknown> = {}) {
    if (!(await this.settings.fileProtection())) {
      await this.record(userId, kind, eventId, { ...detail, files: files.length }, false);
      return files.map((f) => ({ name: f.name, pdf: f.pdf }));
    }
    const code = await this.passwordFor(userId);
    const out: { name: string; pdf: Buffer }[] = [];
    for (const f of files) out.push({ name: f.name, pdf: await this.guard(() => protectPdf(f.pdf, filePrefix(f.subject) + code)) });
    await this.record(userId, kind, eventId, { ...detail, files: files.length });
    return out;
  }

  async xlsx(userId: string, xlsx: Buffer, kind: DownloadKind, subject: string, eventId?: string, detail: Record<string, unknown> = {}): Promise<{ file: Buffer; prefix: string | null }> {
    if (!(await this.settings.fileProtection())) {
      await this.record(userId, kind, eventId, detail, false);
      return { file: xlsx, prefix: null };
    }
    const code = await this.passwordFor(userId);
    const prefix = filePrefix(subject);
    const file = await protectXlsx(xlsx, prefix + code);
    await this.record(userId, kind, eventId, { ...detail, prefix });
    return { file, prefix };
  }

  private async guard<T>(f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ProtectionUnavailable) throw new ServiceUnavailableException(e.message);
      throw e;
    }
  }
}
