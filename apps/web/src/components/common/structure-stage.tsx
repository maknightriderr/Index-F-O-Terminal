'use client';

import React from 'react';
import type { StructureLifecycleView, SetupExplanationInput } from '@fno/shared';
import { buildSetupExplanation, formatExpiryDate } from '@fno/shared';
import type { SetupOutcome } from '@/lib/use-setup-outcomes';

// Structure engine lifecycle: WATCH → DEVELOPING → CONFIRMED → ENTRY → ACTIVE.
// Shared by the scanner's "Developing setups" list and the asset workspace's
// Trade Setup card.

const STAGE_STYLES: Record<string, { label: string; className: string }> = {
  WATCH: { label: 'Watch', className: 'bg-gray-500/15 text-gray-300 light:text-slate-700' },
  DEVELOPING: { label: 'Developing', className: 'bg-amber-500/15 text-amber-400 light:text-amber-700' },
  CONFIRMED: { label: 'Confirmed', className: 'bg-cyan-500/15 text-cyan-400 light:text-cyan-700' },
  ENTRY: { label: 'Entry', className: 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' },
  ACTIVE: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700' },
  REFUSED: { label: 'Refused', className: 'bg-red-500/15 text-red-400 light:text-red-700' },
  INVALIDATED: { label: 'Invalidated', className: 'bg-red-500/15 text-red-400 light:text-red-700' },
  LATE: { label: 'Late', className: 'bg-amber-500/15 text-amber-400 light:text-amber-700' },
  MISSED: { label: 'Missed', className: 'bg-amber-500/15 text-amber-400 light:text-amber-700' },
  LOW_RR: { label: 'Low R:R', className: 'bg-amber-500/15 text-amber-400 light:text-amber-700' },
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

/**
 * The shared builder's input from a lifecycle row plus, when known, its
 * stored setup_events measurement. Structured fields only; informational.
 */
export function lifecycleExplanationInput(row: StructureLifecycleView, outcome?: SetupOutcome | null, option?: SetupExplanationInput['option']): SetupExplanationInput {
  const rejected = row.liveOutcome === 'REFUSED' || row.stage === 'INVALIDATED' || row.stage === 'LATE' || row.stage === 'MISSED' || row.stage === 'LOW_RR';
  return {
    direction: row.direction,
    pool: row.pool,
    sweepExtreme: row.sweepExtreme,
    zone: row.zone,
    entry: row.entry,
    stop: row.stop,
    t1: row.t1,
    t2: row.t2,
    rToT1: row.rToT1,
    score: row.score,
    scoreCandle: row.scoreCandle ?? null,
    patterns: row.patterns ?? null,
    timeframe: row.timeframe ?? null,
    option: option ?? null,
    netR: outcome?.netRr ?? null,
    costR: outcome?.costR ?? null,
    costQuality: outcome?.costQuality ?? null,
    rejection: rejected
      ? {
          reason: outcome?.rejectionReason ?? row.liveReason ?? row.reason,
          wouldBeValidIf: outcome?.wouldBeValidIf ?? null,
          fillStatus: outcome?.fillStatus ?? null,
          resultR: outcome?.resultR ?? null,
          netResultR: outcome?.netResultR ?? null,
        }
      : null,
  };
}

/** For / Against / Invalidation / Would be valid if, from the shared builder (the same one Telegram uses). */
export function explanationLines(row: StructureLifecycleView): {
  forLines: string[];
  against: string[];
  invalidation: string;
  wouldBeValidIf: string | null;
} {
  const e = buildSetupExplanation(lifecycleExplanationInput(row));
  return { forLines: e.forLines, against: e.against, invalidation: e.invalidation, wouldBeValidIf: e.wouldBeValidIf };
}

/** Renders explanationLines() as a compact block. Nothing renders for an empty section. */
export function ExplanationBlock({ row }: { row: StructureLifecycleView }) {
  const { forLines, against, invalidation, wouldBeValidIf } = explanationLines(row);
  if (forLines.length === 0 && against.length === 0) return null;
  return (
    <div className="mt-1.5 text-[10px] space-y-0.5">
      {forLines.map((l, i) => (
        <div key={`for-${i}`} className="text-emerald-400 light:text-emerald-700">+ {l}</div>
      ))}
      {against.map((l, i) => (
        <div key={`against-${i}`} className="text-amber-400 light:text-amber-700">- {l}</div>
      ))}
      <div className="text-gray-500 light:text-slate-500">{invalidation}</div>
      {wouldBeValidIf && <div className="text-gray-500 light:text-slate-500 italic">{wouldBeValidIf}</div>}
    </div>
  );
}

const FILL_LABEL: Record<string, string> = {
  FILLED: 'FILLED — the entry price traded after the refusal',
  NO_FILL: 'NO_FILL — price never came back to the entry',
  PENDING: 'Pending — graded after the session',
  NOT_GRADED: 'Not graded for this event type',
};

/**
 * The full explanation for the main Trade Setup card: why, trigger, pool,
 * levels, option, grade, gross/net R, for/against, invalidation, would be
 * valid if, and for a rejected setup its reason, potential levels, fill
 * status and (only when it filled) the graded outcome. Every line comes from
 * the shared builder over stored fields. Informational: it changes nothing.
 */
export function SetupExplanationPanel({ input }: { input: SetupExplanationInput }) {
  const e = buildSetupExplanation(input);
  const rows: [string, React.ReactNode][] = [
    ['Why', e.why],
    ['Trigger', e.trigger ?? '—'],
    ['Pool', e.pool ?? '—'],
    ['Entry · Stop', `${num(e.entry)} · ${num(e.stop)}`],
    ['T1 · T2', `${num(e.t1)} · ${num(e.t2)}`],
  ];
  if (e.option) rows.push(['Option', e.option]);
  rows.push([
    'Grade · R',
    <>
      {e.grade ?? '—'} · gross {e.grossR != null ? `${e.grossR}R` : '—'} · net {e.netR != null ? `${e.netR.toFixed(2)}R` : 'not measured'}
      {e.costNote && <span className="block text-gray-500 light:text-slate-500">{e.costNote}</span>}
    </>,
  ]);
  return (
    <div className="mt-2 rounded border border-gray-700/60 light:border-slate-300 px-2 py-1.5 text-[10px] space-y-1">
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-gray-500 light:text-slate-500 whitespace-nowrap">{k}</dt>
            <dd className="text-gray-300 light:text-slate-700 tabular-nums min-w-0 break-words">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {e.rejected && (
        <div className="rounded bg-red-500/5 border border-red-500/20 px-1.5 py-1 space-y-0.5">
          <div className="text-red-300 light:text-red-700 font-semibold">Rejected: {e.rejected.reason}</div>
          <div className="text-gray-400 light:text-slate-600 tabular-nums">{e.rejected.potential}</div>
          <div className="text-gray-400 light:text-slate-600">Fill: {FILL_LABEL[e.rejected.fillStatus] ?? e.rejected.fillStatus}</div>
          {e.rejected.outcome && <div className="text-gray-300 light:text-slate-700">{e.rejected.outcome}</div>}
        </div>
      )}
      {e.forLines.map((l, i) => (
        <div key={`for-${i}`} className="text-emerald-400 light:text-emerald-700">+ {l}</div>
      ))}
      {e.against.map((l, i) => (
        <div key={`against-${i}`} className="text-amber-400 light:text-amber-700">- {l}</div>
      ))}
      <div className="text-gray-500 light:text-slate-500">{e.invalidation}</div>
      {e.wouldBeValidIf && (
        <div className="text-gray-500 light:text-slate-500 italic">{/^would be valid/i.test(e.wouldBeValidIf) ? e.wouldBeValidIf : `Would be valid if: ${e.wouldBeValidIf}`}</div>
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
