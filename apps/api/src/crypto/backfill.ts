import { encryptBytes, encryptText, encryptionMode, isEncryptedBytes, isEncryptedText } from './field-crypto';
import { ENCRYPTED } from './encrypted-fields';

type Raw = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/**
 * Encrypt rows written before encryption was switched on. Safe to run on
 * every start: values already encrypted are skipped, so after the first run
 * it only reads. Works in SQL, below the middleware, to see what is stored.
 */
export async function backfillEncryption(db: Raw, log: (m: string) => void = () => {}): Promise<number> {
  if (encryptionMode() === 'off') return 0;
  let total = 0;
  for (const [model, spec] of Object.entries(ENCRYPTED)) {
    const cols = [
      ...Object.values(spec.fields).map((f) => f.column),
      ...Object.values(spec.shadows ?? {}).flatMap((s) => [s.column, s.shadowColumn]),
    ];
    const rows = await db.$queryRawUnsafe<Record<string, any>[]>(
      `SELECT "id"::text AS "id", ${cols.map(q).join(', ')} FROM ${q(spec.table)}`,
    );
    let changed = 0;
    for (const row of rows) {
      const sets: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, v: unknown, cast = '') => {
        values.push(v);
        sets.push(`${q(col)} = $${values.length}${cast}`);
      };
      for (const [field, f] of Object.entries(spec.fields)) {
        const v = row[f.column];
        if (v === null || v === undefined) continue;
        const ctx = `${model}.${field}`;
        if (f.kind === 'bytes') {
          if (!isEncryptedBytes(v)) set(f.column, encryptBytes(v));
        } else if (f.kind === 'json') {
          if (!(v && typeof v === 'object' && !Array.isArray(v) && typeof v.__enc === 'string' && Object.keys(v).length === 1)) {
            set(f.column, JSON.stringify({ __enc: encryptText(JSON.stringify(v)) }), '::jsonb');
          }
        } else if (typeof v === 'string' && v !== '' && !isEncryptedText(v)) {
          const s = String(v);
          const plain = f.kind === 'detLower' ? s.trim().toLowerCase() : s;
          set(f.column, encryptText(plain, f.kind !== 'text', ctx));
        }
      }
      for (const s of Object.values(spec.shadows ?? {})) {
        const v = row[s.column];
        if (v === null || v === undefined) continue;
        if (row[s.shadowColumn] === null) set(s.shadowColumn, encryptText(String(v)));
        set(s.column, null);
      }
      if (!sets.length) continue;
      values.push(row.id);
      try {
        await db.$executeRawUnsafe(`UPDATE ${q(spec.table)} SET ${sets.join(', ')} WHERE "id" = $${values.length}::uuid`, ...values);
        changed++;
      } catch (e: any) {
        log(`Could not encrypt ${model} ${row.id}: ${e.message}`);
      }
    }
    if (changed) log(`Encrypted ${changed} existing ${model} row${changed === 1 ? '' : 's'}.`);
    total += changed;
  }
  return total;
}
