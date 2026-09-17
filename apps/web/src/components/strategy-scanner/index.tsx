'use client';

import React, { useMemo, useState } from 'react';
import { useFnoScanner } from '@/lib/use-fno-scanner';
import { useStrategyTrackRecord } from '@/lib/use-strategy-track-record';
import { useAssetTabsStore } from '@/stores';
import { recommendStrategy, STRATEGY_MIN_CONFIDENCE, type StrategyCategory } from '@/lib/strategy-recommender';
import { formatIndianNumber, formatPercent } from '@fno/shared';
import type { FnoScannerRow, BiasDirection, StrategyTrackRecord } from '@fno/shared';
import { BiasBadge, ScoreBadge } from '@/components/common/badges';
import { FilterPills } from '@/components/common/filter-pills';
import { SkeletonTableRow } from '@/components/common/skeleton';

interface Row {
  row: FnoScannerRow;
  strategy: string;
  category: StrategyCategory;
  riskProfile: 'DEFINED_RISK';
  rationale: string;
}

type SortKey = 'symbol' | 'price' | 'changePercent' | 'score' | 'confidence' | 'ivRank';
type BiasFilter = 'ALL' | BiasDirection;
const BIAS_OPTIONS: Array<{ value: BiasFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'BULLISH', label: 'Bullish' },
  { value: 'BEARISH', label: 'Bearish' },
];

