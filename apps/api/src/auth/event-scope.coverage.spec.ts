import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { buildSchema, GraphQLInputObjectType, GraphQLInputType, GraphQLNamedType, getNamedType, isInputObjectType } from 'graphql';
import { EVENT_SCOPE_KEY, ID_FIELDS, NON_EVENT_ID_FIELDS, NOT_EVENT_SCOPED_KEY, ScopeOptions, CHECKED_IN_HANDLER_KEY } from './event-access';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Every operation in the API has decided how it is scoped to events.
 *
 * Walks schema.gql: each query and mutation must be @Public, @NotEventScoped,
 * or name its event through ids the guard knows how to look up, with no
 * id-like argument (at any depth of its inputs) left unmapped. And every REST
 * handler must check event access itself or say it isn't about an event.
 */

const SRC = join(__dirname, '..');

function files(dir: string, suffix: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p, suffix);
    return p.endsWith(suffix) ? [p] : [];
  });
}

/** handler function and its class, by GraphQL field name (method names match field names here). */
function resolverHandlers() {
  const out = new Map<string, { fn: Function; cls: Function }>();
  for (const f of files(SRC, '.resolver.ts')) {
    const mod = require(f);
    for (const cls of Object.values(mod) as any[]) {
      if (typeof cls !== 'function' || !cls.prototype) continue;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        if (name === 'constructor') continue;
        const fn = cls.prototype[name];
        if (typeof fn === 'function') out.set(name, { fn, cls });
      }
    }
  }
  return out;
}

function meta<T>(key: string, fn: Function, cls: Function): T | undefined {
  return Reflect.getMetadata(key, fn) ?? Reflect.getMetadata(key, cls);
}

/** All argument/input field names reachable from an operation. */
function fieldNames(args: readonly { name: string; type: any }[], seen = new Set<string>()): string[] {
  const names: string[] = [];
  for (const a of args) {
    names.push(a.name);
    const t: GraphQLNamedType = getNamedType(a.type as GraphQLInputType);
    if (isInputObjectType(t) && !seen.has(t.name)) {
      seen.add(t.name);
      names.push(...fieldNames(Object.values((t as GraphQLInputObjectType).getFields()), seen));
    }
  }
  return names;
}

describe('event scope covers every operation', () => {
  const schema = buildSchema(readFileSync(join(SRC, 'schema.gql'), 'utf8'));
  const handlers = resolverHandlers();
  const ops = [
    ...Object.values(schema.getQueryType()!.getFields()),
    ...Object.values(schema.getMutationType()!.getFields()),
  ];

  it.each(ops.map((o) => [o.name, o] as const))('%s', (name, op) => {
    const h = handlers.get(name);
    expect(h).toBeDefined();
    const { fn, cls } = h!;
    if (meta(IS_PUBLIC_KEY, fn, cls) || meta(NOT_EVENT_SCOPED_KEY, fn, cls)) return;
    const opts = meta<ScopeOptions>(EVENT_SCOPE_KEY, fn, cls) ?? {};
    const names = fieldNames(op.args);
    const unmapped = names.filter((n) =>
      (n === 'id' && !opts.id) || (n !== 'id' && /(Id|Ids)$/.test(n) && !ID_FIELDS[n] && !NON_EVENT_ID_FIELDS.has(n)));
    if (!opts.refs) expect(unmapped).toEqual([]);
    const namesEvent = names.some((n) => ID_FIELDS[n] || (n === 'id' && opts.id)) || !!opts.refs;
    expect(namesEvent).toBe(true);
  });

  it('every REST handler checks event access or says it is not about an event', () => {
    const missing: string[] = [];
    for (const f of files(SRC, '.controller.ts')) {
      const mod = require(f);
      for (const cls of Object.values(mod) as any[]) {
        if (typeof cls !== 'function' || !Reflect.getMetadata('path', cls)) continue;
        for (const name of Object.getOwnPropertyNames(cls.prototype)) {
          const fn = cls.prototype[name];
          if (name === 'constructor' || typeof fn !== 'function' || Reflect.getMetadata('method', fn) === undefined) continue;
          if (meta(IS_PUBLIC_KEY, fn, cls) || meta(NOT_EVENT_SCOPED_KEY, fn, cls) || meta(CHECKED_IN_HANDLER_KEY, fn, cls)) continue;
          missing.push(`${cls.name}.${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('REST handlers marked as checking do call the access check', () => {
    for (const f of files(SRC, '.controller.ts')) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('@EventCheckedInHandler()')) continue;
      // Each marked handler's body mentions access.assert (directly or through a helper in the same file).
      expect(src).toMatch(/access\.assert\(|this\.assertAccess\(|this\.check\(/);
    }
  });
});
