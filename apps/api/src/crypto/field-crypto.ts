import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';

/**
 * Field encryption: the primitives and the keys.
 *
 * Envelope encryption. A 256-bit data key encrypts the fields (AES-256-GCM).
 * The data key is never stored readable: the database holds it encrypted by
 * an AWS KMS key, and the API asks KMS to unlock it once at startup. A copy
 * of the database or a backup is therefore useless without the KMS key, and
 * every unlock is recorded in AWS CloudTrail.
 *
 * Modes:
 *   kms    KMS_KEY_ID is set (production).
 *   local  FIELD_ENCRYPTION_KEY (base64, 32 bytes) is set: tests and local runs.
 *   off    neither: values are stored as they are (the state before encryption
 *          was configured). Encrypted values still cannot be read without a key.
 *
 * Stored formats (each carries its key version so keys can be rotated):
 *   text   "enc:v1:<base64url iv|tag|ciphertext>"   random IV
 *   det    "det:v1:<...>"                            IV derived from the value,
 *          so the same value always encrypts the same way: exact-match lookups
 *          and unique constraints keep working (candidate names, judge emails).
 *   bytes  "ENC1" | version (2 bytes) | iv | tag | ciphertext
 */

export type Mode = 'kms' | 'local' | 'off';
type Key = { enc: Buffer; mac: Buffer };

const MAGIC = Buffer.from('ENC1');
const keys = new Map<number, Key>();
let current: number | null = null;
let mode: Mode = 'off';

export function encryptionMode(): Mode {
  return mode;
}

function derive(dataKey: Buffer): Key {
  return {
    enc: Buffer.from(hkdfSync('sha256', dataKey, Buffer.from('hr-scoring'), Buffer.from('field-encryption'), 32)),
    mac: Buffer.from(hkdfSync('sha256', dataKey, Buffer.from('hr-scoring'), Buffer.from('field-deterministic-iv'), 32)),
  };
}

/** Use these data keys; the highest version encrypts new values. For tests and startup. */
export function setKeys(next: Mode, dataKeys: { version: number; key: Buffer }[]) {
  keys.clear();
  current = null;
  for (const k of dataKeys) {
    if (k.key.length !== 32) throw new Error(`Data key version ${k.version} is not 32 bytes.`);
    keys.set(k.version, derive(k.key));
    if (current === null || k.version > current) current = k.version;
  }
  mode = dataKeys.length ? next : 'off';
}

/** Minimal shape of the table that stores the encrypted data keys. */
export type DataKeyStore = {
  findMany(args: { orderBy: { version: 'asc' } }): Promise<{ version: number; kmsKeyId: string; encryptedKey: Uint8Array }[]>;
  create(args: { data: { version: number; kmsKeyId: string; encryptedKey: Buffer } }): Promise<unknown>;
};

/**
 * Load the keys at startup. With KMS: the first start creates the data key
 * (KMS GenerateDataKey) and stores it encrypted; every start unlocks the
 * stored keys (KMS Decrypt). Fails loudly rather than run without the key
 * when KMS is configured but unreachable or not permitted.
 */
