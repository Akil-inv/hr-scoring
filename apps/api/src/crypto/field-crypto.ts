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
 * Where the key comes from (checked in this order):
 *   FIELD_ENCRYPTION_KEY  the data key itself, as the recovery key printed by
 *          `encryption.sh recovery-kit` (HRK-v1-...) or base64. Two uses:
 *          - break glass: KMS is unavailable, so start with the recovery key
 *            from the safe. With KMS_KEY_ID also set, the key is put back
 *            under that KMS key, and FIELD_ENCRYPTION_KEY can be removed.
 *          - no AWS: a deployment without KMS keeps its key here.
 *          Either way it must match the fingerprint stored with the data.
 *   KMS_KEY_ID  AWS KMS (production).
 *   neither     off: values are stored as they are. Refused once data has
 *          been encrypted, so the app never runs half-encrypted.
 *
 * Stored formats (each carries its key version so keys can be rotated):
 *   text   "enc:v1:<base64url iv|tag|ciphertext>"   random IV
 *   det    "det:v1:<...>"                            IV derived from the value,
 *          so the same value always encrypts the same way: exact-match lookups
 *          and unique constraints keep working (candidate names, judge emails).
 *   bytes  "ENC1" | version (2 bytes) | iv | tag | ciphertext
 */

/** kms: unlocked by AWS KMS. local: key from FIELD_ENCRYPTION_KEY, no KMS.
 *  recovery: KMS-protected data opened with the recovery key (break glass). */
export type Mode = 'kms' | 'local' | 'recovery' | 'off';
type Key = { enc: Buffer; mac: Buffer };

const MAGIC = Buffer.from('ENC1');
const LOCAL = 'local';
const keys = new Map<number, Key>();
const raw = new Map<number, Buffer>();
let current: number | null = null;
let mode: Mode = 'off';
let source = '';

export function encryptionMode(): Mode {
  return mode;
}

/** Where the key came from, for status screens: "alias/hr-scoring", "FIELD_ENCRYPTION_KEY". */
export function keySource(): string {
  return source;
}

function derive(dataKey: Buffer): Key {
  return {
    enc: Buffer.from(hkdfSync('sha256', dataKey, Buffer.from('hr-scoring'), Buffer.from('field-encryption'), 32)),
    mac: Buffer.from(hkdfSync('sha256', dataKey, Buffer.from('hr-scoring'), Buffer.from('field-deterministic-iv'), 32)),
  };
}

/** A fingerprint of a data key: confirms a recovery key is the right one without revealing it. */
export function checkValue(dataKey: Buffer): string {
  return createHmac('sha256', dataKey).update('hr-scoring key check v1').digest('hex').slice(0, 16);
}

/** Use these data keys; the highest version encrypts new values. For tests and startup. */
export function setKeys(next: Mode, dataKeys: { version: number; key: Buffer }[], from = '') {
  keys.clear();
  raw.clear();
  current = null;
  for (const k of dataKeys) {
    if (k.key.length !== 32) throw new Error(`Data key version ${k.version} is not 32 bytes.`);
    keys.set(k.version, derive(k.key));
    raw.set(k.version, Buffer.from(k.key));
    if (current === null || k.version > current) current = k.version;
  }
  mode = dataKeys.length ? next : 'off';
  source = dataKeys.length ? from : '';
}

/** The unlocked data keys, for printing the recovery kit. Nothing else should need them. */
export function exportKeys(): { version: number; key: Buffer }[] {
  return [...raw.entries()].sort((a, b) => a[0] - b[0]).map(([version, key]) => ({ version, key: Buffer.from(key) }));
}

/** "HRK-v1-1a2b3c4d-...": 64 hex digits in groups of 8, easy to read back from paper. */
export function formatRecoveryKey(version: number, key: Buffer): string {
  return `HRK-v${version}-${key.toString('hex').match(/.{8}/g)!.join('-')}`;
}

