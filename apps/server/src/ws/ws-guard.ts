// ============================================================
// /ws HARDENING (Phase 7)
// ============================================================
// The browser tick bridge was open to anyone who could reach the port. Now:
//   * origin: a browser upgrade must come from an allowed origin — the same
//     CORS_ORIGINS list the REST API already enforces;
//   * token: when WS_AUTH_TOKEN is set, the upgrade must carry ?token= equal
//     to it (compared in constant time) — the only way in without an allowed
//     origin (non-browser clients);
//   * limits: at most WS_MAX_SUBSCRIPTIONS_PER_CLIENT tokens per client, a
//     bounded message size, and only well-formed subscription targets.
// Pure: every check takes its inputs as arguments.
// ============================================================

import { timingSafeEqual } from 'node:crypto';

export const WS_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_SUBSCRIPTIONS = 200;

export function parseMaxSubscriptions(raw: string | undefined): number {
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SUBSCRIPTIONS;
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Decide an upgrade: allowed origin, or (when a token is configured) the right token. */
export function authorizeWsUpgrade(args: { origin: string | undefined; url: string | undefined; allowedOrigins: readonly string[]; token: string | null }): { ok: true } | { ok: false; status: 401 | 403; reason: string } {
  const allowed = args.allowedOrigins.map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  const origin = args.origin?.trim().replace(/\/$/, '') ?? null;
  let given: string | null = null;
  try {
    given = new URL(args.url ?? '/', 'http://x').searchParams.get('token');
  } catch {
    given = null;
  }
  if (args.token) {
    if (given != null && sameToken(given, args.token)) return { ok: true };
    if (given != null) return { ok: false, status: 401, reason: 'Invalid token.' };
  }
  if (origin != null && allowed.includes(origin)) {
    // With a token configured a browser must also present it.
    if (args.token && given == null) return { ok: false, status: 401, reason: 'Token required.' };
    return { ok: true };
  }
  return { ok: false, status: 403, reason: origin == null ? 'No origin and no valid token.' : `Origin ${origin} is not allowed.` };
}

export interface WsTarget {
  token: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  exchangeSegment: string;
}

const SEGMENTS = new Set(['NSE_CM', 'NSE_FO', 'BSE_CM', 'BSE_FO', 'MCX_FO', 'CDE_FO', 'NCX_FO']);

/** Well-formed targets only (a numeric-ish instrument token, a known exchange and segment). */
export function validTargets(raw: unknown): WsTarget[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is WsTarget =>
      t != null &&
      typeof t === 'object' &&
      typeof (t as any).token === 'string' &&
      /^[A-Za-z0-9_-]{1,32}$/.test((t as any).token) &&
      ['NSE', 'BSE', 'MCX'].includes((t as any).exchange) &&
      SEGMENTS.has((t as any).exchangeSegment)
    )
    .map((t) => ({ token: t.token, exchange: t.exchange, exchangeSegment: t.exchangeSegment }));
}

/** How many of the requested (new) targets a client may add without exceeding its limit. */
export function admitSubscriptions(held: ReadonlySet<string>, requested: readonly WsTarget[], limit: number): { admitted: WsTarget[]; rejected: number } {
  const room = Math.max(0, limit - held.size);
  const fresh = requested.filter((t, i, a) => !held.has(`${t.exchangeSegment}:${t.token}`) && a.findIndex((x) => x.exchangeSegment === t.exchangeSegment && x.token === t.token) === i);
  const already = requested.filter((t) => held.has(`${t.exchangeSegment}:${t.token}`));
  const admitted = [...already, ...fresh.slice(0, room)];
  return { admitted, rejected: fresh.length - Math.min(fresh.length, room) };
}