export async function initKeys(store: DataKeyStore, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Promise<Mode> {
  if (env.KMS_KEY_ID) {
    const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = await import('@aws-sdk/client-kms');
    const kms = new KMSClient({ region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-southeast-1' });
    let rows = await store.findMany({ orderBy: { version: 'asc' } });
    if (rows.length === 0) {
      const out = await kms.send(new GenerateDataKeyCommand({ KeyId: env.KMS_KEY_ID, KeySpec: 'AES_256' }));
      if (!out.CiphertextBlob || !out.Plaintext) throw new Error('KMS did not return a data key.');
      await store.create({ data: { version: 1, kmsKeyId: env.KMS_KEY_ID, encryptedKey: Buffer.from(out.CiphertextBlob) } });
      log('Created the field-encryption data key with KMS (version 1).');
      rows = await store.findMany({ orderBy: { version: 'asc' } });
    }
    const unlocked: { version: number; key: Buffer }[] = [];
    for (const r of rows) {
      const out = await kms.send(new DecryptCommand({ CiphertextBlob: Buffer.from(r.encryptedKey), KeyId: r.kmsKeyId }));
      if (!out.Plaintext) throw new Error(`KMS could not unlock data key version ${r.version}.`);
      unlocked.push({ version: r.version, key: Buffer.from(out.Plaintext) });
    }
    setKeys('kms', unlocked);
    log(`Field encryption on (AWS KMS, ${unlocked.length} data key${unlocked.length === 1 ? '' : 's'}).`);
    return mode;
  }
  if (env.FIELD_ENCRYPTION_KEY) {
    const key = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
    setKeys('local', [{ version: 1, key }]);
    log('Field encryption on (local key from FIELD_ENCRYPTION_KEY). Use KMS_KEY_ID in production.');
    return mode;
  }
  if ((await store.findMany({ orderBy: { version: 'asc' } })).length > 0) {
    throw new Error('This database holds encrypted data but KMS_KEY_ID is not set. Set it in .env and restart.');
  }
  setKeys('off', []);
  log('Field encryption is OFF: set KMS_KEY_ID to encrypt candidate data at rest.');
  return mode;
}

function keyFor(version: number): Key {
  const k = keys.get(version);
  if (!k) {
    throw new Error(
      mode === 'off'
        ? 'This data is encrypted but no encryption key is configured (KMS_KEY_ID).'
        : `No key for encrypted data version ${version}.`,
    );
  }
  return k;
}

export function isEncryptedText(v: unknown): v is string {
  return typeof v === 'string' && (v.startsWith('enc:v') || v.startsWith('det:v'));
}

export function isEncryptedBytes(v: unknown): boolean {
  return (Buffer.isBuffer(v) || v instanceof Uint8Array) && v.length >= 4 && Buffer.from(v.subarray(0, 4)).equals(MAGIC);
}

/**
 * Encrypt a string. Deterministic encryption takes a context (model.field)
 * so equal values in different fields do not look equal. Off mode returns
 * the value unchanged; an already encrypted value is left as it is.
 */
export function encryptText(plain: string, deterministic = false, context = ''): string {
  if (mode === 'off' || current === null || isEncryptedText(plain)) return plain;
  const k = keyFor(current);
  const iv = deterministic
    ? createHmac('sha256', k.mac).update(context).update('\0').update(plain, 'utf8').digest().subarray(0, 12)
    : randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.enc, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${deterministic ? 'det' : 'enc'}:v${current}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

export function decryptText(stored: string): string {
  if (!isEncryptedText(stored)) return stored;
  const m = /^(?:enc|det):v(\d+):(.+)$/.exec(stored);
  if (!m) throw new Error('Unreadable encrypted value.');
  const k = keyFor(Number(m[1]));
  const raw = Buffer.from(m[2], 'base64url');
  const d = createDecipheriv('aes-256-gcm', k.enc, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export function encryptBytes(plain: Uint8Array): Buffer {
  const buf = Buffer.from(plain);
  if (mode === 'off' || current === null || isEncryptedBytes(buf)) return buf;
  const k = keyFor(current);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.enc, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  const ver = Buffer.alloc(2);
  ver.writeUInt16BE(current);
  return Buffer.concat([MAGIC, ver, iv, c.getAuthTag(), ct]);
}

export function decryptBytes(stored: Uint8Array): Buffer {
  const buf = Buffer.from(stored);
  if (!isEncryptedBytes(buf)) return buf;
  const k = keyFor(buf.readUInt16BE(4));
  const d = createDecipheriv('aes-256-gcm', k.enc, buf.subarray(6, 18));
  d.setAuthTag(buf.subarray(18, 34));
  return Buffer.concat([d.update(buf.subarray(34)), d.final()]);
}
