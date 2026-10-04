import {
  decryptBytes, decryptText, encryptBytes, encryptText, encryptionMode, isEncryptedBytes, isEncryptedText,
} from './field-crypto';
import { ENCRYPTED, Kind, SHADOW_OF } from './encrypted-fields';

/**
 * Encrypts on the way into the database and decrypts on the way out, for
 * every Prisma query, so the services above keep working with plain values.
 *
 * Writes: values of encrypted fields are replaced (create, update, upsert,
 * createMany and nested writes). Filters: exact matches on deterministic
 * fields are encrypted too, so `where: { eventId_name: {...} }` still finds
 * the row; any other filter on an encrypted field is refused, because the
 * database cannot compare what it cannot read. Sorting on an encrypted field
 * is done here, after decrypting.
 *
 * Reads: every encrypted value in the result, however deeply included, is
 * decrypted.
 */

type Field = { name: string; kind: string; type: string; isList?: boolean };
type RuntimeModel = { fields: Field[] };
type DataModel = { models: Record<string, RuntimeModel> };
type Params = { model?: string; action: string; args?: any; dataPath?: string[] };
type SortKey = { path: string[]; desc: boolean };
type PostSort = { at: string[]; keys: SortKey[] };

const LOGICAL = new Set(['AND', 'OR', 'NOT']);

function isPlain(v: unknown): v is Record<string, any> {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

const on = () => encryptionMode() !== 'off';

// ─── Values ─────────────────────────────────────────────────────────────────

function encValue(kind: Kind, v: any, context: string): any {
  if (v === null || v === undefined) return v;
  switch (kind) {
    case 'text':
      return typeof v === 'string' && v !== '' ? encryptText(v) : v;
    case 'det':
      return typeof v === 'string' && v !== '' ? encryptText(v, true, context) : v;
    case 'detLower':
      return typeof v === 'string' && v !== '' ? encryptText(v.trim().toLowerCase(), true, context) : v;
    case 'bytes':
      return v instanceof Uint8Array ? encryptBytes(v) : v;
    case 'json':
      // Prisma.JsonNull / DbNull are class instances: leave them.
      if (!isPlain(v) && !Array.isArray(v) && typeof v === 'object') return v;
      if (isPlain(v) && typeof v.__enc === 'string') return v;
      return { __enc: encryptText(JSON.stringify(v)) };
  }
}

/** Decrypt everything encrypted in a result, in place. */
export function decryptDeep(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return isEncryptedText(v) ? decryptText(v) : v;
  if (v instanceof Uint8Array) return isEncryptedBytes(v) ? decryptBytes(v) : v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = decryptDeep(v[i]);
    return v;
  }
  if (!isPlain(v)) return v;
  const keys = Object.keys(v);
  if (keys.length === 1 && keys[0] === '__enc' && typeof v.__enc === 'string') {
    return JSON.parse(decryptText(v.__enc));
  }
  for (const k of keys) {
    const sh = SHADOW_OF[k];
    if (sh) {
      const stored = v[k];
      if (typeof stored === 'string') {
        const plain = decryptText(stored);
        v[sh.field] = sh.type === 'number' ? Number(plain) : plain === 'true';
      }
      delete v[k];
      continue;
    }
    v[k] = decryptDeep(v[k]);
  }
  return v;
}

// ─── Arguments ──────────────────────────────────────────────────────────────

export class EncryptionArgs {
  constructor(private readonly dm: DataModel) {}

  private field(model: string, name: string): Field | undefined {
    return this.dm.models[model]?.fields.find((f) => f.name === name);
  }

  private refuse(model: string, field: string, what: string): never {
    throw new Error(`${model}.${field} is stored encrypted and cannot be ${what} by the database.`);
  }

  // Data: create / update payloads.
  data(model: string, data: any): any {
    if (Array.isArray(data)) return data.map((d) => this.data(model, d));
    if (!isPlain(data)) return data;
    const spec = ENCRYPTED[model];
    const out: Record<string, any> = { ...data };
    for (const [k, v] of Object.entries(data)) {
      const enc = spec?.fields[k];
      if (enc) {
        out[k] = isPlain(v) && 'set' in v ? { ...v, set: encValue(enc.kind, v.set, `${model}.${k}`) } : encValue(enc.kind, v, `${model}.${k}`);
        continue;
      }
      const sh = spec?.shadows?.[k];
      if (sh) {
        let value = v;
        if (isPlain(v)) {
          if (!('set' in v)) this.refuse(model, k, 'changed arithmetically');
          value = v.set;
        }
        if (value === undefined) continue;
        if (!on()) {
          out[sh.shadow] = null;
          continue;
        }
        out[k] = null;
        out[sh.shadow] = value === null ? null : encryptText(String(value));
        continue;
      }
      const f = this.field(model, k);
      if (f?.kind === 'object' && isPlain(v)) out[k] = this.nested(f.type, v);
    }
    return out;
  }

