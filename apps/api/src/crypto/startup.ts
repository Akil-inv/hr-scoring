import { DataKeyStore, Mode, encryptionMode, initKeys, keySource } from './field-crypto';
import { backfillEncryption, scanEncryption, totals } from './backfill';

type Client = {
  dataKey: unknown;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

/**
 * Unlock the key (or refuse to start), then encrypt anything still plain.
 * With no key configured, also refuse when encrypted values are still in the
 * database, so the app never serves data it cannot read.
 */
export async function startEncryption(db: Client, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Promise<Mode> {
  const mode = await initKeys(db.dataKey as DataKeyStore, env, log);
  if (mode === 'off') {
    const { encrypted } = totals(await scanEncryption(db));
    if (encrypted > 0) {
      throw new Error(`${encrypted} values in the database are encrypted but no key is set. Set KMS_KEY_ID, or the recovery key as FIELD_ENCRYPTION_KEY.`);
    }
    return mode;
  }
  const n = await backfillEncryption(db, log);
  if (n) log(`Encrypted ${n} existing rows.`);
  return mode;
}

export type EncryptionStatus = {
  mode: Mode;
  source: string;
  keys: { version: number; protectedBy: string; createdAt: string; recoveryKitPrintedAt: string | null; fingerprint: string | null }[];
  values: { encrypted: number; plain: number };
};

export async function encryptionStatus(db: Client): Promise<EncryptionStatus> {
  const rows = await (db.dataKey as any).findMany({ orderBy: { version: 'asc' } });
  return {
    mode: encryptionMode(),
    source: keySource(),
    keys: rows.map((r: any) => ({
      version: r.version,
      protectedBy: r.kmsKeyId === 'local' ? 'local key (no KMS)' : `AWS KMS ${r.kmsKeyId}`,
      createdAt: new Date(r.createdAt).toISOString(),
      recoveryKitPrintedAt: r.recoveryExportedAt ? new Date(r.recoveryExportedAt).toISOString() : null,
      fingerprint: r.checkValue ?? null,
    })),
    values: totals(await scanEncryption(db)),
  };
}
