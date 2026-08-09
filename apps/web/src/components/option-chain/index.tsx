'use client';

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useMarketStore } from '@/stores';
import { api, ApiError } from '@/lib/api';
import { formatIndianNumber, formatCompact } from '@fno/shared';
import type { OptionChain, OptionChainLeg } from '@fno/shared';
import { OIBadge } from '@/components/common/badges';

const STRIKE_RANGE_OPTIONS = [5, 10, 15, 20];
const REFRESH_INTERVAL_MS = 15000;

export function OptionChainPage() {
  const { selectedSymbol, selectedExchange, selectedExpiry, setSelectedExpiry } = useMarketStore();
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strikeRange, setStrikeRange] = useState(10);

  const fetchChain = useCallback(
    async (silent = false) => {
      if (!selectedSymbol) return;
      if (!silent) setLoading(true);
      setError(null);

      try {
        const data = await api.getOptionChain(selectedSymbol, {
          exchange: selectedExchange,
          expiry: selectedExpiry || undefined,
          strikeRange,
        });
        setChain(data);
        if (!selectedExpiry) setSelectedExpiry(data.expiry);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load option chain');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedSymbol, selectedExchange, selectedExpiry, strikeRange, setSelectedExpiry]
  );

  useEffect(() => {
    fetchChain();
    const interval = setInterval(() => fetchChain(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchChain]);

  // NOTE: live WS tick merging is intentionally disabled for now — the
  // server's binary tick parser (Angel One WS v2) has an unverified field
  // layout (likely int32 where the real protocol uses int64) and was
  // confirmed producing garbage values live (negative volume, wrong LTP/OI).
  // REST polling every 15s (above) is verified correct; showing wrong
  // numbers would be worse than not showing "live" ticks. Re-enable once
  // the parser is fixed and verified against real captured packets.
  const strikes = useMemo(() => chain?.strikes ?? [], [chain]);

  const maxOi = useMemo(
    () => Math.max(1, ...strikes.flatMap((s) => [s.call?.oi ?? 0, s.put?.oi ?? 0])),
    [strikes]
  );

  if (!selectedSymbol) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="text-5xl mb-4">⛓️</div>
        <h2 className="text-xl font-bold text-gray-200 mb-2">No Asset Selected</h2>
        <p className="text-sm text-gray-500 max-w-md">
          Use "+ Add Asset" to pick an index or F&O stock and load its live option chain.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-100">{selectedSymbol} Option Chain</h1>
          {chain && (
            <span className="text-sm text-gray-400 tabular-nums">
              Spot: <span className="text-gray-200 font-medium">{formatIndianNumber(chain.spotPrice, 2)}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Strikes</span>
          <select
            value={strikeRange}
            onChange={(e) => setStrikeRange(parseInt(e.target.value, 10))}
            className="bg-gray-800/50 border border-gray-700/50 rounded px-2 py-1 text-xs text-gray-300"
          >
            {STRIKE_RANGE_OPTIONS.map((n) => (
              <option key={n} value={n}>±{n}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 text-red-400 text-xs">
          {error}
        </div>
      )}

      {loading && !chain && (
        <div className="text-sm text-gray-500 py-12 text-center">Loading option chain…</div>
      )}

      {chain && (
        <>
          {/* Expiry Tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            {chain.availableExpiries.map((exp) => (
              <button
                key={exp}
                onClick={() => setSelectedExpiry(exp)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  exp === chain.expiry
                    ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                    : 'bg-gray-800/50 text-gray-400 border border-gray-700/30 hover:bg-gray-800'
                }`}
              >
                {exp}
              </button>
            ))}
            <span className="text-xs text-gray-500 ml-1">DTE: {chain.dte}</span>
          </div>

          {/* Summary Strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile label="PCR (OI)" value={chain.pcrDetail.oiPCR.toFixed(2)}
              accent={chain.pcrDetail.oiPCR > 1 ? 'emerald' : chain.pcrDetail.oiPCR < 0.7 ? 'red' : 'gray'} />
            <SummaryTile label="Max Pain" value={formatIndianNumber(chain.maxPain, 0)}
              sub={`${chain.maxPainDistance >= 0 ? '+' : ''}${chain.maxPainDistance.toFixed(0)} from spot`} />
            <SummaryTile label="Expected Move" value={`±${formatIndianNumber(chain.expectedMove.points, 0)}`}
              sub={`${formatIndianNumber(chain.expectedMove.lowerBound, 0)} – ${formatIndianNumber(chain.expectedMove.upperBound, 0)}`} />
            <SummaryTile label="ATM Strike" value={formatIndianNumber(chain.atmStrike, 0)}
              sub={`Interval ${chain.strikeInterval}`} />
          </div>

          {/* Chain Table */}
          <div className="bg-[#12121a] border border-gray-800/50 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-900/50 text-gray-500 uppercase tracking-wider">
                    <th colSpan={8} className="text-center px-2 py-2 font-medium border-r border-gray-800/50">Calls</th>
                    <th className="text-center px-2 py-2 font-medium">Strike</th>
                    <th colSpan={8} className="text-center px-2 py-2 font-medium border-l border-gray-800/50">Puts</th>
                  </tr>
                  <tr className="bg-gray-900/30 text-gray-500 uppercase tracking-wider">
                    <Th>OI</Th><Th>Chg OI</Th><Th>Vol</Th><Th>IV</Th><Th>Delta</Th><Th>Theta</Th><Th>LTP</Th><Th right border>Activity</Th>
                    <th className="text-center px-2 py-1.5 font-medium">Price</th>
                    <Th left border>Activity</Th><Th>LTP</Th><Th>Theta</Th><Th>Delta</Th><Th>IV</Th><Th>Vol</Th><Th>Chg OI</Th><Th>OI</Th>
                  </tr>
                </thead>
                <tbody>
                  {strikes.map((s) => {
                    const isAtm = s.classification === 'ATM';
                    const callItm = s.strike < chain.spotPrice;
                    const putItm = s.strike > chain.spotPrice;

                    return (
                      <tr
                        key={s.strike}
                        className={`border-t border-gray-800/30 hover:bg-gray-800/20 ${isAtm ? 'bg-cyan-500/5' : ''}`}
                      >
                        <LegCells leg={s.call} side="call" itm={callItm} maxOi={maxOi} />
                        <td className={`text-center px-2 py-1.5 font-semibold tabular-nums ${
                          isAtm ? 'text-cyan-400' : 'text-gray-200'
                        }`}>
                          {formatIndianNumber(s.strike, 0)}
                        </td>
                        <LegCells leg={s.put} side="put" itm={putItm} maxOi={maxOi} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --- Helpers ---

function LegCells({
  leg,
  side,
  itm,
  maxOi,
}: {
  leg: OptionChainLeg | null;
  side: 'call' | 'put';
  itm: boolean;
  maxOi: number;
}) {
  const bg = itm ? (side === 'call' ? 'bg-emerald-500/[0.03]' : 'bg-red-500/[0.03]') : '';

  if (!leg) {
    const cells = Array.from({ length: 8 }, (_, i) => <td key={i} className={`px-2 py-1.5 ${bg}`}>—</td>);
    return side === 'call' ? <>{cells}</> : <>{cells}</>;
  }

  const oiBar = Math.max(2, (leg.oi / maxOi) * 100);
  const ivCalculated = leg.greeksSource === 'CALCULATED';

  const oiCell = (
    <td className={`text-right px-2 py-1.5 tabular-nums text-gray-300 ${bg}`}>
      <div className="flex items-center justify-end gap-1.5">
        <div className="w-8 h-1 bg-gray-800 rounded-full overflow-hidden hidden md:block">
          <div className="h-full bg-gray-600 rounded-full" style={{ width: `${oiBar}%` }} />
        </div>
        {formatCompact(leg.oi)}
      </div>
    </td>
  );
  const changeOiCell = (
    <td className={`text-right px-2 py-1.5 tabular-nums ${bg} ${leg.changeOi > 0 ? 'text-emerald-400' : leg.changeOi < 0 ? 'text-red-400' : 'text-gray-400'}`}>
      {leg.changeOi > 0 ? '+' : ''}{formatCompact(leg.changeOi)}
    </td>
  );
  const volCell = <td className={`text-right px-2 py-1.5 tabular-nums text-gray-400 ${bg}`}>{formatCompact(leg.volume)}</td>;
  const ivCell = (
    <td
      className={`text-right px-2 py-1.5 tabular-nums ${bg} ${ivCalculated ? 'text-amber-400' : 'text-gray-300'}`}
      title={ivCalculated ? 'Calculated internally — broker Greeks unavailable for this leg' : 'Broker-provided'}
    >
      {leg.iv.toFixed(1)}%{ivCalculated && <sup>~</sup>}
    </td>
  );
  const deltaCell = <td className={`text-right px-2 py-1.5 tabular-nums text-gray-400 ${bg}`}>{leg.delta.toFixed(2)}</td>;
  const thetaCell = <td className={`text-right px-2 py-1.5 tabular-nums text-gray-500 ${bg}`}>{leg.theta.toFixed(2)}</td>;
  const ltpCell = <td className={`text-right px-2 py-1.5 tabular-nums font-medium text-gray-200 ${bg}`}>{leg.ltp.toFixed(2)}</td>;
  const activityCell = (
    <td className={`px-2 py-1.5 ${bg} ${side === 'call' ? 'text-right border-r border-gray-800/50' : 'text-left border-l border-gray-800/50'}`}>
      <OIBadge type={leg.oiInterpretation} />
    </td>
  );

  return side === 'call'
    ? <>{oiCell}{changeOiCell}{volCell}{ivCell}{deltaCell}{thetaCell}{ltpCell}{activityCell}</>
    : <>{activityCell}{ltpCell}{thetaCell}{deltaCell}{ivCell}{volCell}{changeOiCell}{oiCell}</>;
}

function Th({ children, right, left, border }: { children: React.ReactNode; right?: boolean; left?: boolean; border?: boolean }) {
  return (
    <th className={`px-2 py-1.5 font-medium ${right ? 'text-right' : left ? 'text-left' : 'text-right'} ${
      border ? (right ? 'border-r border-gray-800/50' : 'border-l border-gray-800/50') : ''
    }`}>
      {children}
    </th>
  );
}

function SummaryTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'emerald' | 'red' | 'gray' }) {
  const color = accent === 'emerald' ? 'text-emerald-400' : accent === 'red' ? 'text-red-400' : 'text-gray-200';
  return (
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-3">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}
