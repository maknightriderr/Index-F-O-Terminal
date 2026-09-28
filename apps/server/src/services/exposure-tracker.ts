// ============================================================
// EXPOSURE TRACKER (Phase 2 — live, purely observational)
// ============================================================
// SIMULATED PORTFOLIO ACCOUNTING ONLY. This is a paper-trading system; these
// are paper setups held in Redis, not broker positions, and this must never
// become broker-position infrastructure.
//
// Nothing tracked concurrent exposure before: the only per-symbol/direction
// control is the loss-count cooldown (MAX_SAME_DIRECTION_LOSSES_PER_DAY),
// which counts closed losses, not what is open at once. So two paper setups
// on NIFTY and BANKNIFTY, both bullish, looked like two independent trades.
//
// When a new sticky setup is minted, this reads the OTHER sticky setups
// already live in Redis (the existing trade_setup:* keys — no new state) and
// records how much of the paper book already leans the same way. It is
// written to the decision snapshot and read by the loss-attribution report.
// This module NEVER blocks, gates, sizes down or otherwise alters a setup.
// (The validation review's CONCURRENT_EXPOSURE gate — flag CONCURRENCY_CAP,
// default OFF — reads these counts in market-bias.ts; the decision is made
// there, in validation-gates.ts, not here.)
//
// "Correlated" is deliberately narrow: same direction, different symbol,
// same configured index family. Not inferred from price history.
// ============================================================

import type { BiasDirection } from '@fno/shared';

/**
 * Index families whose members move together closely enough that the same
 * direction on two of them is one bet, not two. Configurable list; a symbol
 * in no family is its own family of one.
 */
export const CORRELATED_INDEX_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  INDIA_EQUITY_INDEX: ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX'],
};

export function familyOf(symbol: string, families: Readonly<Record<string, readonly string[]>> = CORRELATED_INDEX_FAMILIES): string {
  const upper = symbol.toUpperCase();
  for (const [family, members] of Object.entries(families)) {
    if (members.includes(upper)) return family;
  }
  return `SELF:${upper}`;
}

/** The subset of a stored sticky setup the accounting reads. */
export interface ExposureSetup {
  /** Redis key, trade_setup:{exchange}:{underlying}:{mode}. */
  key: string;
  exchange: string;
  underlying: string;
  mode: string;
  direction: BiasDirection | null;
  strike: number | null;
  side: 'CE' | 'PE' | null;
  expiry: string | null;
  /** Rupees to the CURRENT stop for the whole paper position (0 once trailed to/above entry). */
  riskAmount: number;
}