  private nested(model: string, ops: Record<string, any>): Record<string, any> {
    const each = (v: any, fn: (x: any) => any) => (Array.isArray(v) ? v.map(fn) : fn(v));
    const out: Record<string, any> = { ...ops };
    for (const [op, v] of Object.entries(ops)) {
      if (v === undefined || v === null || typeof v === 'boolean') continue;
      switch (op) {
        case 'create':
          out[op] = this.data(model, v);
          break;
        case 'createMany':
          out[op] = { ...v, data: this.data(model, v.data) };
          break;
        case 'connectOrCreate':
          out[op] = each(v, (x) => ({ ...x, where: this.where(model, x.where), create: this.data(model, x.create) }));
          break;
        case 'upsert':
          out[op] = each(v, (x) => ({
            ...x,
            ...(x.where ? { where: this.where(model, x.where) } : {}),
            create: this.data(model, x.create),
            update: this.data(model, x.update),
          }));
          break;
        case 'update':
        case 'updateMany':
          out[op] = each(v, (x) =>
            isPlain(x) && 'data' in x && !this.field(model, 'data')
              ? { ...x, ...(x.where ? { where: this.where(model, x.where) } : {}), data: this.data(model, x.data) }
              : this.data(model, x));
          break;
        case 'connect':
        case 'disconnect':
        case 'delete':
        case 'deleteMany':
        case 'set':
          out[op] = each(v, (x) => this.where(model, x));
          break;
      }
    }
    return out;
  }

  // Filters.
  where(model: string, w: any): any {
    if (Array.isArray(w)) return w.map((x) => this.where(model, x));
    if (!isPlain(w)) return w;
    const spec = ENCRYPTED[model];
    const out: Record<string, any> = { ...w };
    for (const [k, v] of Object.entries(w)) {
      if (LOGICAL.has(k)) {
        out[k] = this.where(model, v);
        continue;
      }
      const enc = spec?.fields[k];
      if (enc) {
        out[k] = this.filter(model, k, enc.kind, v);
        continue;
      }
      if (spec?.shadows?.[k]) {
        if (on() && v !== undefined) this.refuse(model, k, 'filtered');
        continue;
      }
      const f = this.field(model, k);
      if (f?.kind === 'object') {
        if (!isPlain(v)) continue;
        const rel: Record<string, any> = {};
        let wrapped = false;
        for (const [op, x] of Object.entries(v)) {
          if (['is', 'isNot', 'some', 'every', 'none'].includes(op)) {
            rel[op] = this.where(f.type, x);
            wrapped = true;
          } else rel[op] = x;
        }
        out[k] = wrapped ? rel : this.where(f.type, v);
        continue;
      }
      // A compound unique key: { eventId_name: { eventId, name } }.
      if (!f && isPlain(v)) out[k] = this.where(model, v);
    }
    return out;
  }

  private filter(model: string, field: string, kind: Kind, v: any): any {
    if (!on() || v === undefined || v === null) return v;
    const exact = kind === 'det' || kind === 'detLower';
    const ctx = `${model}.${field}`;
    if (!isPlain(v)) {
      if (exact) return encValue(kind, v, ctx);
      if (v === '') return v;
      return this.refuse(model, field, 'searched');
    }
    const out: Record<string, any> = {};
    for (const [op, x] of Object.entries(v)) {
      if (op === 'mode') continue; // case is handled by detLower; the stored value is opaque
      if (x === null || x === '' || x === undefined) {
        out[op] = x;
        continue;
      }
      if (!exact) this.refuse(model, field, 'searched');
      if (op === 'equals') out[op] = encValue(kind, x, ctx);
      else if (op === 'in' || op === 'notIn') out[op] = (x as string[]).map((s) => encValue(kind, s, ctx));
      else if (op === 'not') out[op] = isPlain(x) ? this.filter(model, field, kind, x) : encValue(kind, x, ctx);
      else this.refuse(model, field, `matched with "${op}"`);
    }
    return out;
  }

  // Selection.
  query(model: string, args: any, at: string[], sorts: PostSort[]): any {
    if (!isPlain(args)) return args;
    const out: Record<string, any> = { ...args };
    if (args.where) out.where = this.where(model, args.where);
    if (args.select) out.select = this.selection(model, args.select, at, sorts, true);
    if (args.include) out.include = this.selection(model, args.include, at, sorts, false);
    if (args.orderBy) {
      const { kept, keys, encrypted } = this.order(model, args.orderBy);
      if (encrypted) {
        if (kept.length) out.orderBy = kept;
        else delete out.orderBy;
        sorts.push({ at, keys });
        if (args.take !== undefined || args.skip !== undefined || args.cursor !== undefined) {
          throw new Error(`Cannot page through ${model} in the order of an encrypted field.`);
        }
      }
    }
    return out;
  }