/** Accepts recovery keys (several separated by commas or spaces) or one base64 key. */
export function parseKeys(text: string): { version: number; key: Buffer }[] {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.some((p) => /^HRK-v/i.test(p))) {
    return parts.map((p) => {
      const m = /^HRK-v(\d+)-([0-9a-f-]+)$/i.exec(p.trim());
      const hex = m?.[2].replace(/-/g, '') ?? '';
      if (!m || hex.length !== 64) throw new Error('FIELD_ENCRYPTION_KEY is not a valid recovery key (HRK-v1- then 64 hex digits).');
      return { version: Number(m[1]), key: Buffer.from(hex, 'hex') };
    });
  }
  const key = Buffer.from(text.trim(), 'base64');
  if (key.length !== 32) throw new Error('FIELD_ENCRYPTION_KEY must be a recovery key (HRK-v1-...) or 32 bytes in base64.');
  return [{ version: 1, key }];
}

type Row = { version: number; kmsKeyId: string; encryptedKey: Uint8Array; checkValue?: string | null };

/** Minimal shape of the table that stores the encrypted data keys. */
export type DataKeyStore = {
  findMany(args: { orderBy: { version: 'asc' } }): Promise<Row[]>;
  create(args: { data: { version: number; kmsKeyId: string; encryptedKey: Buffer; checkValue: string } }): Promise<unknown>;
  update(args: { where: { version: number }; data: { kmsKeyId?: string; encryptedKey?: Buffer; checkValue?: string } }): Promise<unknown>;
};

async function kmsApi(env: NodeJS.ProcessEnv) {
  const sdk = await import('@aws-sdk/client-kms');
  // Fail in seconds, not minutes, when KMS cannot be reached, so the log says why.
  const client = new sdk.KMSClient({
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-southeast-1',
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 15000 },
  });
  return {
    generate: async (keyId: string) => {
      const out = await client.send(new sdk.GenerateDataKeyCommand({ KeyId: keyId, KeySpec: 'AES_256' }));
      if (!out.CiphertextBlob || !out.Plaintext) throw new Error('KMS did not return a data key.');
      return { wrapped: Buffer.from(out.CiphertextBlob), plain: Buffer.from(out.Plaintext) };
    },
    unwrap: async (wrapped: Uint8Array, keyId: string) => {
      const out = await client.send(new sdk.DecryptCommand({ CiphertextBlob: Buffer.from(wrapped), KeyId: keyId }));
      if (!out.Plaintext) throw new Error('KMS returned no key.');
      return Buffer.from(out.Plaintext);
    },
    wrap: async (plain: Buffer, keyId: string) => {
      const out = await client.send(new sdk.EncryptCommand({ KeyId: keyId, Plaintext: plain }));
      if (!out.CiphertextBlob) throw new Error('KMS did not encrypt the key.');
      return Buffer.from(out.CiphertextBlob);
    },
  };
}

/** Put each data key under the given KMS key (moving from a local key, a recovery, or another KMS key). */
export async function wrapWithKms(store: DataKeyStore, kmsKeyId: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const kms = await kmsApi(env);
  const rows = await store.findMany({ orderBy: { version: 'asc' } });
  let n = 0;
  for (const r of rows) {
    const plain = raw.get(r.version);
    if (!plain) throw new Error(`Data key version ${r.version} is not unlocked.`);
    if (r.kmsKeyId === kmsKeyId) {
      try {
        if ((await kms.unwrap(r.encryptedKey, kmsKeyId)).equals(plain)) continue;
      } catch {
        /* the stored copy cannot be opened with this KMS key: wrap it again */
      }
    }
    await store.update({ where: { version: r.version }, data: { kmsKeyId, encryptedKey: await kms.wrap(plain, kmsKeyId), checkValue: checkValue(plain) } });
    n++;
  }
  return n;
}

const BREAK_GLASS = 'see "Break glass" in docs/FIELD-ENCRYPTION.md';

/**
 * Load the keys at startup. Fails loudly, with what to do, rather than run
 * without the right key.
 */