export function StrategyScannerPage() {
  const { rows, isLive, loading } = useFnoScanner('NSE');
  const { record: trackRecord, loading: trackLoading } = useStrategyTrackRecord();
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [query, setQuery] = useState('');
  const [biasFilter, setBiasFilter] = useState<BiasFilter>('ALL');
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [sortDesc, setSortDesc] = useState(true);

  const withStrategy = useMemo<Row[]>(() => {
    return rows
      .map((row) => {
        const rec = recommendStrategy(row);
        if (!rec) return null;
        return { row, ...rec };
      })
      .filter((r): r is Row => r !== null);
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    let base = q ? withStrategy.filter((r) => r.row.symbol.includes(q)) : withStrategy;
    if (biasFilter !== 'ALL') base = base.filter((r) => r.row.direction === biasFilter);
    const sorted = [...base].sort((a, b) => {
      const pick = (r: Row) =>
        sortKey === 'symbol' ? r.row.symbol : sortKey === 'price' ? r.row.price : sortKey === 'changePercent' ? r.row.changePercent : sortKey === 'ivRank' ? r.row.ivRank : sortKey === 'confidence' ? r.row.confidence : r.row.score;
      const av = pick(a);
      const bv = pick(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv));
      return (av as number) - (bv as number);
    });
    if (sortDesc) sorted.reverse();
    return sorted;
  }, [withStrategy, query, biasFilter, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Strategy Scanner</h1>
          <p className="text-xs text-gray-400 light:text-slate-600 mt-0.5">
            An option-buying structure for NSE F&O stocks with a clear lean (confidence {STRATEGY_MIN_CONFIDENCE}+) — matched
            from direction, IV Rank and ATM theta. Neutral or mixed stocks are left out. A heuristic — the track record
            below grades every day's calls against the next session.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span role="status" aria-live="polite" className="flex items-center gap-1.5 text-[11px] text-gray-400 light:text-slate-600">
            <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
            {isLive ? `${filtered.length} of ${withStrategy.length} setups` : loading ? 'Loading…' : 'Unreachable'}
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter symbol…"
            className="bg-gray-900/70 light:bg-slate-50 border border-gray-700/60 light:border-slate-200 rounded-lg px-3 py-1.5 text-xs text-gray-200 light:text-slate-800 placeholder-gray-600 light:placeholder-slate-400 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors w-40"
          />
        </div>
      </div>

      <TrackRecordStrip record={trackRecord} loading={trackLoading} />

      <div className="flex items-center flex-wrap gap-4">
        <FilterPills label="Bias" options={BIAS_OPTIONS} value={biasFilter} onChange={setBiasFilter} />
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Live scanner unreachable — showing nothing right now. It'll pick back up on the next successful poll.
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)] p-1">
          <table className="w-full text-xs">
            <tbody>
              {Array.from({ length: 8 }, (_, i) => (
                <SkeletonTableRow key={i} cols={9} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {withStrategy.length > 0 && filtered.length === 0 && (
        <div className="text-sm text-gray-400 light:text-slate-600 py-16 text-center">No setups match the current filters.</div>
      )}

      {filtered.length > 0 && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)]">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gradient-to-b from-gray-900/90 to-gray-900/60 light:from-slate-100 light:to-slate-50 text-gray-400 light:text-slate-600 uppercase tracking-wider">
                  <SortTh label="Stock" active={sortKey === 'symbol'} desc={sortDesc} onClick={() => toggleSort('symbol')} align="left" />
                  <SortTh label="Price" active={sortKey === 'price'} desc={sortDesc} onClick={() => toggleSort('price')} />
                  <SortTh label="Chg%" active={sortKey === 'changePercent'} desc={sortDesc} onClick={() => toggleSort('changePercent')} />
                  <th className="text-center px-3 py-2 font-medium">Bias</th>
                  <SortTh label="Conf" active={sortKey === 'confidence'} desc={sortDesc} onClick={() => toggleSort('confidence')} />
                  <SortTh label="Score" active={sortKey === 'score'} desc={sortDesc} onClick={() => toggleSort('score')} align="center" />
                  <SortTh label="IV Rank" active={sortKey === 'ivRank'} desc={sortDesc} onClick={() => toggleSort('ivRank')} />
                  <th className="text-left px-3 py-2 pl-6 font-medium">Strategy</th>
                  <th className="text-left px-3 py-2 font-medium">Rationale</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ row, strategy, rationale }) => (
                  <tr
                    key={row.symbol}
                    onClick={() => openTab(row.symbol, row.exchange)}
                    className="border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors align-top"
                  >
                    <td className="px-4 py-2.5 font-semibold text-gray-200 light:text-slate-800 whitespace-nowrap">{row.symbol}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-200 light:text-slate-800 whitespace-nowrap">{formatIndianNumber(row.price, 2)}</td>
                    <td className={`text-right px-3 py-2.5 tabular-nums font-medium whitespace-nowrap ${row.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {formatPercent(row.changePercent)}
                    </td>
                    <td className="text-center px-3 py-2.5">
                      <BiasBadge bias={row.direction} />
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-300 light:text-slate-700 whitespace-nowrap">{row.confidence}</td>
                    <td className="text-center px-3 py-2.5">
                      <ScoreBadge score={row.score} />
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-400 light:text-slate-600 whitespace-nowrap">
                      {row.ivRank != null ? row.ivRank : '—'}
                    </td>
                    <td className="px-3 py-2.5 pl-6 whitespace-nowrap">
                      <div className="font-semibold text-gray-200 light:text-slate-800">{strategy}</div>
                      <div className="text-[10px] mt-0.5 text-cyan-400 light:text-cyan-700">
                        Defined risk · Option buying
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 light:text-slate-600 leading-snug max-w-md">{rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {withStrategy.length > 0 && (
        <p className="text-[10px] text-gray-400 light:text-slate-600 leading-snug">
          Strategy shapes are matched from bias direction, score, IV Rank, and ATM theta only — the same lightweight
          signals as the other universe scanners, no historical technicals or ADX (that needs per-symbol historical
          candles, which is why it's reserved for the full Market Regime read on a single asset's tab). This isn't
          strike selection or a real risk/reward number — open a stock's option chain to size an actual trade.
        </p>
      )}
    </div>
  );
}

// Grades the direction call only: the underlying's move from one session's
// 14:45 snapshot to the next. Option P&L also depends on strike, IV and
// decay, so a positive average move is necessary, not sufficient.
const TRACK_MIN_GRADED = 20;

function TrackRecordStrip({ record, loading }: { record: StrategyTrackRecord | null; loading: boolean }) {
  const shell = 'rounded-xl border border-gray-800/60 light:border-slate-200 bg-gray-900/40 light:bg-slate-50 px-4 py-3 text-xs';
  if (!record) {
    return <div className={`${shell} text-gray-400 light:text-slate-600`}>{loading ? 'Loading track record…' : 'Track record unavailable right now.'}</div>;
  }
  if (record.graded < TRACK_MIN_GRADED) {
    return (
      <div className={`${shell} text-gray-400 light:text-slate-600`}>
        <span className="font-semibold text-gray-200 light:text-slate-800">Track record: building.</span>{' '}
        Recommendations are snapshotted at {record.snapshotTime} each session and graded at the next one — {record.graded} graded,{' '}
        {record.pending} pending{record.since ? ` since ${record.since}` : ''}. Treat the calls below as unproven until at least {TRACK_MIN_GRADED} are graded.
      </div>
    );
  }
  const good = (record.avgSignedMovePercent ?? 0) > 0 && (record.directionHitPercent ?? 0) > 50;
  return (
    <div className={shell}>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <span className="font-semibold text-gray-200 light:text-slate-800">Track record</span>
        <span className="tabular-nums text-gray-300 light:text-slate-700">
          Direction right <b className={good ? 'text-emerald-400 light:text-emerald-700' : 'text-amber-400 light:text-amber-700'}>{record.directionHitPercent}%</b> of {record.graded}
        </span>
        <span className="tabular-nums text-gray-300 light:text-slate-700">
          Avg move the called way <b>{(record.avgSignedMovePercent ?? 0) >= 0 ? '+' : ''}{record.avgSignedMovePercent?.toFixed(2)}%</b> by the next session
        </span>
        <span className="text-gray-400 light:text-slate-600">{record.snapshots} sessions since {record.since}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-gray-400 light:text-slate-600 tabular-nums">
        {record.byConfidence.filter((b) => b.graded > 0).map((b) => (
          <span key={b.label}>Conf {b.label}: {b.directionHitPercent}% · {(b.avgSignedMovePercent ?? 0) >= 0 ? '+' : ''}{b.avgSignedMovePercent?.toFixed(2)}% (n{b.graded})</span>
        ))}
        {record.byStrategy.filter((b) => b.graded > 0).map((b) => (
          <span key={b.label}>{b.label}: {b.directionHitPercent}% (n{b.graded})</span>
        ))}
      </div>
    </div>
  );
}

function SortTh({
  label,
  active,
  desc,
  onClick,
  align = 'right',
}: {
  label: string;
  active: boolean;
  desc: boolean;
  onClick: () => void;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      onClick={onClick}
      className={`px-3 py-2 font-medium cursor-pointer select-none hover:text-gray-300 light:hover:text-slate-700 transition-colors whitespace-nowrap ${
        align === 'left' ? 'text-left' : align === 'center' ? 'text-center' : 'text-right'
      } ${active ? 'text-emerald-400' : ''}`}
    >
      {label}
      {active && <span className="ml-0.5">{desc ? '▾' : '▴'}</span>}
    </th>
  );
}
