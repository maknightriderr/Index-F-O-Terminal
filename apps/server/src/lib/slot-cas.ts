// ============================================================
// TRADE SLOT — compare-and-set (2026-10-09)
// ============================================================
// The paper-trade slot (trade_setup:{exchange}:{symbol}:{mode}) is read,
// worked on and written back by several callers at once: browser polls, the
// background evaluator, the market scanner and the tick-driven price
// monitor. A plain SET / DEL of a copy read earlier can overwrite or delete a
// NEWER trade another caller has just minted into the slot (seen in
// production on 2026-10-08: a fresh NIFTY trade was overwritten by the
// monitor's stale copy of the trade it replaced and never tracked again).
//
// Every update or clear of an EXISTING trade therefore goes through these:
// the write happens only if the slot still holds the same trade (same
// signalId, or the same generatedAt for a trade whose row is not written
// yet). Atomic in Redis (a Lua script). Minting a new trade is not affected —
// it already runs under the mint lock (setup-mint-lock.ts).
// ============================================================

import { redis } from './redis.js';

/** A stored trade's identity: its signals row id, else its generation time. Null for an empty / unavailable slot. */
export function slotIdentity(s: { signalId?: string | null; generatedAt?: number | null; available?: boolean } | null | undefined): string | null {
  if (!s) return null;
  if (s.signalId) return `sig:${s.signalId}`;
  return s.generatedAt != null ? `gen:${s.generatedAt}` : null;
}

const SAME = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local ok, obj = pcall(cjson.decode, cur)
if not ok or type(obj) ~= 'table' then return 0 end
local id
if obj['signalId'] ~= nil and obj['signalId'] ~= cjson.null and obj['signalId'] ~= '' then id = 'sig:' .. tostring(obj['signalId'])
elseif obj['generatedAt'] ~= nil and obj['generatedAt'] ~= cjson.null then id = 'gen:' .. string.format('%.0f', obj['generatedAt'])
else return 0 end
if id ~= ARGV[1] then return 0 end
`;

const SET_IF_SAME = `${SAME}
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1`;

const DEL_IF_SAME = `${SAME}
redis.call('DEL', KEYS[1])
return 1`;

/** Write `value` to the slot only if it still holds the trade `expected` identifies. True when written. */
export async function setSlotIfSame(key: string, expected: string | null, value: unknown, ttlSeconds: number): Promise<boolean> {
  if (!expected) return false;
  const r = await (redis as any).eval(SET_IF_SAME, 1, key, expected, JSON.stringify(value), String(ttlSeconds));
  return Number(r) === 1;
}

/** Clear the slot only if it still holds the trade `expected` identifies. True when cleared. */
export async function delSlotIfSame(key: string, expected: string | null): Promise<boolean> {
  if (!expected) return false;
  const r = await (redis as any).eval(DEL_IF_SAME, 1, key, expected);
  return Number(r) === 1;
}

/** For tests / the in-memory harnesses: the same rule, evaluated on a JSON string. */
export function sameTrade(raw: string | null, expected: string | null): boolean {
  if (!raw || !expected) return false;
  try {
    return slotIdentity(JSON.parse(raw)) === expected;
  } catch {
    return false;
  }
}
