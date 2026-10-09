import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type PlatformSettings = { fileProtection: boolean; twoFactor: boolean; updatedAt: Date | null; updatedById: string | null };

/** Today's behaviour, used until a super admin changes something (and if the row is ever missing). */
const DEFAULTS: PlatformSettings = { fileProtection: true, twoFactor: true, updatedAt: null, updatedById: null };

/**
 * Platform-wide switches for features some users don't want, kept rather than
 * removed: file passwords on downloads, and two-factor sign-in. Read fresh on
 * each use (a download, a sign-in), so a change applies at once without a
 * restart, on every API instance.
 */
@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async get(): Promise<PlatformSettings> {
    const row = await this.prisma.platformSetting.findUnique({ where: { id: 1 } });
    if (!row) return { ...DEFAULTS };
    // updatedAt only once someone has changed something (the row is created with the defaults).
    return { fileProtection: row.fileProtection, twoFactor: row.twoFactor, updatedAt: row.updatedById ? row.updatedAt : null, updatedById: row.updatedById };
  }

  async fileProtection(): Promise<boolean> {
    return (await this.get()).fileProtection;
  }

  async twoFactor(): Promise<boolean> {
    return (await this.get()).twoFactor;
  }

  async update(change: { fileProtection?: boolean; twoFactor?: boolean }, byUserId: string): Promise<PlatformSettings> {
    const data = {
      ...(typeof change.fileProtection === 'boolean' ? { fileProtection: change.fileProtection } : {}),
      ...(typeof change.twoFactor === 'boolean' ? { twoFactor: change.twoFactor } : {}),
      updatedById: byUserId,
    };
    await this.prisma.platformSetting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
    return this.get();
  }
}
