'use client';

import React, { useMemo, useState } from 'react';
import { formatIndianNumber, formatCompact } from '@fno/shared';
import type { Exchange, MarketQuote } from '@fno/shared';
import { InstrumentChart } from '../instrument-chart';
import { buildChartOverlays, visibleOverlayLines, type OverlayGroup } from '@/lib/chart-overlays';
import type { BiasState } from '@/lib/use-market-bias';
import { formatArrowPercent, formatNumber, MISSING } from '@/lib/format';
import { Section } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/controls';
import { StatusBadge } from '@/components/ui/status-badge';

// ============================================================
// SECTION E — MAIN CHART WITH A LEGEND
// ============================================================
// Overlays are toggled per group, each with a legend entry. A group whose data is not recorded is listed as NOT AVAILABLE
// with the reason (order-block zones and order-flow delta / POC / VAH / VAL are not exposed to the chart), never drawn
// from a guess. Order-flow data would be INFERRED aggressor side, not exchange delta, and is labelled so.
// ============================================================

export interface InstrumentOption {
  symbol: string;
  exchange: Exchange;
  label: string;
  /** MCX commodities (CRUDEOIL, GOLD) have no cash/spot instrument at all — futures/options only. */
  hasSpot: boolean;
}

export const INSTRUMENTS: InstrumentOption[] = [
  { symbol: 'NIFTY', exchange: 'NSE', label: 'NIFTY', hasSpot: true },
  { symbol: 'BANKNIFTY', exchange: 'NSE', label: 'BANK NIFTY', hasSpot: true },
  { symbol: 'FINNIFTY', exchange: 'NSE', label: 'FIN NIFTY', hasSpot: true },
  { symbol: 'SENSEX', exchange: 'BSE', label: 'SENSEX', hasSpot: true },
  { symbol: 'CRUDEOIL', exchange: 'MCX', label: 'CRUDEOIL', hasSpot: false },
  { symbol: 'GOLD', exchange: 'MCX', label: 'GOLD', hasSpot: false },
];

const TONE_SWATCH: Record<string, string> = {
  OI_LEVELS: 'bg-[var(--status-ok)]',
  VWAP: 'bg-cyan-400',
  LIQUIDITY: 'bg-violet-400',
  STRUCTURE_ZONE: 'bg-[var(--status-warn)]',
  SETUP_LEVELS: 'bg-indigo-300',
  PAPER_TRADE: 'bg-indigo-400',
};

export function ChartSection({
  instrumentIdx,
  onInstrument,
  quote,
  state,
  orderFlowStatus,
}: {
  instrumentIdx: number;
  onInstrument: (i: number) => void;
  quote: MarketQuote | null;
  state: BiasState;
  orderFlowStatus: string | null;
}) {
  const instrument = INSTRUMENTS[instrumentIdx];
  const { lines, groups } = useMemo(() => buildChartOverlays({ inputs: state.bias.inputs, structure: state.structure, setupWatch: state.setupWatch, orderFlowStatus }), [state.bias.inputs, state.structure, state.setupWatch, orderFlowStatus]);
  const [off, setOff] = useState<Set<OverlayGroup>>(new Set());
  const [touched, setTouched] = useState(false);
  // Defaults: the groups marked defaultOn that have data; once the user toggles anything their choice stands.
  const enabled = useMemo(() => new Set<OverlayGroup>(groups.filter((g) => g.available && (touched ? !off.has(g.group) : g.defaultOn)).map((g) => g.group)), [groups, off, touched]);
  const overlayLines = useMemo(() => visibleOverlayLines(lines, enabled), [lines, enabled]);
  const toggle = (g: OverlayGroup) => {
    setTouched(true);
    setOff((prev) => {
      const next = touched ? new Set(prev) : new Set(groups.filter((x) => !x.defaultOn).map((x) => x.group));
      if (enabled.has(g)) next.add(g);
      else next.delete(g);
      return next;
    });
  };
  const price = quote?.ltp ?? (typeof state.bias.inputs.spotPrice === 'number' ? (state.bias.inputs.spotPrice as number) : null);
  const unavailable = groups.filter((g) => !g.available);

  return (
    <Section
      title={`${instrument.label} chart`}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold tabular-nums text-[var(--text-primary)]">{price != null ? formatIndianNumber(price, 2) : MISSING}</span>
          {quote && <span className={quote.change >= 0 ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}>{formatArrowPercent(quote.changePercent)}</span>}
          <span>Vol {quote && quote.volume > 0 ? formatCompact(quote.volume) : MISSING}</span>
          <span>VWAP {typeof state.bias.inputs.vwap === 'number' ? formatNumber(state.bias.inputs.vwap as number, 0) : MISSING}</span>
        </span>
      }
      actions={<SegmentedControl label="Instrument" value={String(instrumentIdx)} onChange={(v) => onInstrument(Number(v))} options={INSTRUMENTS.map((inst, i) => ({ id: String(i), label: inst.label }))} />}
    >
      <InstrumentChart symbol={instrument.symbol} exchange={instrument.exchange} hasSpot={instrument.hasSpot} overlayLines={overlayLines} />

      <div className="mt-3 border-t border-[var(--border-primary)] pt-3">
        <div role="group" aria-label="Chart overlays" className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-secondary)]">Overlays:</span>
          {groups
            .filter((g) => g.available)
            .map((g) => {
              const on = enabled.has(g.group);
              return (
                <button
                  key={g.group}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(g.group)}
                  title={`${g.label}: ${g.count} line${g.count === 1 ? '' : 's'}`}
                  className={`inline-flex min-h-8 items-center gap-2 rounded-md border px-2.5 py-1 text-sm ${on ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo)]/15 text-[var(--text-primary)]' : 'border-[var(--border-secondary)] text-[var(--text-secondary)]'}`}
                >
                  <span aria-hidden="true" className={`h-2 w-4 rounded-sm ${TONE_SWATCH[g.group] ?? 'bg-gray-400'}`} />
                  {g.label} <span className="text-xs text-[var(--text-secondary)]">({g.count})</span>
                </button>
              );
            })}
          {groups.every((g) => !g.available) && <span className="text-sm text-[var(--text-secondary)]">No overlay data recorded for {instrument.label}.</span>}
        </div>
        {unavailable.length > 0 && (
          <details className="mt-2 text-sm text-[var(--text-secondary)]">
            <summary className="cursor-pointer">Not available on this chart ({unavailable.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {unavailable.map((g) => (
                <li key={g.group} className="flex flex-wrap items-start gap-2">
                  <StatusBadge tone="off" label="NOT AVAILABLE" />
                  <span>
                    <strong className="text-[var(--text-primary)]">{g.label}</strong>: {g.reason}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Section>
  );
}
