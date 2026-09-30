'use client';

import React from 'react';
import type { StructureLifecycleView } from '@fno/shared';
import { formatExpiryDate } from '@fno/shared';

// Structure engine lifecycle: WATCH → DEVELOPING → CONFIRMED → ENTRY → ACTIVE.
// Shared by the scanner's "Developing setups" list and the asset workspace's
// Trade Setup card.

const STAGE_STYLES: Record<string, { label: string; className: string }> = {
  WATCH: { label: 'Watch', className: 'bg-gray-500/15 text-gray-300 light:text-slate-700' },
  DEVELOPING: { label: 'Developing', className: 'bg-amber-500/15 text-amber-400 light:text-amber-700' },
  CONFIRMED: { label: 'Confirmed', className: 'bg-cyan-500/15 text-cyan-400 light:text-cyan-700' },
  ENTRY: { label: 'Entry', className: 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' },
  ACTIVE: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' },
};

const STAGE_MEANING: Record<string, string> = {
  WATCH: 'Price is within 0.5 ATR of an untaken liquidity pool.',
  DEVELOPING: 'The pool was swept; waiting for a displacement the other way (3 bars).',
  CONFIRMED: 'Displacement printed; a limit rests at the zone for 8 bars.',
  ENTRY: 'The limit filled.',
  ACTIVE: 'The trade is on; it ends at the stop, T1, a sweep reclaim or the session end.',
};

// With 5m entries (STRUCTURE_ENTRY_TF = '5m') pools stay on 15m bars; the
// sweep, displacement, zone and fill run on 5m bars, with the windows in time.
const STAGE_MEANING_5M: Record<string, string> = {
  ...STAGE_MEANING,
  DEVELOPING: 'The pool (15m) was swept on a 5m bar; waiting for a displacement the other way (30 min).',
  CONFIRMED: 'Displacement printed on 5m; a limit rests at the zone for 120 min.',
};

export function StageBadge({ stage }: { stage: string }) {
  const s = STAGE_STYLES[stage] ?? { label: stage, className: 'bg-gray-500/15 text-gray-400' };
  return <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${s.className}`}>{s.label}</span>;
}

export function stageMeaning(stage: string, timeframe?: string | null): string {
  return (timeframe === '5m' ? STAGE_MEANING_5M : STAGE_MEANING)[stage] ?? '';
}

/** The entry timeframe a lifecycle runs on: "15m", or "5m entry" (15m pools, 5m reaction). */
export function TimeframeTag({ timeframe }: { timeframe?: string | null }) {
  const five = timeframe === '5m';
  return (
    <span
      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded tabular-nums ${five ? 'bg-violet-500/15 text-violet-300 light:text-violet-700' : 'bg-gray-500/10 text-gray-400 light:text-slate-600'}`}
      title={five ? 'Pools from 15m bars; sweep, displacement, zone and fill on 5m bars' : 'Pools and the reaction on 15m bars'}
    >
      {five ? '5m entry' : '15m'}
    </span>
  );
}

const pretty = (kind: string | undefined | null) => (kind ? kind.replace(/_/g, ' ').toLowerCase() : '—');
const num = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

/**
 * The setup's candles, named ("Hammer sweep of PDL → bullish engulfing"),
 * with the candle points inside the score. Descriptive only: the score never
 * gates. Renders nothing for WATCH rows and states written before labels.
 */
export function PatternLabel({ row }: { row: Pick<StructureLifecycleView, 'patterns' | 'scoreCandle'> }) {
  if (!row.patterns) return null;
  const c = row.scoreCandle;
  const parts = c
    ? [c.rejection ? `clean rejection +${c.rejection}` : null, c.engulfing ? `engulfing +${c.engulfing}` : null, c.star ? `star +${c.star}` : null].filter(Boolean)
    : [];
  const title =
    'Candle shapes of the sweep and the displacement — descriptive only.' +
    (c ? ` Score candle points: ${parts.length ? parts.join(', ') : 'none'}${c.applied !== c.rejection + c.engulfing + c.star ? ` (${c.applied} after the Tier-1 cap)` : ''}; the score never gates.` : '');
  return (
    <span className="block text-[11px] text-sky-300 light:text-sky-700 mt-0.5" title={title}>
      {row.patterns.label}
      {c && c.applied > 0 ? <span className="text-gray-400 light:text-slate-600"> · +{c.applied} score</span> : null}
    </span>
  );
}

/**
 * The engine's own note on why the lifecycle is where it is — e.g. under
 * STRUCTURE_ENTRY_MODE = REJECTION_CLOSE, a CONFIRMED lifecycle carries
 * "waiting for rejection candle at zone" until a closed candle actually
 * rejects the zone (see rejection-close.ts). Renders nothing when absent.
 */
