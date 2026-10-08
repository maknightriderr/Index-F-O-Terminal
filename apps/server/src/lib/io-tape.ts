// ============================================================
// I/O TAPE — record a decision's external reads, replay them exactly
// ============================================================
// Full replay re-runs the UNCHANGED decision code (indicator engine, safety
// gates, option build, slot arbitration, settlement) for one snapshotted
// poll. The code is not made pure; its boundaries are:
//
//   RECORD (a live poll): every Redis command, SQL query, broker call and
//   in-process state read made inside the poll — and only inside it (an
//   AsyncLocalStorage scope) — is passed through and appended to the tape
//   with its result.
//
//   REPLAY: the same boundaries are served ONLY from the tape, matched by
//   channel + operation + arguments (FIFO per key). A read the tape does not
//   hold is a divergence — reported, never answered with current data.
//   Writes are collected as effects and never executed; network calls are
//   refused. Nothing outside the scope is affected: other polls, services and
//   requests keep the real Redis / SQL / network.
//
// Values are stored in a JSON encoding that keeps Dates, Buffers, BigInts,
// undefined and non-finite numbers.
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import axios from 'axios';

export const TAPE_VERSION = 'TAPE-1.0';

export interface TapeEntry {
  /** Channel: redis | sql | provider | state */
  ch: string;
  op: string;
  key: string;
  write: boolean;
  async: boolean;
  /** A write's target (Redis key / SQL statement text); its key holds only a digest of the payload. */
  target?: string;
  /** Settled: true = ok (v), false = threw / rejected (e); absent = still pending when the tape was saved. */
  ok?: boolean;
  v?: unknown;
  e?: string;
}

export interface TapeEffect {
  ch: string;
  op: string;
  /** The statement (SQL text) or the Redis key — what was written, without volatile parameters. */
  target: string;
  recorded: boolean;
}

interface Scope {
  mode: 'RECORD' | 'REPLAY';
  /** REPLAY: Date.now() inside the scope returns this (the decision instant). */
  frozenNow?: number;
  entries: TapeEntry[];
  queues: Map<string, TapeEntry[]>;
  divergences: string[];
  effects: TapeEffect[];
}

const als = new AsyncLocalStorage<Scope>();

export function tapeMode(): 'RECORD' | 'REPLAY' | null {
  return als.getStore()?.mode ?? null;
}
export const isReplaying = (): boolean => als.getStore()?.mode === 'REPLAY';

export class ReplayDivergence extends Error {
  constructor(public readonly key: string) {
    super(`Replay divergence: no recorded result for ${key.slice(0, 200)}`);
    this.name = 'ReplayDivergence';
  }
}

// ---------------- encoding ----------------

/** JSON-safe encoding that keeps Dates, Buffers, BigInts, undefined and non-finite numbers. */
export function encode(v: unknown): unknown {
  if (v === undefined) return { $u: 1 };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
  if (typeof v === 'bigint') return { $b: v.toString() };
  if (v instanceof Date) return { $d: Number.isNaN(v.getTime()) ? null : v.toISOString() };
  if (Buffer.isBuffer(v)) return { $buf: v.toString('base64') };
  if (Array.isArray(v)) return v.map(encode);
  if (v instanceof Map) return { $map: [...v.entries()].map(([k, x]) => [encode(k), encode(x)]) };
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = encode(x);
    return { $o: out };
  }
  return null;
}

export function decode(v: unknown): any {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  const o = v as Record<string, any>;
  if ('$u' in o) return undefined;
  if ('$n' in o) return Number(o.$n);
  if ('$b' in o) return BigInt(o.$b);
  if ('$d' in o) return o.$d == null ? new Date(NaN) : new Date(o.$d);
  if ('$buf' in o) return Buffer.from(o.$buf, 'base64');
  if ('$map' in o) return new Map(o.$map.map(([k, x]: [unknown, unknown]) => [decode(k), decode(x)]));
  if ('$o' in o) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o.$o as Record<string, unknown>)) out[k] = decode(x);
    return out;
  }
  return o;
}

/** Stable JSON (sorted keys) of an encoded value — the key material. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

const keyOf = (ch: string, op: string, args: unknown): string => `${ch}|${op}|${stable(encode(args))}`;
/** A write is matched on its target and a digest of its payload — the payload itself (a snapshot row, a cached setup) is never stored. */
const writeKeyOf = (ch: string, op: string, target: string, args: unknown): string => `${ch}|${op}|w|${target}|${createHash('sha1').update(stable(encode(args))).digest('hex')}`;

// ---------------- the core ----------------

/**
 * One boundary call. Outside a tape scope: `exec` runs untouched. RECORD:
 * runs it and appends the entry. REPLAY: answers from the tape; an
 * unrecorded write is a no-op effect with `fallback` as its result; an
 * unrecorded read is a divergence (thrown / rejected).
 */
