'use client';

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useMarketStore } from '@/stores';
import { api, ApiError } from '@/lib/api';
import { formatIndianNumber, formatCompact, isMarketOpen } from '@fno/shared';
import type { Exchange, OptionChain, OptionChainLeg, FuturesChainResponse, FuturesData } from '@fno/shared';
import { OIBadge } from '@/components/common/badges';

const STRIKE_RANGE_OPTIONS = [5, 10, 15, 20];
const REFRESH_INTERVAL_MS = 15000;

/**
 * Everything for one asset in one place: spot header, futures snapshot,
 * and the full option chain — this is what a tab in the AssetTabBar opens.
 * Supersedes the old separate Option Chain / Futures sidebar pages.
 */
export function AssetWorkspace() {
  const { selectedSymbol, selectedExchange, selectedExpiry, setSelectedExpiry } = useMarketStore();
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [futures, setFutures] = useState<FuturesChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strikeRange, setStrikeRange] = useState(10);

  const fetchAll = useCallback(
    async (silent = false) => {
      if (!selectedSymbol) return;
      if (!silent) setLoading(true);
      setError(null);

      const [chainResult, futuresResult] = await Promise.allSettled([
        api.getOptionChain(selectedSymbol, {
          exchange: selectedExchange,
          expiry: selectedExpiry || undefined,
          strikeRange,
        }),
        api.getFutures(selectedSymbol, selectedExchange),
      ]);

      if (chainResult.status === 'fulfilled') {
        setChain(chainResult.value);
        if (!selectedExpiry) setSelectedExpiry(chainResult.value.expiry);
      } else if (!silent) {
        setError(chainResult.reason instanceof ApiError ? chainResult.reason.message : 'Failed to load option chain');
      }

      if (futuresResult.status === 'fulfilled') {
        setFutures(futuresResult.value);
      }

      if (!silent) setLoading(false);
    },
    [selectedSymbol, selectedExchange, selectedExpiry, strikeRange, setSelectedExpiry]
  );

  useEffect(() => {
    fetchAll();
    const interval = setInterval(() => fetchAll(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // Live WS tick display is intentionally off — see the note in the git
  // history for this file's predecessor (components/option-chain). REST
  // polling above is the verified-correct data source.
  const strikes = useMemo(() => chain?.strikes ?? [], [chain]);
  const maxOi = useMemo(
    () => Math.max(1, ...strikes.flatMap((s) => [s.call?.oi ?? 0, s.put?.oi ?? 0])),
    [strikes]
  );

  if (!selectedSymbol) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="text-5xl mb-4">📈</div>
        <h2 className="text-xl font-bold text-gray-200 mb-2">No Asset Selected</h2>
        <p className="text-sm text-gray-500 max-w-md">
          Use "+ Add Asset" to pick an index or F&O stock and open its workspace.
        </p>
      </div>
    );
  }

  const spot = chain?.spotPrice ?? futures?.spotPrice;
  const marketOpen = isMarketOpen(selectedExchange as Exchange);

  return (
    <div className="p-4 space-y-4 min-h-full">
      {/* Asset Header */}
      <div className="flex items-center justify-between flex-wrap gap-3 pb-3 border-b border-gray-800/50">
        <div className="flex items-baseline gap-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <h1 className="text-2xl font-bold text-gray-50 tracking-tight">{selectedSymbol}</h1>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-800/70 text-gray-400 border border-gray-700/50">
                {selectedExchange}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-gray-500">
                <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? 'bg-emerald-400' : 'bg-gray-600'}`} />
                {marketOpen ? 'Market Open' : 'Market Closed'}
              </span>
            </div>
            {spot !== undefined && (
              <div className="text-3xl font-bold tabular-nums text-gray-50">{formatIndianNumber(spot, 2)}</div>
            )}
          </div>
          {chain && (
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>DTE <span className="text-gray-300 font-medium">{chain.dte}</span></span>
              <span>Expiry <span className="text-gray-300 font-medium">{chain.expiry}</span></span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">Strikes</span>
          <select
            value={strikeRange}
            onChange={(e) => setStrikeRange(parseInt(e.target.value, 10))}
            className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-emerald-500/40"
          >
            {STRIKE_RANGE_OPTIONS.map((n) => (
              <option key={n} value={n}>±{n}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5 text-red-400 text-xs">
          {error}
        </div>
      )}

      {loading && !chain && !futures && (
        <div className="text-sm text-gray-500 py-16 text-center">Loading workspace…</div>
      )}

      {/* Futures Strip */}
      {futures && futures.contracts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {futures.contracts.map((c) => (
            <FuturesCard key={c.symbol} contract={c} />
          ))}
        </div>
      )}

      {chain && (
        <>
          {/* Expiry Tabs */}
          <div className="flex items-center gap-2 flex-wrap">
            {chain.availableExpiries.map((exp) => (
              <button
                key={exp}
                onClick={() => setSelectedExpiry(exp)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                  exp === chain.expiry
                    ? 'bg-gradient-to-b from-cyan-500/25 to-cyan-500/10 text-cyan-300 border border-cyan-500/40 shadow-[0_2px_8px_-2px_rgba(6,182,212,0.35)]'
                    : 'bg-gray-800/40 text-gray-400 border border-transparent hover:bg-gray-800/70 hover:text-gray-200'
                }`}
              >
                {exp}
              </button>
            ))}
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
          <div className="bg-[#12121a] border border-gray-800/60 rounded-xl overflow-hidden shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)]">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-gray-900/60 text-gray-500 uppercase tracking-wider">
                    <th colSpan={8} className="text-center px-2 py-2 font-medium border-r border-gray-800/50">Calls</th>
                    <th className="text-center px-2 py-2 font-medium">Strike</th>
                    <th colSpan={8} className="text-center px-2 py-2 font-medium border-l border-gray-800/50">Puts</th>
                  </tr>
                  <tr className="bg-gray-900/40 text-gray-500 uppercase tracking-wider">
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
                        className={`border-t border-gray-800/30 hover:bg-gray-800/25 transition-colors ${
                          isAtm ? 'bg-gradient-to-r from-cyan-500/[0.06] via-cyan-500/[0.1] to-cyan-500/[0.06]' : ''
                        }`}
                      >
                        <LegCells leg={s.call} side="call" itm={callItm} maxOi={maxOi} />
                        <td className={`text-center px-2 py-1.5 font-semibold tabular-nums ${
                          isAtm ? 'text-cyan-300' : 'text-gray-200'
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

// --- Futures Card ---

const EXPIRY_LABEL_TEXT: Record<FuturesData['expiryLabel'], string> = {
  current: 'Current Month',
  next: 'Next Month',
  far: 'Far Month',
};

function FuturesCard({ contract }: { contract: FuturesData }) {
  return (
    <div className="bg-[#12121a] border border-gray-800/60 rounded-xl p-4 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] hover:border-gray-700/70 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">{EXPIRY_LABEL_TEXT[contract.expiryLabel]}</span>
        <span className="text-[10px] text-gray-500">DTE {contract.dte}</span>
      </div>
      <div className="text-xl font-bold tabular-nums text-gray-50 mb-1.5">
        {formatIndianNumber(contract.futuresPrice, 2)}
      </div>
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${
          contract.premiumDiscountType === 'PREMIUM' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          {contract.basis >= 0 ? '+' : ''}{contract.basis.toFixed(2)} ({contract.premiumDiscount.toFixed(2)}%)
        </span>
        <OIBadge type={contract.interpretation} />
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px] pt-2 border-t border-gray-800/50">
        <div>
          <div className="text-gray-500 mb-0.5">OI</div>
          <div className="text-gray-300 font-medium tabular-nums">{formatCompact(contract.oi)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Chg OI</div>
          <div className={`font-medium tabular-nums ${contract.changeOi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {contract.changeOi >= 0 ? '+' : ''}{formatCompact(contract.changeOi)}
          </div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Volume</div>
          <div className="text-gray-300 font-medium tabular-nums">{formatCompact(contract.volume)}</div>
        </div>
      </div>
    </div>
  );
}

// --- Option Chain Helpers ---

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
    return <>{cells}</>;
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
    <div className="bg-[#12121a] border border-gray-800/60 rounded-xl p-3 shadow-[0_8px_24px_-16px_rgba(0,0,0,0.6)] hover:border-gray-700/70 transition-colors">
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}