export function LifecycleReason({ row }: { row: Pick<StructureLifecycleView, 'reason'> }) {
  if (!row.reason) return null;
  return <span className="block text-[11px] text-amber-300 light:text-amber-700 mt-0.5 italic">{row.reason}</span>;
}

/**
 * The plain-words summary of where a lifecycle stands, per stage — the
 * wording the user asked for so a CONFIRMED-with-no-trade reads as a
 * pending order rather than a contradiction. INVALIDATED/LATE/MISSED show
 * the engine's own reason when it has one.
 */
export function stageOneLiner(row: Pick<StructureLifecycleView, 'stage' | 'reason' | 'pool'>): string {
  switch (row.stage) {
    case 'WATCH':
      return `Watching — price near ${pretty(row.pool?.kind)} ${num(row.pool?.price)}`;
    case 'DEVELOPING':
      return 'Level swept — waiting for a strong reversal candle';
    case 'CONFIRMED':
      return 'Order pending — waiting for pullback to zone';
    case 'ENTRY':
    case 'ACTIVE':
      return 'Trade open';
    case 'INVALIDATED':
    case 'LATE':
    case 'MISSED':
      return row.reason || 'Setup did not complete';
    default:
      return row.reason ?? '';
  }
}

/**
 * A CONFIRMED lifecycle's pending order, in full — replaces a bare
 * "Confirmed · score N" with the actual plan: what would be bought, at
 * what estimated premiums, with what stop/target/R:R, and the trailing
 * rule it would run under once filled. Every premium is a read-only
 * ESTIMATE (server-computed, cached 60s) — no order exists yet.
 */
export function TradePreviewPanel({ row }: { row: StructureLifecycleView }) {
  const preview = row.preview;
  if (row.stage !== 'CONFIRMED' || !preview) return null;

  if (!preview.available) {
    return (
      <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-300 light:text-amber-700">
        If it fills now, F&amp;O validation would refuse it: {preview.reason ?? 'reason unavailable'}.
      </div>
    );
  }

  const zoneLabel = preview.underlyingZone
    ? preview.underlyingZone.kind === 'FVG'
      ? `${num(preview.underlyingZone.near)}–${num(preview.underlyingZone.far)}`
      : `${num(preview.underlyingZone.near)} (50%)`
    : '—';
  const expiryLabel = preview.expiry ? `${formatExpiryDate(preview.expiry)}${preview.dte != null ? `, ${preview.dte} DTE` : ''}` : null;

  return (
    <div className="mt-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1.5 text-[11px] space-y-1">
      <div className="font-semibold text-cyan-300 light:text-cyan-700">
        ORDER PENDING (est.) — Buy {row.symbol} {preview.strike} {preview.side}
        {expiryLabel ? ` (${expiryLabel})` : ''} if price returns to {zoneLabel}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-gray-300 light:text-slate-700 tabular-nums">
        <span>Entry ~₹{num(preview.estEntryPremium)}</span>
        <span>SL ~₹{num(preview.estStopLossPremium)}</span>
        <span>Target ~₹{num(preview.estTargetPremium)}</span>
        <span>R:R {preview.riskReward != null ? `1:${preview.riskReward.toFixed(2)}` : '—'}</span>
        <span>Underlying stop {num(preview.underlyingStop)}</span>
        <span>
          T1 {num(preview.underlyingT1)}
          {preview.underlyingT2 != null ? ` · T2 ${num(preview.underlyingT2)}` : ''}
        </span>
        {preview.lotSize != null && <span>Lot size {preview.lotSize}</span>}
      </div>
      {preview.trailPlan && (
        <div className="text-gray-400 light:text-slate-600">
          Trail: SL → entry at +{preview.trailPlan.breakevenAtR}R (₹{num(preview.trailPlan.breakevenPremium)}); locks +1x risk at +{preview.trailPlan.lockAtR}R (₹
          {num(preview.trailPlan.lockPremium)})
        </div>
      )}
      {preview.validUntil != null && (
        <div className="text-gray-500 light:text-slate-500">Valid until {new Date(preview.validUntil).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</div>
      )}
    </div>
  );
}

/** One-line description of a lifecycle's levels: pool, zone, stop, T1. */
export function LifecycleLevels({ row }: { row: StructureLifecycleView }) {
  return (
    <span className="text-[11px] text-gray-400 light:text-slate-600 tabular-nums">
      {pretty(row.pool?.kind)} {num(row.pool?.price)}
      {row.zone && (
        <>
          {' · zone '}
          {row.zone.kind === 'FVG' ? `${num(row.zone.near)}–${num(row.zone.far)}` : `${num(row.zone.near)} (50%)`}
        </>
      )}
      {row.stop != null && <> · stop {num(row.stop)}</>}
      {row.t1 && (
        <>
          {' · T1 '}
          {num(row.t1.price)} ({pretty(row.t1.kind)}
          {row.rToT1 != null ? `, ${row.rToT1}R` : ''})
        </>
      )}
    </span>
  );
}