export function taped<T>(ch: string, op: string, args: unknown, opts: { write: boolean; async: boolean; target?: string; fallback?: unknown; opaque?: boolean }, exec: () => T): T {
  const scope = als.getStore();
  if (!scope) return exec();
  const key = opts.write ? writeKeyOf(ch, op, opts.target ?? op, args) : keyOf(ch, op, args);
  if (scope.mode === 'RECORD') {
    const entry: TapeEntry = { ch, op, key, write: opts.write, async: opts.async, ...(opts.write ? { target: opts.target ?? op } : {}) };
    scope.entries.push(entry);
    try {
      // Opaque: the value itself is the input; what it reads inside is not taped again.
      const out = opts.opaque ? als.exit(exec) : exec();
      if (out && typeof (out as any).then === 'function') {
        entry.async = true;
        return (out as any).then(
          (v: unknown) => {
            entry.ok = true;
            entry.v = encode(v);
            return v;
          },
          (err: any) => {
            entry.ok = false;
            entry.e = err?.message ?? String(err);
            throw err;
          }
        );
      }
      entry.ok = true;
      entry.v = encode(out);
      return out;
    } catch (err: any) {
      entry.ok = false;
      entry.e = err?.message ?? String(err);
      throw err;
    }
  }
  // REPLAY
  const q = scope.queues.get(key);
  const hit = q && q.length > 0 ? q.shift()! : null;
  if (opts.write) scope.effects.push({ ch, op, target: opts.target ?? op, recorded: hit != null });
  const settle = (): any => {
    if (hit && hit.ok === true) return decode(hit.v);
    if (hit && hit.ok === false) throw new Error(hit.e ?? 'recorded failure');
    if (opts.write) return opts.fallback ?? null;
    scope.divergences.push(key);
    throw new ReplayDivergence(key);
  };
  const isAsync = hit ? hit.async : opts.async;
  if (isAsync) {
    try {
      return Promise.resolve(settle()) as unknown as T;
    } catch (err) {
      return Promise.reject(err) as unknown as T;
    }
  }
  return settle();
}

/** Record a live decision path; returns its result and the tape (only settled entries are replayable). */
export async function runRecording<T>(fn: () => Promise<T>): Promise<{ result: T; tape: TapeEntry[] }> {
  const scope: Scope = { mode: 'RECORD', entries: [], queues: new Map(), divergences: [], effects: [] };
  const result = await als.run(scope, fn);
  return { result, tape: scope.entries };
}

/** Replay a decision path against a tape: its result, the reads the tape did not hold, and the writes it would have made. */
export async function runReplay<T>(tape: readonly TapeEntry[], fn: () => Promise<T>, opts: { now?: number } = {}): Promise<{ result: T | null; error: string | null; divergences: string[]; effects: TapeEffect[] }> {
  const queues = new Map<string, TapeEntry[]>();
  for (const e of tape) {
    if (e.ok == null) continue; // pending at save time: never answered
    const q = queues.get(e.key) ?? [];
    q.push(e);
    queues.set(e.key, q);
  }
  const scope: Scope = { mode: 'REPLAY', entries: [], queues, divergences: [], effects: [], frozenNow: opts.now };
  try {
    const result = await als.run(scope, fn);
    return { result, error: null, divergences: scope.divergences, effects: scope.effects };
  } catch (err: any) {
    return { result: null, error: err?.message ?? String(err), divergences: scope.divergences, effects: scope.effects };
  }
}

/** A sync / async value from in-process state (a module map, a guard) — taped like any boundary. */
export function tapedValue<T>(name: string, args: unknown, read: () => T): T {
  return taped('state', name, args, { write: false, async: false }, read);
}

/** An input acquired as a whole (an option chain, a futures quote, an NSE lookup): taped as one value, its own reads not taped again. */
export function tapedInput<T>(name: string, args: unknown, load: () => Promise<T>): Promise<T> {
  return taped('input', name, args, { write: false, async: true, opaque: true }, load);
}

// ---------------- Redis ----------------

const REDIS_WRITE = new Set(['eval', 'set', 'setex', 'psetex', 'del', 'unlink', 'expire', 'pexpire', 'persist', 'incr', 'incrby', 'decr', 'decrby', 'zadd', 'zrem', 'zremrangebyscore', 'hset', 'hdel', 'hincrby', 'lpush', 'rpush', 'ltrim', 'sadd', 'srem', 'mset', 'publish', 'getset', 'getdel']);
const REDIS_READ = new Set(['get', 'mget', 'exists', 'ttl', 'pttl', 'type', 'scan', 'keys', 'zrange', 'zrangebyscore', 'zrevrange', 'zscore', 'zcard', 'hget', 'hgetall', 'hmget', 'smembers', 'sismember', 'scard', 'lrange', 'llen', 'strlen']);
const REDIS_FALLBACK: Record<string, unknown> = { eval: 1, set: 'OK', setex: 'OK', psetex: 'OK', mset: 'OK', del: 1, unlink: 1, expire: 1, pexpire: 1, persist: 1, incr: 1, incrby: 1, decr: 0, decrby: 0, zadd: 1, zrem: 1, zremrangebyscore: 0, hset: 1, hdel: 1, hincrby: 1, lpush: 1, rpush: 1, ltrim: 'OK', sadd: 1, srem: 1, publish: 0, getset: null, getdel: null };

