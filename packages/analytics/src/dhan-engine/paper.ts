// ============================================================
// DHAN ENGINE v2 — PHASE 4: a setup SIGNAL as a fresh-start paper candidate (pure)
// ============================================================
// Owner decisions (7 Nov): D1 hybrid (option books, pricing, fees and the paper store stay on the existing fresh-start
// adapter); D2 no stops on trade count (the store's risk limits are record-only flags); D3 options paper trades only;
// D4 a separate, tagged strategy (DHAN_*) beside the running fresh-start strategies.
//
// Only a setup result with status SIGNAL (every condition, every mandatory gate, score >= 7, no-trade engine clear)
// becomes a candidate. Its plan is in the Dhan FUTURES price space; the paper reference may be the same future or
// the spot (stocks). Levels are translated by the CURRENT difference between the two (reference price − futures
// price): a constant-basis translation, recorded in the evidence, never hidden. The candidate exits at the setup's
// target or stop (exit profile TARGET) and expires FRESH_ENTRY_WINDOW_MS after the decision, like every fresh entry.
// The expiry-gamma module is NOT paper-traded: the owner's rule defines no stop, and sizing needs one.
// ============================================================

import { FRESH_ENTRY_WINDOW_MS, FRESH_PACK_VERSION, type FreshCandidate, type FreshExternalStrategy } from '../fresh-start/strategies.js';
import { roundDp } from './common.js';
import type { SetupResult } from './setups.js';

export const DHAN_PAPER_STRATEGIES: readonly FreshExternalStrategy[] = ['DHAN_A_SWEEP_ABSORPTION', 'DHAN_B_IMBALANCE_BREAKOUT', 'DHAN_C_FAILED_AUCTION_CVD', 'DHAN_D_VWAP_PROFILE_REJECTION'];
/** The futures and reference prices used for the translation must be this fresh. */
export const DHAN_PAPER_MAX_PRICE_AGE_MS = 60_000;
/** A translation larger than this share of price means the two series are not the same underlying: refuse. */
export const DHAN_PAPER_MAX_BASIS_SHARE = 0.03;

export interface DhanPaperInput {
  symbol: string;
  result: SetupResult;
  /** The decision bar's start (15-minute bar) and the bar close (decision time). */
  barTime: number;
  decidedAt: number;
  atr: number;
  futures: { price: number; at: number };
  reference: { id: string; sourceEpoch: string; price: number; at: number; kind: 'FUTURES' | 'SPOT' };
  session: string;
  sessionClose: number;
  now: number;
}

export type DhanPaperOutcome = { ok: true; candidate: FreshCandidate } | { ok: false; code: string };

export function dhanPaperCandidate(x: DhanPaperInput): DhanPaperOutcome {
  const r = x.result;
  if (r.status !== 'SIGNAL' || !r.plan) return { ok: false, code: 'DHAN_NOT_A_SIGNAL' };
  if (!DHAN_PAPER_STRATEGIES.includes(r.strategy as FreshExternalStrategy)) return { ok: false, code: 'DHAN_STRATEGY_NOT_PAPER' };
  if (!(x.futures.price > 0) || !(x.reference.price > 0)) return { ok: false, code: 'DHAN_PRICE_UNAVAILABLE' };
  if (x.now - x.futures.at > DHAN_PAPER_MAX_PRICE_AGE_MS || x.now - x.reference.at > DHAN_PAPER_MAX_PRICE_AGE_MS) return { ok: false, code: 'DHAN_PRICE_STALE' };
  const shift = x.reference.price - x.futures.price;
  if (Math.abs(shift) > DHAN_PAPER_MAX_BASIS_SHARE * x.futures.price) return { ok: false, code: 'DHAN_REFERENCE_MISMATCH' };
  if (!(x.atr > 0)) return { ok: false, code: 'DHAN_ATR_UNAVAILABLE' };
  const tr = (p: number) => roundDp(p + shift, 4);
  const entry = tr(r.plan.entry), stop = tr(r.plan.sl), target = tr(r.plan.target);
  const bull = r.side === 'BULLISH';
  if (bull ? !(stop < entry && target > entry) : !(stop > entry && target < entry)) return { ok: false, code: 'DHAN_PLAN_INVALID' };
  const origin = x.decidedAt;
  const parentId = `${x.reference.id}:${x.session}:${r.side}:${origin}`;
  return {
    ok: true,
    candidate: {
      id: `${FRESH_PACK_VERSION}:${x.reference.sourceEpoch}:${parentId}:${r.strategy}:${x.barTime}`,
      parentId, version: FRESH_PACK_VERSION, strategy: r.strategy as FreshExternalStrategy, direction: r.side, instrument: x.reference.id,
      sourceEpoch: x.reference.sourceEpoch, session: x.session, at: x.decidedAt, referenceEntry: entry, stop, target, atr: x.atr, origin,
      expiresAt: Math.min(x.now + FRESH_ENTRY_WINDOW_MS, x.sessionClose - 3_600_000), exitProfile: 'TARGET',
      evidence: {
        dhan: {
          symbol: x.symbol, setup: r.setup, score: r.score?.total ?? null, eligibility: r.score?.eligibility ?? null, futuresPlan: r.plan,
          translation: { method: 'CONSTANT_BASIS', referenceKind: x.reference.kind, shift: roundDp(shift, 4), futuresPrice: x.futures.price, referencePrice: x.reference.price },
          rrBasis: 'GROSS_UNDERLYING', noTradeNotEvaluated: r.noTrade?.notEvaluated ?? [],
        },
        targetKind: r.plan.targetKind,
      },
    },
  };
}