export async function initKeys(store: DataKeyStore, env: NodeJS.ProcessEnv = process.env, log: (m: string) => void = () => {}): Promise<Mode> {
  let rows = await store.findMany({ orderBy: { version: 'asc' } });

  if (env.FIELD_ENCRYPTION_KEY) {
    const supplied = parseKeys(env.FIELD_ENCRYPTION_KEY);
    for (const r of rows) {
      const k = supplied.find((s) => s.version === r.version);
      if (!k) throw new Error(`FIELD_ENCRYPTION_KEY has no key for version ${r.version}: give every recovery key from the kit.`);
      if (r.checkValue && r.checkValue !== checkValue(k.key)) {
        throw new Error(`FIELD_ENCRYPTION_KEY (version ${r.version}) is not the key this data was encrypted with. Nothing was changed.`);
      }
    }
    if (rows.length === 0) {
      for (const k of supplied) {
        await store.create({ data: { version: k.version, kmsKeyId: LOCAL, encryptedKey: Buffer.alloc(0), checkValue: checkValue(k.key) } });
      }
      rows = await store.findMany({ orderBy: { version: 'asc' } });
    }
    for (const r of rows) {
      if (!r.checkValue) await store.update({ where: { version: r.version }, data: { checkValue: checkValue(supplied.find((s) => s.version === r.version)!.key) } });
    }
    const wasKms = rows.some((r) => r.kmsKeyId !== LOCAL);
    setKeys(wasKms ? 'recovery' : 'local', supplied, 'FIELD_ENCRYPTION_KEY');
    if (env.KMS_KEY_ID) {
      try {
        const n = await wrapWithKms(store, env.KMS_KEY_ID, env);
        log(`Field encryption: key ${n ? 'put under' : 'already held by'} AWS KMS (${env.KMS_KEY_ID}). Remove FIELD_ENCRYPTION_KEY from .env and restart.`);
      } catch (e: any) {
        log(`WARNING Field encryption: running on FIELD_ENCRYPTION_KEY; could not hand the key to AWS KMS (${e.message}).`);
      }
    } else if (wasKms) {
      log('WARNING Field encryption: BREAK GLASS. Running on the recovery key, not AWS KMS. Restore KMS access, set KMS_KEY_ID, restart, then remove FIELD_ENCRYPTION_KEY.');
    } else {
      log('Field encryption on (key from FIELD_ENCRYPTION_KEY, no KMS).');
    }
    return mode;
  }

  if (env.KMS_KEY_ID) {
    if (rows.some((r) => r.kmsKeyId === LOCAL)) {
      throw new Error('This data is encrypted with a local key, not KMS. Start once with both FIELD_ENCRYPTION_KEY (that key) and KMS_KEY_ID to move it under KMS.');
    }
    const unlocked: { version: number; key: Buffer }[] = [];
    try {
      const kms = await kmsApi(env);
      if (rows.length === 0) {
        const { wrapped, plain } = await kms.generate(env.KMS_KEY_ID);
        await store.create({ data: { version: 1, kmsKeyId: env.KMS_KEY_ID, encryptedKey: wrapped, checkValue: checkValue(plain) } });
        log('Created the field-encryption data key with KMS (version 1). Print the recovery kit now: ./encryption.sh recovery-kit');
        rows = await store.findMany({ orderBy: { version: 'asc' } });
      }
      for (const r of rows) unlocked.push({ version: r.version, key: await kms.unwrap(r.encryptedKey, r.kmsKeyId) });
    } catch (e: any) {
      const network = /timeout|timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|aborted/i.test(`${e.name} ${e.message}`);
      const hint = network ? ' The server cannot reach the KMS service: a server without internet access needs a KMS VPC endpoint.' : '';
      throw new Error(`Could not unlock the encryption key with AWS KMS: ${e.name}: ${e.message}.${hint} Fix KMS access, or start with the recovery key (${BREAK_GLASS}).`);
    }
    for (const r of rows) {
      const k = unlocked.find((u) => u.version === r.version)!.key;
      if (!r.checkValue) await store.update({ where: { version: r.version }, data: { checkValue: checkValue(k) } });
    }
    setKeys('kms', unlocked, env.KMS_KEY_ID);
    log(`Field encryption on (AWS KMS ${env.KMS_KEY_ID}, ${unlocked.length} data key${unlocked.length === 1 ? '' : 's'}).`);
    return mode;
  }

  if (rows.length > 0) {
    throw new Error(`This database holds encrypted data but no key is set. Set KMS_KEY_ID in .env, or the recovery key as FIELD_ENCRYPTION_KEY (${BREAK_GLASS}).`);
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
