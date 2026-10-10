'use client';

import React from 'react';
import { isMarketOpen } from '@fno/shared';
import type { Exchange, StructureBlock } from '@fno/shared';
import type { BiasState } from '@/lib/use-market-bias';
import { classifyFreshness, FRESH_WITHIN_MS } from '@/lib/freshness';
import { formatAge, formatIstDateTime, formatNumber, MISSING } from '@/lib/format';
import { Section, MetricTile, MetricGrid } from '@/components/ui/card';
import { FreshnessBadge } from '@/components/ui/status-badge';
import { Disclosure } from '@/components/ui/controls';
import { BiasBadge } from '@/components/common/badges';

// ============================================================
// SECTION B — MARKET REGIME
// ============================================================
// A compact read of the selected instrument's last assessment, with where it came from and when. Scores are shown with
// what they are and are NOT: a composite of the engine's inputs, not a probability and not a trade recommendation. Index
// prices and FII/DII figures are not repeated here (they live in the status bar and the FII/DII panel).
// ============================================================

export interface RegimeSummaryProps {
  label: string;
  exchange: Exchange;
  state: BiasState;
  /** Institutional-flow sentiment score 0-100 and its label, when known. */
  sentiment: { score: number | null; label: string | null };
  vix: number | null;
  atmIv: number | null;
  breadth: { advances: number; declines: number; advPercent: number } | null;
  now: number;
}

function structureLine(structure: StructureBlock | null): string {
  if (!structure || !structure.enabled) return 'Structure engine: no running setup recorded.';
  const lines = (['BULLISH', 'BEARISH'] as const)
    .map((d) => structure.current?.[d])
    .filter((l): l is NonNullable<typeof l> => !!l)
    .map((l) => `${l.direction === 'BULLISH' ? '▲' : '▼'} ${l.stage}${l.pool ? ` after a ${l.pool.kind} sweep` : ''}`);
  return lines.length ? `Structure engine: ${lines.join('; ')}.` : 'Structure engine: no running setup recorded.';
}

const sentimentWord = (score: number | null) => (score == null ? null : score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral');

export function RegimeSummary({ label, exchange, state, sentiment, vix, atmIv, breadth, now }: RegimeSummaryProps) {
  const { bias, score, structure, assessedAt, origin, meta } = state;
  const f = classifyFreshness({ observedAt: assessedAt, now, sessionOpen: isMarketOpen(exchange, now), transportConnected: state.error ? false : null, freshWithinMs: FRESH_WITHIN_MS.bias });
  const hasRead = origin !== 'NONE';
  const sourceText = origin === 'ENGINE_CACHE' ? `Signal engine result (${meta?.source === 'LAST_KNOWN' ? 'last-known copy' : 'cached'})` : origin === 'LAST_DECISION_RECORD' ? 'Last recorded decision (direction, confidence and regime only)' : 'No assessment recorded';
  const reasons = (bias.reasoning ?? []).filter(Boolean).slice(0, 3);

  return (
    <Section
      title={`Market regime: ${label}`}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <FreshnessBadge state={f.state} detail={f.detail} />
          <span>
            {sourceText}
            {assessedAt ? `, assessed ${formatIstDateTime(assessedAt, now)} (${formatAge(now - assessedAt)})` : ''}
          </span>
        </span>
      }
    >
      {!hasRead ? (
        <p className="text-sm text-[var(--text-secondary)]">No assessment has been recorded for {label} yet, so no regime is shown. Nothing here is a placeholder reading.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <BiasBadge bias={bias.direction} large />
              <div>
                <div className="text-sm font-medium text-[var(--text-primary)]">{bias.regime.replace(/_/g, ' ').toLowerCase()}</div>
                <div className="text-xs text-[var(--text-secondary)]">
                  Engine confidence {formatNumber(bias.confidence, 0)} / 100{origin === 'ENGINE_CACHE' && score.score > 0 ? ` · intelligence score ${formatNumber(score.score, 0)} / 100` : ''}
                </div>
              </div>
            </div>
            <Disclosure summary="What do the confidence and score mean?">
              <p>
                <strong>Confidence</strong> is the signal engine&apos;s own 0 to 100 composite of its inputs (trend, price action, open interest, put-call ratio, volatility and structure). It is not a probability of a profit and it is not a recommendation to trade.
              </p>
              <p>
                <strong>Intelligence score</strong> is a separate 0 to 100 composite used for ordering and description. Neither one gates a paper trade on its own.
              </p>
              {sentiment.score != null && (
                <p>
                  <strong>Institutional sentiment {formatNumber(sentiment.score, 0)}</strong> comes from FII/DII positioning (Institutional Flow): 60 and above reads bullish, 40 and below bearish. It is a different measure from the engine confidence.
                </p>
              )}
            </Disclosure>
          </div>

          <div className="space-y-3">
            <MetricGrid min={150}>
              <MetricTile label="India VIX" value={vix != null ? formatNumber(vix, 2) : MISSING} sub="volatility context" />
              <MetricTile label="ATM IV" value={atmIv != null && atmIv > 0 ? `${atmIv.toFixed(1)}%` : MISSING} sub={`${label} options`} />
              <MetricTile label="PCR" value={typeof bias.inputs.pcr === 'number' ? (bias.inputs.pcr as number).toFixed(2) : MISSING} sub="put-call ratio (OI)" />
              <MetricTile label="Breadth" value={breadth ? `${breadth.advances} / ${breadth.declines}` : MISSING} sub={breadth ? `${breadth.advPercent}% advancing (F&O stocks)` : 'no scan recorded'} />
              <MetricTile label="Institutional sentiment" value={sentiment.score != null ? formatNumber(sentiment.score, 0) : MISSING} sub={sentimentWord(sentiment.score) ?? (sentiment.label ?? 'no reading')} />
            </MetricGrid>
            <div className="space-y-1 text-sm">
              {reasons.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-[var(--text-primary)]">
                  {reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <p className="text-[var(--text-secondary)]">{structureLine(structure)}</p>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
