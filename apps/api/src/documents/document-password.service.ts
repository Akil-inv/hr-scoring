import { BadRequestException, ConflictException, HttpException, Inject, Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { AUTH_SERVICE } from '@akil-inv/auth-kit/nest';
import { AuthError, AuthService, passwordProblem, verifyPassword } from '@akil-inv/auth-kit/server';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
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
  ) {}

  async onModuleInit() {
    if (!(await pdfProtectionAvailable())) {
      this.logger.warn('qpdf is not installed: PDF downloads will be refused until it is (apt-get install qpdf).');
    }
  }

  async status(userId: string): Promise<{ set: boolean; setAt: string | null }> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { documentPasswordSetAt: true } });
    return { set: !!u?.documentPasswordSetAt, setAt: u?.documentPasswordSetAt?.toISOString() ?? null };
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
    if (unsafeForProtection(password)) throw new BadRequestException('The document password cannot start with "-" or contain line breaks.');
    if (user?.passwordHash && (await verifyPassword(password, user.passwordHash))) {
      throw new BadRequestException('Use a different password from the one you sign in with.');
    }
    const setAt = new Date();
    await this.prisma.user.update({ where: { id: userId }, data: { documentPassword: password, documentPasswordSetAt: setAt } });
    await this.audit.log({ userId, action: AuditAction.UPDATE, entityType: 'User', entityId: userId, reason: 'Document password set' });
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
        message: 'Your document password starts with "-", which files can\'t be locked with. Set a new one (My account → Document password).',
      });
    }
    if (!u?.documentPassword) {
      throw new ConflictException({
        statusCode: 409,
        code: 'document_password_required',
        message: 'Set your document password first (My account → Document password). Downloads open only with it.',
      });
    }
    return u.documentPassword;
  }

  private async record(userId: string, kind: DownloadKind, eventId: string | undefined, detail: Record<string, unknown>) {
    await this.audit.log({ userId, eventId, action: AuditAction.CREATE, entityType: 'Download', entityId: eventId ?? userId, reason: `Protected download: ${kind}`, newValues: detail });
  }

  async pdf(userId: string, pdf: Buffer, kind: DownloadKind, eventId?: string, detail: Record<string, unknown> = {}): Promise<Buffer> {
    const password = await this.passwordFor(userId);
    const out = await this.guard(() => protectPdf(pdf, password));
    await this.record(userId, kind, eventId, detail);
    return out;
  }

  /** Several PDFs for one download (a day's reports), each locked with the same password. */
  async pdfs(userId: string, files: { name: string; pdf: Buffer }[], kind: DownloadKind, eventId?: string, detail: Record<string, unknown> = {}) {
    const password = await this.passwordFor(userId);
    const out: { name: string; pdf: Buffer }[] = [];
    for (const f of files) out.push({ name: f.name, pdf: await this.guard(() => protectPdf(f.pdf, password)) });
    await this.record(userId, kind, eventId, { ...detail, files: files.length });
    return out;
  }

  async xlsx(userId: string, xlsx: Buffer, kind: DownloadKind, eventId?: string, detail: Record<string, unknown> = {}): Promise<Buffer> {
    const password = await this.passwordFor(userId);
    const out = await protectXlsx(xlsx, password);
    await this.record(userId, kind, eventId, detail);
    return out;
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