export interface ExposureSnapshot {
  simulated: true;
  /** Rupees at risk to the stops across every live paper setup, including the new one. */
  openSimulatedRisk: number;
  /** Live paper setups including the new one. */
  openSetupCount: number;
  sameSymbolExposure: number;
  sameUnderlyingExposure: number;
  sameDirectionExposure: number;
  correlatedExposure: number;
  detail: {
    family: string;
    riskBy: { sameSymbol: number; sameUnderlying: number; sameDirection: number; correlated: number };
    others: Array<{ key: string; direction: BiasDirection | null; strike: number | null; side: string | null; riskAmount: number }>;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Pure accounting over the new setup and the other live ones. */
export function computeExposure(
  current: ExposureSetup,
  others: readonly ExposureSetup[],
  families: Readonly<Record<string, readonly string[]>> = CORRELATED_INDEX_FAMILIES
): ExposureSnapshot {
  const peers = others.filter((o) => o.key !== current.key);
  const family = familyOf(current.underlying, families);
  const directional = current.direction === 'BULLISH' || current.direction === 'BEARISH';

  const sameSymbol = peers.filter(
    (o) => o.underlying === current.underlying && o.strike != null && o.strike === current.strike && o.side === current.side && o.expiry === current.expiry
  );
  const sameUnderlying = peers.filter((o) => o.underlying === current.underlying);
  const sameDirection = directional ? peers.filter((o) => o.direction === current.direction) : [];
  const correlated = directional
    ? peers.filter((o) => o.direction === current.direction && o.underlying !== current.underlying && familyOf(o.underlying, families) === family)
    : [];

  const risk = (xs: readonly ExposureSetup[]) => round2(xs.reduce((s, o) => s + Math.max(0, o.riskAmount), 0));

  return {
    simulated: true,
    openSimulatedRisk: round2(Math.max(0, current.riskAmount) + risk(peers)),
    openSetupCount: peers.length + 1,
    sameSymbolExposure: sameSymbol.length,
    sameUnderlyingExposure: sameUnderlying.length,
    sameDirectionExposure: sameDirection.length,
    correlatedExposure: correlated.length,
    detail: {
      family,
      riskBy: { sameSymbol: risk(sameSymbol), sameUnderlying: risk(sameUnderlying), sameDirection: risk(sameDirection), correlated: risk(correlated) },
      others: peers.map((o) => ({ key: o.key, direction: o.direction, strike: o.strike, side: o.side, riskAmount: round2(Math.max(0, o.riskAmount)) })),
    },
  };
}

/** Structural view of a stored sticky setup — the fields this reads, nothing more. */
export interface StoredSetupLike {
  available?: boolean;
  direction?: BiasDirection;
  day?: string;
  structureType?: string;
  strike?: number;
  side?: 'CE' | 'PE';
  expiry?: string;
  entry?: number;
  stopLoss?: number;
  maxLoss?: number;
  positionSize?: { quantity?: number; lotSize?: number } | null;
}

/**
 * Converts one stored sticky setup into the accounting shape, or null when it
 * is not a live paper position (unavailable, or an INTRADAY setup from a prior
 * session that the next poll will close as SESSION_ENDED).
 */
export function toExposureSetup(key: string, stored: StoredSetupLike | null, today: string): ExposureSetup | null {
  const parts = key.split(':'); // trade_setup:{exchange}:{underlying}:{mode}
  if (parts.length !== 4 || !stored?.available) return null;
  const [, exchange, underlying, mode] = parts;
  if (mode === 'INTRADAY' && stored.day !== today) return null;

  const quantity = stored.positionSize?.quantity ?? stored.positionSize?.lotSize ?? 1;
  let riskAmount = 0;
  if (stored.structureType === 'SPREAD') {
    riskAmount = (stored.maxLoss ?? 0) * quantity;
  } else if (stored.entry != null && stored.stopLoss != null) {
    riskAmount = Math.max(0, stored.entry - stored.stopLoss) * quantity;
  }
  return {
    key,
    exchange,
    underlying,
    mode,
    direction: stored.direction ?? null,
    strike: stored.strike ?? null,
    side: stored.side ?? null,
    expiry: stored.expiry ?? null,
    riskAmount,
  };
}

/** Pairs MGET results with their keys. A missing or unparsable value is skipped, not fatal. Pure. */
export function exposureSetupsFrom(keys: readonly string[], values: readonly (string | null)[], today: string): ExposureSetup[] {
  const out: ExposureSetup[] = [];
  keys.forEach((key, i) => {
    const raw = values[i];
    if (!raw) return;
    let parsed: StoredSetupLike | null = null;
    try {
      parsed = JSON.parse(raw) as StoredSetupLike;
    } catch {
      return;
    }
    const setup = toExposureSetup(key, parsed, today);
    if (setup) out.push(setup);
  });
  return out;
}

/**
 * Reads every live sticky setup except `excludeKey` and computes the
 * exposure the new setup joins. Never throws: a Redis failure returns null,
 * and nothing downstream depends on the result. Redis is imported lazily so
 * the pure functions above stay importable without a connection.
 */
export async function readExposureAtCreation(current: ExposureSetup, today: string): Promise<ExposureSnapshot | null> {
  try {
    const { redis, scanKeys } = await import('../lib/redis.js');
    const keys = (await scanKeys('trade_setup:*')).filter((k) => k !== current.key);
    // One MGET instead of one GET per key: with CONCURRENCY_CAP on this read
    // sits in the decision path, not only after the row is written.
    const values = keys.length > 0 ? await redis.mget(...keys) : [];
    return computeExposure(current, exposureSetupsFrom(keys, values, today));
  } catch (err: any) {
    // Logged, not swallowed: a missing exposure row must be explainable.
    const { logger } = await import('../lib/logger.js');
    logger.warn({ error: err?.message, key: current.key }, 'Exposure tracker: read failed — exposure not recorded for this setup');
    return null;
  }
}