  private selection(model: string, sel: Record<string, any>, at: string[], sorts: PostSort[], isSelect: boolean) {
    const spec = ENCRYPTED[model];
    const out: Record<string, any> = { ...sel };
    for (const [k, v] of Object.entries(sel)) {
      const sh = spec?.shadows?.[k];
      if (sh && isSelect && v) out[sh.shadow] = true;
      if (k === '_count' && isPlain(v) && isPlain(v.select)) {
        const cs: Record<string, any> = { ...v.select };
        for (const [rel, x] of Object.entries(v.select)) {
          const f = this.field(model, rel);
          if (f && isPlain(x) && (x as any).where) cs[rel] = { ...(x as any), where: this.where(f.type, (x as any).where) };
        }
        out[k] = { ...v, select: cs };
        continue;
      }
      const f = this.field(model, k);
      if (f?.kind === 'object' && isPlain(v)) out[k] = this.query(f.type, v, [...at, k], sorts);
    }
    return out;
  }

  private order(model: string, orderBy: any): { kept: any[]; keys: SortKey[]; encrypted: boolean } {
    const list = Array.isArray(orderBy) ? orderBy : [orderBy];
    const kept: any[] = [];
    const keys: SortKey[] = [];
    let encrypted = false;
    for (const entry of list) {
      for (const [k, v] of Object.entries(entry ?? {})) {
        const r = this.orderPath(model, k, v);
        if (r) {
          keys.push(r.key);
          if (r.encrypted) encrypted = true;
          else kept.push({ [k]: v });
        } else kept.push({ [k]: v });
      }
    }
    return { kept, keys, encrypted };
  }

  private orderPath(model: string, k: string, v: any): { key: SortKey; encrypted: boolean } | null {
    const spec = ENCRYPTED[model];
    const f = this.field(model, k);
    if (!f) return null;
    if (f.kind === 'object') {
      if (!isPlain(v)) return null;
      const [[k2, v2]] = Object.entries(v);
      const inner = k2 && !f.isList ? this.orderPath(f.type, k2, v2) : null;
      return inner ? { key: { path: [k, ...inner.key.path], desc: inner.key.desc }, encrypted: inner.encrypted } : null;
    }
    const dir = isPlain(v) ? v.sort : v;
    return { key: { path: [k], desc: dir === 'desc' }, encrypted: !!(spec?.fields[k] || spec?.shadows?.[k]) };
  }
}

// ─── Sorting results ────────────────────────────────────────────────────────

function valueAt(row: any, path: string[]): any {
  let v = row;
  for (const p of path) v = v?.[p];
  return v;
}

function compare(a: any, b: any): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // nulls last, as Postgres sorts ascending
  if (b === null || b === undefined) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortAt(node: any, at: string[], keys: SortKey[]) {
  if (Array.isArray(node) && at.length > 0) {
    for (const n of node) sortAt(n, at, keys);
    return;
  }
  if (at.length > 0) return sortAt(node?.[at[0]], at.slice(1), keys);
  if (!Array.isArray(node)) return;
  node.sort((x, y) => {
    for (const k of keys) {
      const c = compare(valueAt(x, k.path), valueAt(y, k.path));
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  });
}

// ─── The middleware ─────────────────────────────────────────────────────────

const READS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);

/** Attach to a Prisma client: `client.$use(fieldEncryption(client))`. */
export function fieldEncryption(client: { _runtimeDataModel?: DataModel } | DataModel) {
  const dm = ((client as any)._runtimeDataModel ?? client) as DataModel;
  const enc = new EncryptionArgs(dm);

  return async (params: Params, next: (p: Params) => Promise<any>) => {
    if (!params.model || !dm.models[params.model]) return next(params);
    const model = params.model;
    const args = params.args ?? {};
    const sorts: PostSort[] = [];
    let a: any = { ...args };
    let firstOnly = false;

    switch (params.action) {
      case 'create':
        a = enc.query(model, a, [], sorts);
        a.data = enc.data(model, args.data);
        break;
      case 'createMany':
      case 'createManyAndReturn':
        a = enc.query(model, a, [], sorts);
        a.data = enc.data(model, args.data);
        break;
      case 'update':
      case 'updateMany':
        a = enc.query(model, a, [], sorts);
        a.data = enc.data(model, args.data);
        break;
      case 'upsert':
        a = enc.query(model, a, [], sorts);
        a.create = enc.data(model, args.create);
        a.update = enc.data(model, args.update);
        break;
      case 'delete':
      case 'deleteMany':
        a = enc.query(model, a, [], sorts);
        break;
      default:
        if (READS.has(params.action)) a = enc.query(model, a, [], sorts);
    }

    // The first row in an encrypted order can only be known after decrypting.
    let action = params.action;
    if (sorts.some((s) => s.at.length === 0) && (action === 'findFirst' || action === 'findFirstOrThrow')) {
      firstOnly = true;
      action = 'findMany';
    }

    let result = await next({ ...params, action, args: a } as Params);
    result = decryptDeep(result);
    for (const s of sorts) sortAt(result, s.at, s.keys);
    if (firstOnly) {
      if (Array.isArray(result) && result.length) return result[0];
      if (params.action === 'findFirstOrThrow') throw new Error(`No ${model} found.`);
      return null;
    }
    return result;
  };
}