/** The Redis client, taped inside a scope and untouched outside one. */
export function tapedRedis<T extends object>(raw: T): T {
  return new Proxy(raw, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      const isWrite = REDIS_WRITE.has(prop);
      const isRead = REDIS_READ.has(prop);
      return (...args: unknown[]) => {
        const scope = als.getStore();
        if (!scope || (!isWrite && !isRead)) {
          if (scope?.mode === 'REPLAY') throw new Error(`Redis ${prop} is not available during replay`);
          return value.apply(target, args);
        }
        // eval(script, numKeys, key, …): the key is its target, not the script text.
        const tgt = prop === 'eval' ? String(args[2]) : String(args[0]);
        return taped('redis', prop, args, { write: isWrite, async: true, target: tgt, fallback: REDIS_FALLBACK[prop] }, () => value.apply(target, args));
      };
    },
  });
}

// ---------------- SQL (postgres.js) ----------------

/** A template call's key material: its text and its values (fragments nested, sql.json by value). */
function templateKey(strings: readonly string[], values: readonly unknown[]): unknown {
  const val = (v: unknown): unknown => {
    if (v && typeof v === 'object') {
      const o = v as any;
      if (Array.isArray(o.strings) && Array.isArray(o.args)) return { frag: templateKey(o.strings, o.args) };
      if ('value' in o && 'type' in o && 'array' in o) return { param: o.value };
    }
    return v;
  };
  return { text: strings.join('\u0001'), values: values.map(val) };
}

const isWriteSql = (strings: readonly string[]): boolean => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(strings[0] ?? '');

/** The SQL client, taped inside a scope (on execution — fragments are never queries) and untouched outside one. */
export function tapedSql<T extends (...args: any[]) => any>(raw: T): T {
  return new Proxy(raw, {
    apply(target, thisArg, args: any[]) {
      const scope = als.getStore();
      const strings = args[0];
      const isTemplate = Array.isArray(strings) && Array.isArray((strings as any).raw);
      if (!scope || !isTemplate) return Reflect.apply(target, thisArg, args);
      const values = args.slice(1);
      const key = templateKey(strings, values);
      const write = isWriteSql(strings);
      const target_ = (strings as string[]).join('?').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (scope.mode === 'RECORD') {
        const q = Reflect.apply(target, thisArg, args);
        const origThen = q.then.bind(q);
        let p: Promise<unknown> | null = null;
        q.then = (res?: any, rej?: any) => {
          // Recorded on execution (the first then): a fragment is never awaited, so never recorded.
          p ??= taped('sql', 'query', key, { write, async: true, target: target_, fallback: [] }, () => origThen((v: unknown) => v));
          return p!.then(res, rej);
        };
        return q;
      }
      // REPLAY: a stand-in that answers from the tape when awaited, and nests as a fragment.
      let p: Promise<unknown> | null = null;
      const fake: any = {
        strings,
        args: values,
        then(res?: any, rej?: any) {
          p ??= taped('sql', 'query', key, { write, async: true, target: target_, fallback: [] }, () => Promise.reject(new Error('unreachable')));
          return p.then(res, rej);
        },
        catch(rej: any) {
          return fake.then(undefined, rej);
        },
        finally(f: any) {
          return fake.then((v: unknown) => (f(), v), (e: unknown) => (f(), Promise.reject(e)));
        },
      };
      return fake;
    },
  });
}

// ---------------- the broker ----------------

/** RECORD: the live provider, every method call taped. */
export function tapedProvider<T extends object>(provider: T): T {
  return new Proxy(provider, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => taped('provider', prop, args, { write: false, async: false }, () => value.apply(target, args));
    },
  });
}

/** REPLAY: a provider that only answers from the tape (its name as recorded). */
export function replayProvider(name: string): any {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'name') return name;
        if (prop === 'then') return undefined;
        if (typeof prop !== 'string') return undefined;
        return (...args: unknown[]) => taped('provider', prop, args, { write: false, async: false }, () => {
          throw new Error('unreachable');
        });
      },
    }
  );
}

// ---------------- the network ----------------

let clockInstalled = false;
/** During a replay, Date.now() inside the scope is the decision instant; everywhere else the real clock. */
export function installReplayClock(): void {
  if (clockInstalled) return;
  clockInstalled = true;
  const realNow = Date.now.bind(Date);
  Date.now = () => {
    const s = als.getStore();
    return s?.mode === 'REPLAY' && s.frozenNow != null ? s.frozenNow : realNow();
  };
}

let guardInstalled = false;
/** During a replay every network call is refused (Telegram, NSE, …); outside one nothing changes. */
export function installReplayNetworkGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
      isReplaying() ? Promise.reject(new Error('Network blocked during replay')) : realFetch(...args)) as typeof fetch;
  }
  axios.interceptors.request.use((cfg) => {
    if (isReplaying()) throw new Error('Network blocked during replay');
    return cfg;
  });
}
installReplayNetworkGuard();
installReplayClock();
