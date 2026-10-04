import {
  decryptBytes, decryptText, encryptBytes, encryptText, encryptionMode, isEncryptedBytes, isEncryptedText,
} from './field-crypto';
import { ENCRYPTED, ModelSpec } from './encrypted-fields';

/**
 * Whole-table work on the encrypted columns, in SQL below the middleware so
 * it sees what is actually stored:
 *   backfillEncryption  encrypt anything still plain (runs at every start)
 *   decryptEverything   the switch back: store everything plain again
 *   scanEncryption      count encrypted and plain values, for status
 */

type Raw = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

const isEncJson = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.__enc === 'string' && Object.keys(v).length === 1;

async function rowsOf(db: Raw, spec: ModelSpec): Promise<Record<string, any>[]> {
  const cols = [
    ...Object.values(spec.fields).map((f) => f.column),
    ...Object.values(spec.shadows ?? {}).flatMap((s) => [s.column, s.shadowColumn]),
  ];
  return db.$queryRawUnsafe<Record<string, any>[]>(`SELECT "id"::text AS "id", ${cols.map(q).join(', ')} FROM ${q(spec.table)}`);
}

/** Collects column updates for one row, then writes them in one statement. */
function updater(db: Raw, spec: ModelSpec, id: string) {
  const sets: string[] = [];
  const values: unknown[] = [];
  return {
    set(col: string, v: unknown, cast = '') {
      values.push(v);
      sets.push(`${q(col)} = $${values.length}${cast}`);
    },
    async write(): Promise<boolean> {
      if (!sets.length) return false;
      values.push(id);
      await db.$executeRawUnsafe(`UPDATE ${q(spec.table)} SET ${sets.join(', ')} WHERE "id" = $${values.length}::uuid`, ...values);
      return true;
    },
  };
}

/**
 * Encrypt rows written before encryption was switched on. Safe to run on
 * every start: values already encrypted are skipped, so after the first run
 * it only reads.
 */
export async function backfillEncryption(db: Raw, log: (m: string) => void = () => {}): Promise<number> {
  if (encryptionMode() === 'off') return 0;
  let total = 0;
  for (const [model, spec] of Object.entries(ENCRYPTED)) {
    let changed = 0;
    for (const row of await rowsOf(db, spec)) {
      const u = updater(db, spec, row.id);
      for (const [field, f] of Object.entries(spec.fields)) {
        const v = row[f.column];
        if (v === null || v === undefined) continue;
        if (f.kind === 'bytes') {
          if (!isEncryptedBytes(v)) u.set(f.column, encryptBytes(v));
        } else if (f.kind === 'json') {
          if (!isEncJson(v)) u.set(f.column, JSON.stringify({ __enc: encryptText(JSON.stringify(v)) }), '::jsonb');
        } else if (typeof v === 'string' && v !== '' && !isEncryptedText(v)) {
          const s = String(v);
          const plain = f.kind === 'detLower' ? s.trim().toLowerCase() : s;
          u.set(f.column, encryptText(plain, f.kind !== 'text', `${model}.${field}`));
        }
      }
      for (const s of Object.values(spec.shadows ?? {})) {
        const v = row[s.column];
        if (v === null || v === undefined) continue;
        if (row[s.shadowColumn] === null) u.set(s.shadowColumn, encryptText(String(v)));
        u.set(s.column, null);
      }
      try {
        if (await u.write()) changed++;
      } catch (e: any) {
        log(`Could not encrypt ${model} ${row.id}: ${e.message}`);
      }
    }
    if (changed) log(`Encrypted ${changed} existing ${model} row${changed === 1 ? '' : 's'}.`);
    total += changed;
  }
  return total;
}

/**
 * The switch back: decrypt every value in place, leaving the database as it
 * was before encryption. Needs the keys unlocked. Stops at the first value
 * it cannot decrypt (nothing is half-done within a row).
 */
export async function decryptEverything(db: Raw, log: (m: string) => void = () => {}): Promise<number> {
  let total = 0;
  for (const [model, spec] of Object.entries(ENCRYPTED)) {
    let changed = 0;
    for (const row of await rowsOf(db, spec)) {
      const u = updater(db, spec, row.id);
      for (const f of Object.values(spec.fields)) {
        const v = row[f.column];
        if (v === null || v === undefined) continue;
        if (f.kind === 'bytes') {
          if (isEncryptedBytes(v)) u.set(f.column, decryptBytes(v));
        } else if (f.kind === 'json') {
          if (isEncJson(v)) u.set(f.column, decryptText(v.__enc), '::jsonb');
        } else if (isEncryptedText(v)) {
          u.set(f.column, decryptText(v));
        }
      }
      for (const s of Object.values(spec.shadows ?? {})) {
        const v = row[s.shadowColumn];
        if (typeof v !== 'string') continue;
        const plain = decryptText(v);
        if (s.type === 'number') u.set(s.column, Number(plain), '::double precision');
        else u.set(s.column, plain === 'true', '::boolean');
        u.set(s.shadowColumn, null);
      }
      if (await u.write()) changed++;
    }
    if (changed) log(`Decrypted ${changed} ${model} row${changed === 1 ? '' : 's'}.`);
    total += changed;
  }
  return total;
}

export type Scan = Record<string, { encrypted: number; plain: number }>;

/** Count encrypted and still-plain values per table. Reads only; needs no key. */
export async function scanEncryption(db: Raw): Promise<Scan> {
  const out: Scan = {};
  for (const [model, spec] of Object.entries(ENCRYPTED)) {
    const c = { encrypted: 0, plain: 0 };
    for (const row of await rowsOf(db, spec)) {
      for (const f of Object.values(spec.fields)) {
        const v = row[f.column];
        if (v === null || v === undefined || v === '') continue;
        const enc = f.kind === 'bytes' ? isEncryptedBytes(v) : f.kind === 'json' ? isEncJson(v) : isEncryptedText(v);
        if (enc) c.encrypted++;
        else c.plain++;
      }
      for (const s of Object.values(spec.shadows ?? {})) {
        if (row[s.shadowColumn] !== null && row[s.shadowColumn] !== undefined) c.encrypted++;
        if (row[s.column] !== null && row[s.column] !== undefined) c.plain++;
      }
    }
    out[model] = c;
  }
  return out;
}

export function totals(scan: Scan): { encrypted: number; plain: number } {
  return Object.values(scan).reduce((a, c) => ({ encrypted: a.encrypted + c.encrypted, plain: a.plain + c.plain }), { encrypted: 0, plain: 0 });
}
