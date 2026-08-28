'use client';

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useMarketStore } from '@/stores';
import { api, ApiError } from '@/lib/api';
import { useMarketBias } from '@/lib/use-market-bias';
import { useCorporateActionsForSymbol } from '@/lib/use-corporate-actions';
import { formatIndianNumber, formatCompact, isMarketOpen } from '@fno/shared';
import type {
  Exchange,
  OptionChain,
  OptionChainLeg,
  FuturesChainResponse,
  FuturesData,
  PositionMomentum,
  OiTrapAnalysis,
  DecayAnalysis,
  TradeSetup,
} from '@fno/shared';
import { OIBadge } from '@/components/common/badges';
import { MarketBiasCard, MarketRegimeCard, IntelligenceScoreCard } from '@/components/common/market-intelligence-cards';
import { NewsPanel } from '@/components/common/news-panel';
import { EventCalendarPanel } from '@/components/common/event-calendar-panel';
import { PayoffDiagram } from '@/components/common/payoff-diagram';

const STRIKE_RANGE_OPTIONS = [5, 10, 15, 20];
const REFRESH_INTERVAL_MS = 15000;

// Module-level (survives across switches — AssetWorkspace is one persistent
// instance reused for every tab, not remounted per tab) so switching BACK
// to an already-visited symbol shows its last-known chain/futures instantly
// instead of blanking to "Loading workspace…" every single time, even for
// a tab the user was just on seconds ago. A background refresh still runs
// (see fetchAll), this only avoids the visible flash while it does.
interface CachedWorkspaceData {
  chain: OptionChain | null;
  futures: FuturesChainResponse | null;
}
const workspaceCache = new Map<string, CachedWorkspaceData>();
function workspaceCacheKey(exchange: string, symbol: string): string {
  return `${exchange}:${symbol}`;
}

/**
 * Everything for one asset in one place: spot header, futures snapshot,
 * and the full option chain — this is what a tab in the AssetTabBar opens.
 * Supersedes the old separate Option Chain / Futures sidebar pages.
 */
export function AssetWorkspace() {
  const { selectedSymbol, selectedExchange, selectedExpiry, setSelectedExpiry } = useMarketStore();
  const [biasMode, setBiasMode] = useState<'INTRADAY' | 'POSITIONAL'>('INTRADAY');
  // Hooks can't be called conditionally, so this runs even before the
  // "no asset selected" early return below — harmless, just polls NIFTY
  // until an asset is actually picked.
  const { bias, score, tradeSetup, isLive: biasLive } = useMarketBias(selectedSymbol || 'NIFTY', selectedExchange || 'NSE', biasMode);
  const { actions: corporateActions } = useCorporateActionsForSymbol(selectedSymbol || 'NIFTY', selectedExchange || 'NSE');
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [futures, setFutures] = useState<FuturesChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strikeRange, setStrikeRange] = useState(10);

  const fetchAll = useCallback(
    async (silent = false) => {
      if (!selectedSymbol) return;
      const requestSymbol = selectedSymbol;
      const requestExchange = selectedExchange;
      const requestKey = workspaceCacheKey(requestExchange, requestSymbol);
      if (!silent) setLoading(true);
      setError(null);

      const [chainResult, futuresResult] = await Promise.allSettled([
        api.getOptionChain(requestSymbol, {
          exchange: requestExchange,
          expiry: selectedExpiry || undefined,
          strikeRange,
        }),
        api.getFutures(requestSymbol, requestExchange),
      ]);

      // Cache whatever came back under the REQUESTED symbol's key regardless
      // of whether the user has since switched away — a failed leg keeps
      // whatever was cached before rather than overwriting it with null, so
      // one bad background poll can't evict otherwise-good cached data.
      const prevCached = workspaceCache.get(requestKey);
      workspaceCache.set(requestKey, {
        chain: chainResult.status === 'fulfilled' ? chainResult.value : prevCached?.chain ?? null,
        futures: futuresResult.status === 'fulfilled' ? futuresResult.value : prevCached?.futures ?? null,
      });

      // The user may have switched tabs while this request was in flight —
      // a late response for the asset they left must not overwrite what's
      // now on screen for the asset they switched to.
      const current = useMarketStore.getState();
      if (current.selectedSymbol !== requestSymbol || current.selectedExchange !== requestExchange) {
        return;
      }

      if (chainResult.status === 'fulfilled') {
        setChain(chainResult.value);
        if (!selectedExpiry) setSelectedExpiry(chainResult.value.expiry);
      } else {
        setChain(null);
        if (!silent) setError(chainResult.reason instanceof ApiError ? chainResult.reason.message : 'Failed to load option chain');
      }

      if (futuresResult.status === 'fulfilled') {
        setFutures(futuresResult.value);
      } else {
        setFutures(null);
      }

      if (!silent) setLoading(false);
    },
    [selectedSymbol, selectedExchange, selectedExpiry, strikeRange, setSelectedExpiry]
  );

  // On switch, restore this symbol's last-known data from cache instead of
  // blanking to null — a revisit shows instantly rather than flashing
  // "Loading workspace…" every time. A genuinely new-to-this-session symbol
  // still has nothing cached, so it falls back to the original blank state.
  useEffect(() => {
    const key = selectedSymbol ? workspaceCacheKey(selectedExchange, selectedSymbol) : null;
    const cached = key ? workspaceCache.get(key) : undefined;
    setChain(cached?.chain ?? null);
    setFutures(cached?.futures ?? null);
    setError(null);
  }, [selectedSymbol, selectedExchange]);

  useEffect(() => {
    const key = selectedSymbol ? workspaceCacheKey(selectedExchange, selectedSymbol) : null;
    // Cache hit → refresh quietly in the background (good data is already on
    // screen); cache miss → behave exactly as before (visible loading state).
    fetchAll(!!(key && workspaceCache.has(key)));
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
        <h2 className="text-xl font-bold text-gray-200 light:text-slate-800 mb-2">No Asset Selected</h2>
        <p className="text-sm text-gray-500 light:text-slate-500 max-w-md">
          Use "+ Add Asset" to pick an index or F&O stock and open its workspace.
        </p>
      </div>
    );
  }

  const spot = chain?.spotPrice ?? futures?.spotPrice;
  const marketOpen = isMarketOpen(selectedExchange as Exchange);

  return (
    <div className="p-4 space-y-4 min-h-full animate-fade-in">
      {/* Asset Header */}
      <div className="relative overflow-hidden flex items-center justify-between flex-wrap gap-3 px-5 py-4 rounded-2xl bg-gradient-to-br from-[#161624] via-[#12121c] to-[#0d0d14] light:from-white light:via-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 shadow-[0_12px_40px_-18px_rgba(0,0,0,0.8)] light:shadow-[0_4px_20px_-10px_rgba(0,0,0,0.12)]">
        <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/[0.04] via-transparent to-cyan-500/[0.04] pointer-events-none" />
        <div className="relative flex items-baseline gap-5">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-2xl font-bold text-gray-50 light:text-slate-900 tracking-tight">{selectedSymbol}</h1>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-800/70 light:bg-slate-100 text-gray-400 light:text-slate-500 border border-gray-700/50 light:border-slate-200">
                {selectedExchange}
              </span>
              <span className="flex items-center gap-1.5 text-[10px] text-gray-500 light:text-slate-500 bg-gray-900/50 light:bg-slate-100 rounded-full px-2 py-0.5">
                <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)] animate-pulse' : 'bg-gray-600 light:bg-slate-400'}`} />
                {marketOpen ? 'Market Open' : 'Market Closed'}
              </span>
            </div>
            {spot !== undefined && (
              <div className="text-4xl font-bold tabular-nums text-gray-50 light:text-slate-900 tracking-tight">{formatIndianNumber(spot, 2)}</div>
            )}
          </div>
          {chain && (
            <div className="flex items-center gap-4 text-xs text-gray-500 light:text-slate-500">
              <span>DTE <span className="text-gray-200 light:text-slate-800 font-semibold">{chain.dte}</span></span>
              <span>Expiry <span className="text-gray-200 light:text-slate-800 font-semibold">{chain.expiry}</span></span>
            </div>
          )}
        </div>
        <div className="relative flex items-center gap-2">
          <span className="text-xs text-gray-500 light:text-slate-500">Strikes</span>
          <select
            value={strikeRange}
            onChange={(e) => setStrikeRange(parseInt(e.target.value, 10))}
            className="bg-gray-900/70 light:bg-white border border-gray-700/60 light:border-slate-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-200 light:text-slate-800 font-medium focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors"
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
        <div className="text-sm text-gray-500 light:text-slate-500 py-16 text-center">Loading workspace…</div>
      )}

      {/* Market Intelligence */}
      <div>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <SectionLabel icon="🧠">Market Intelligence</SectionLabel>
          </div>
          <div className="flex items-center gap-0.5 bg-gray-800/60 light:bg-slate-200/60 rounded-lg p-0.5 shrink-0" role="group" aria-label="Trading mode">
            {(['INTRADAY', 'POSITIONAL'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setBiasMode(m)}
                title={m === 'INTRADAY' ? '15m/1H candles, 30% SL — tuned for same-session moves' : '1H/Daily candles, wider SL — tuned for a multi-day/week hold'}
                className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide transition-colors ${
                  biasMode === m
                    ? 'bg-emerald-500/90 text-white'
                    : 'text-gray-400 light:text-slate-500 hover:text-gray-200 light:hover:text-slate-700'
                }`}
              >
                {m === 'INTRADAY' ? 'Intraday' : 'Positional'}
              </button>
            ))}
          </div>
        </div>
        {!biasLive && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2 mb-2 text-amber-400 text-xs font-medium">
            ⚠️ Live signal engine unreachable — bias/regime/score below are sample data.
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <MarketBiasCard bias={bias} symbol={selectedSymbol} />
          <MarketRegimeCard bias={bias} />
          <IntelligenceScoreCard score={score} symbol={selectedSymbol} />
        </div>
      </div>

      {/* Main content (left) + News sidebar (right) — News used to be a
          full-width section in the main stack, which pushed the option
          chain table further down the page on every symbol. As a sticky
          sidebar it stays visible alongside the rest without disturbing
          that flow. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          {/* Option Chain Intelligence */}
          {chain && (
            <div>
              <SectionLabel icon="🔬">Option Chain Intelligence</SectionLabel>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <OiTrapCard trap={chain.oiTrap} />
                <PositionMomentumCard momentum={chain.positionMomentum} />
                <DecayCard decay={chain.decay} />
                <TradeSetupCard setup={tradeSetup} />
              </div>
            </div>
          )}

          {/* Payoff Diagram — P&L at expiry for the current Trade Setup, with
              expected move / max pain / OI walls overlaid, so the risk/reward
              shown in TradeSetupCard can actually be seen against the likely
              price range instead of read as bare numbers. */}
          {chain && tradeSetup.available && (
            <PayoffDiagram setup={tradeSetup} chain={chain} />
          )}

          {/* Futures Strip */}
          {futures && futures.contracts.length > 0 && (
            <div>
              <SectionLabel icon="📅">Futures</SectionLabel>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {futures.contracts.map((c) => (
                  <FuturesCard key={c.symbol} contract={c} />
                ))}
              </div>
            </div>
          )}

          {chain && (
            <div className="space-y-3">
              <SectionLabel icon="⛓️">Option Chain</SectionLabel>
              {/* Expiry Tabs */}
              <div className="flex items-center gap-2 flex-wrap">
                {chain.availableExpiries.map((exp) => (
                  <button
                    key={exp}
                    onClick={() => setSelectedExpiry(exp)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all duration-150 ${
                      exp === chain.expiry
                        ? 'bg-gradient-to-b from-cyan-500/25 to-cyan-500/10 light:from-cyan-500/15 light:to-cyan-500/10 text-cyan-300 light:text-cyan-700 border border-cyan-500/40 shadow-[0_2px_8px_-2px_rgba(6,182,212,0.35)]'
                        : 'bg-gray-800/40 light:bg-slate-100 text-gray-400 light:text-slate-500 border border-transparent hover:bg-gray-800/70 light:hover:bg-slate-200 hover:text-gray-200 light:hover:text-slate-800'
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
              <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl overflow-hidden shadow-[0_12px_36px_-16px_rgba(0,0,0,0.8)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)]">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-gradient-to-b from-gray-900/90 to-gray-900/60 light:from-slate-100 light:to-slate-100 text-gray-400 light:text-slate-500 uppercase tracking-wider">
                        <th colSpan={8} className="text-center px-2 py-2 font-bold text-emerald-400/90 light:text-emerald-700 border-r border-gray-800/60 light:border-slate-200">Calls</th>
                        <th className="text-center px-2 py-2 font-medium">Strike</th>
                        <th colSpan={8} className="text-center px-2 py-2 font-bold text-red-400/90 light:text-red-700 border-l border-gray-800/60 light:border-slate-200">Puts</th>
                      </tr>
                      <tr className="bg-gray-900/50 light:bg-slate-100 text-gray-500 light:text-slate-500 uppercase tracking-wider">
                        <Th>OI</Th><Th>Chg OI</Th><Th>Vol</Th><Th>IV</Th><Th>Delta</Th><Th>Theta</Th><Th>LTP</Th><Th right border>Activity</Th>
                        <th className="text-center px-2 py-1.5 font-medium">Price</th>
                        <Th left border>Activity</Th><Th>LTP</Th><Th>Theta</Th><Th>Delta</Th><Th>IV</Th><Th>Vol</Th><Th>Chg OI</Th><Th>OI</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {strikes.map((s) => {
                        const isAtm = s.strike === chain.atmStrike;
                        const callItm = s.strike < chain.spotPrice;
                        const putItm = s.strike > chain.spotPrice;

                        return (
                          <tr
                            key={s.strike}
                            className={`border-t border-gray-800/40 light:border-slate-200 hover:bg-gray-800/30 light:hover:bg-slate-100 transition-colors ${
                              isAtm ? 'bg-gradient-to-r from-cyan-500/[0.08] via-cyan-500/[0.14] to-cyan-500/[0.08] shadow-[inset_0_1px_0_rgba(6,182,212,0.25),inset_0_-1px_0_rgba(6,182,212,0.25)] animate-border-glow' : ''
                            }`}
                          >
                            <LegCells leg={s.call} side="call" itm={callItm} maxOi={maxOi} />
                            <td className="text-center px-2 py-1.5">
                              <span className={`inline-block px-2 py-0.5 rounded-md font-bold tabular-nums ${
                                isAtm ? 'bg-cyan-500/20 light:bg-cyan-500/15 text-cyan-300 light:text-cyan-700 shadow-[0_0_10px_-2px_rgba(6,182,212,0.6)] light:shadow-none' : 'text-gray-200 light:text-slate-800'
                              }`}>
                                {formatIndianNumber(s.strike, 0)}
                              </span>
                            </td>
                            <LegCells leg={s.put} side="put" itm={putItm} maxOi={maxOi} />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="xl:sticky xl:top-4 space-y-4">
          <div>
            <SectionLabel icon="📰">News</SectionLabel>
            <NewsPanel symbol={selectedSymbol} />
          </div>
          <div>
            <SectionLabel icon="📅">Event Calendar</SectionLabel>
            <EventCalendarPanel chain={chain} futures={futures} corporateActions={corporateActions} symbol={selectedSymbol} />
          </div>
        </div>
      </div>
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
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl p-4 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] hover:border-gray-700/80 light:hover:border-slate-300 hover:shadow-[0_14px_36px_-14px_rgba(0,0,0,0.85)] transition-all duration-200">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider">{EXPIRY_LABEL_TEXT[contract.expiryLabel]}</span>
        <span className="text-[10px] text-gray-500 light:text-slate-500">DTE {contract.dte}</span>
      </div>
      <div className="text-xl font-bold tabular-nums text-gray-50 light:text-slate-900 mb-1.5">
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
      <div className="grid grid-cols-3 gap-2 text-[11px] pt-2.5 border-t border-gray-800/60 light:border-slate-200">
        <div>
          <div className="text-gray-500 light:text-slate-500 mb-0.5">OI</div>
          <div className="text-gray-300 light:text-slate-700 font-medium tabular-nums">{formatCompact(contract.oi)}</div>
        </div>
        <div>
          <div className="text-gray-500 light:text-slate-500 mb-0.5">Chg OI</div>
          <div className={`font-medium tabular-nums ${contract.changeOi >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
            {contract.changeOi >= 0 ? '+' : ''}{formatCompact(contract.changeOi)}
          </div>
        </div>
        <div>
          <div className="text-gray-500 light:text-slate-500 mb-0.5">Volume</div>
          <div className="text-gray-300 light:text-slate-700 font-medium tabular-nums">{formatCompact(contract.volume)}</div>
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

  const oiBarColor = side === 'call' ? 'bg-emerald-500/60' : 'bg-red-500/60';
  const oiCell = (
    <td className={`text-right px-2 py-1.5 tabular-nums text-gray-300 light:text-slate-700 ${bg}`}>
      <div className="flex items-center justify-end gap-1.5">
        <div className="w-16 h-1.5 bg-gray-800/60 light:bg-slate-200 rounded-full overflow-hidden">
          <div className={`h-full rounded-full bar-animated ${oiBarColor}`} style={{ width: `${oiBar}%` }} />
        </div>
        {formatCompact(leg.oi)}
      </div>
    </td>
  );
  const changeOiCell = (
    <td className={`text-right px-2 py-1.5 tabular-nums ${bg} ${leg.changeOi > 0 ? 'text-emerald-400 light:text-emerald-700' : leg.changeOi < 0 ? 'text-red-400 light:text-red-700' : 'text-gray-400 light:text-slate-500'}`}>
      {leg.changeOi > 0 ? '+' : ''}{formatCompact(leg.changeOi)}
    </td>
  );
  const volCell = <td className={`text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-500 ${bg}`}>{formatCompact(leg.volume)}</td>;
  const ivCell = (
    <td
      className={`text-right px-2 py-1.5 tabular-nums ${bg} ${ivCalculated ? 'text-amber-400' : 'text-gray-300 light:text-slate-700'}`}
      title={ivCalculated ? 'Calculated internally — broker Greeks unavailable for this leg' : 'Broker-provided'}
    >
      {leg.iv.toFixed(1)}%{ivCalculated && <sup>~</sup>}
    </td>
  );
  const deltaCell = <td className={`text-right px-2 py-1.5 tabular-nums text-gray-400 light:text-slate-500 ${bg}`}>{leg.delta.toFixed(2)}</td>;
  const thetaCell = <td className={`text-right px-2 py-1.5 tabular-nums text-gray-500 light:text-slate-500 ${bg}`}>{leg.theta.toFixed(2)}</td>;
  const ltpCell = <td className={`text-right px-2 py-1.5 tabular-nums font-medium text-gray-200 light:text-slate-800 ${bg}`}>{leg.ltp.toFixed(2)}</td>;
  const activityCell = (
    <td className={`px-2 py-1.5 ${bg} ${side === 'call' ? 'text-right border-r border-gray-800/50 light:border-slate-200' : 'text-left border-l border-gray-800/50 light:border-slate-200'}`}>
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
      border ? (right ? 'border-r border-gray-800/50 light:border-slate-200' : 'border-l border-gray-800/50 light:border-slate-200') : ''
    }`}>
      {children}
    </th>
  );
}

function SummaryTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'emerald' | 'red' | 'gray' }) {
  const color = accent === 'emerald' ? 'text-emerald-400 light:text-emerald-700' : accent === 'red' ? 'text-red-400 light:text-red-700' : 'text-gray-100 light:text-slate-800';
  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl p-3.5 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] hover:border-gray-700/80 light:hover:border-slate-300 hover:shadow-[0_14px_36px_-14px_rgba(0,0,0,0.85)] transition-all duration-200">
      <div className="text-[10px] text-gray-500 light:text-slate-500 uppercase tracking-wider mb-1.5">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 light:text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function SectionLabel({ children, icon }: { children: React.ReactNode; icon?: string }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      {icon && <span className="text-xs leading-none opacity-80">{icon}</span>}
      <span className="text-[11px] font-bold text-gray-400 light:text-slate-500 uppercase tracking-wider whitespace-nowrap">{children}</span>
      <div className="flex-1 h-px bg-gradient-to-r from-gray-700/70 via-gray-800/40 to-transparent" />
    </div>
  );
}

// --- Option Chain Intelligence Cards ---

const INTEL_ACCENT: Record<string, string> = {
  amber: 'border-t-amber-500/50',
  blue: 'border-t-blue-500/50',
  red: 'border-t-red-500/50',
  emerald: 'border-t-emerald-500/50',
};

function IntelCard({ title, children, accent = 'amber' }: { title: string; children: React.ReactNode; accent?: keyof typeof INTEL_ACCENT }) {
  return (
    <div className={`bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 ${INTEL_ACCENT[accent]} rounded-xl p-3.5 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] hover:border-gray-700/80 light:hover:border-slate-300 hover:shadow-[0_14px_36px_-14px_rgba(0,0,0,0.85)] transition-all duration-200`}>
      <div className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider mb-2.5">{title}</div>
      {children}
    </div>
  );
}

function OiTrapCard({ trap }: { trap: OiTrapAnalysis }) {
  const active = trap.call.active || trap.put.active;
  return (
    <IntelCard title="OI Trapping" accent="amber">
      <div className="flex items-center gap-2 mb-2.5">
        <TrapPill label="Call side" side={trap.call} color="emerald" />
        <TrapPill label="Put side" side={trap.put} color="red" />
      </div>
      <p className={`text-[11px] leading-snug ${active ? 'text-gray-300 light:text-slate-700' : 'text-gray-500 light:text-slate-500'}`}>{trap.summary}</p>
    </IntelCard>
  );
}

function TrapPill({ label, side, color }: { label: string; side: { active: boolean; strike: number | null; strength: number }; color: 'emerald' | 'red' }) {
  const activeClass = color === 'emerald' ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' : 'bg-red-500/15 text-red-400 border-red-500/30';
  return (
    <div className={`flex-1 text-center rounded-lg border px-2 py-2 ${side.active ? activeClass : 'bg-gray-900/40 light:bg-slate-100 text-gray-600 light:text-slate-400 border-gray-800/60 light:border-slate-200'}`}>
      <div className="text-[10px] font-medium mb-0.5">{label}</div>
      {side.active ? (
        <div className="text-sm font-bold tabular-nums">{side.strength}</div>
      ) : (
        <div className="text-[10px] tracking-wide">Inactive</div>
      )}
    </div>
  );
}

function PositionMomentumCard({ momentum }: { momentum: PositionMomentum }) {
  return (
    <IntelCard title="Position Momentum" accent="blue">
      <MomentumRow label="Calls" oi={momentum.callOi} oiChange={momentum.callOiChange} activity={momentum.callActivity} />
      <MomentumRow label="Puts" oi={momentum.putOi} oiChange={momentum.putOiChange} activity={momentum.putActivity} />
    </IntelCard>
  );
}

function MomentumRow({
  label,
  oi,
  oiChange,
  activity,
}: {
  label: string;
  oi: number;
  oiChange: number;
  activity: 'BUILDING' | 'REDUCING' | 'FLAT';
}) {
  const activityClass =
    activity === 'BUILDING' ? 'text-emerald-400 light:text-emerald-700 bg-emerald-500/15' : activity === 'REDUCING' ? 'text-red-400 light:text-red-700 bg-red-500/15' : 'text-gray-400 light:text-slate-500 bg-gray-800/50 light:bg-slate-200';
  return (
    <div className="flex items-center justify-between text-xs py-1.5">
      <span className="text-gray-400 light:text-slate-500 w-10">{label}</span>
      <span className="text-gray-200 light:text-slate-800 font-medium tabular-nums flex-1 text-right pr-2">{formatCompact(oi)}</span>
      <span className={`tabular-nums pr-2 font-medium ${oiChange >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
        {oiChange >= 0 ? '+' : ''}{formatCompact(oiChange)}
      </span>
      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${activityClass}`}>{activity}</span>
    </div>
  );
}

const DECAY_SPEED_CLASS: Record<DecayAnalysis['speed'], string> = {
  SLOW: 'text-blue-400 bg-blue-500/15',
  MODERATE: 'text-yellow-400 bg-yellow-500/15',
  FAST: 'text-orange-400 bg-orange-500/15',
  EXTREME: 'text-red-400 bg-red-500/15',
};

function DecayCard({ decay }: { decay: DecayAnalysis }) {
  return (
    <IntelCard title="Time Decay" accent="red">
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-xs text-gray-400 light:text-slate-500">DTE <span className="text-gray-200 light:text-slate-800 font-semibold">{decay.dte}</span></span>
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${DECAY_SPEED_CLASS[decay.speed]}`}>{decay.speed}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 text-[10px] mb-0.5">ATM Call θ/day</div>
          <div className="text-red-400 font-semibold tabular-nums">{decay.atmCallThetaPct.toFixed(2)}%</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
          <div className="text-gray-500 light:text-slate-500 text-[10px] mb-0.5">ATM Put θ/day</div>
          <div className="text-red-400 font-semibold tabular-nums">{decay.atmPutThetaPct.toFixed(2)}%</div>
        </div>
      </div>
    </IntelCard>
  );
}

function TradeSetupCard({ setup }: { setup: TradeSetup }) {
  if (!setup.available) {
    return (
      <IntelCard title="Trade Setup" accent="emerald">
        <p className="text-[11px] text-gray-500 light:text-slate-500 leading-snug">{setup.reason}</p>
      </IntelCard>
    );
  }

  const lockedNote = setup.generatedAt && (
    <> Locked at {new Date(setup.generatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' })}, holds until target/stop is hit.</>
  );

  if (setup.structureType === 'SPREAD') {
    const isCredit = (setup.netPremium ?? 0) < 0;
    return (
      <IntelCard title="Trade Setup" accent="emerald">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-bold px-2 py-1 rounded-md bg-cyan-500/15 text-cyan-400 shadow-[0_0_10px_-2px_rgba(34,211,238,0.4)]">
            {setup.strategy}
          </span>
          <span className="text-[10px] text-gray-400 light:text-slate-500 font-medium">R:R {setup.riskReward!.toFixed(2)}</span>
        </div>
        <div className="text-[10px] text-gray-500 light:text-slate-500 mb-2 leading-snug">
          {setup.legs?.map((l) => `${l.action} ${l.side} ${formatIndianNumber(l.strike, 0)} @ ${l.premium.toFixed(2)}`).join(' · ')}
        </div>
        <div className="grid grid-cols-3 gap-1.5 text-[11px]">
          <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-500 light:text-slate-500 text-[10px]">Net {isCredit ? 'Credit' : 'Debit'}</div>
            <div className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">{Math.abs(setup.netPremium ?? 0).toFixed(2)}</div>
          </div>
          <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-500 light:text-slate-500 text-[10px]">Max Loss</div>
            <div className="text-red-400 font-semibold tabular-nums">{setup.maxLoss!.toFixed(2)}</div>
          </div>
          <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2 py-1.5">
            <div className="text-gray-500 light:text-slate-500 text-[10px]">Max Profit</div>
            <div className="text-emerald-400 font-semibold tabular-nums">{setup.maxProfit!.toFixed(2)}</div>
          </div>
        </div>
        <div className="text-[10px] text-gray-500 light:text-slate-500 mt-1.5">
          {setup.breakevenLower != null && setup.breakevenUpper != null
            ? `Breakeven range ${formatIndianNumber(setup.breakevenLower, 0)}–${formatIndianNumber(setup.breakevenUpper, 0)}`
            : setup.breakeven != null
            ? `Breakeven ${formatIndianNumber(setup.breakeven, 0)}`
            : null}
        </div>
        <p className="text-[10px] text-gray-600 mt-2.5 leading-snug">
          Defined-risk spread — matches Strategy Scanner's IV-regime call for this symbol.{lockedNote}
        </p>
      </IntelCard>
    );
  }

  const isCall = setup.side === 'CE';
  return (
    <IntelCard title="Trade Setup" accent="emerald">
      <div className="flex items-center justify-between mb-2.5">
        <span className={`text-xs font-bold px-2 py-1 rounded-md ${isCall ? 'bg-emerald-500/15 text-emerald-400 shadow-[0_0_10px_-2px_rgba(16,185,129,0.4)]' : 'bg-red-500/15 text-red-400 shadow-[0_0_10px_-2px_rgba(239,68,68,0.4)]'}`}>
          {setup.side} {formatIndianNumber(setup.strike!, 0)}
        </span>
        <span className="text-[10px] text-gray-400 light:text-slate-500 font-medium">R:R {setup.riskReward!.toFixed(2)}</span>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-[11px]">
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-500 light:text-slate-500 text-[10px]">Entry</div>
          <div className="text-gray-200 light:text-slate-800 font-semibold tabular-nums">{setup.entry!.toFixed(2)}</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-500 light:text-slate-500 text-[10px]">SL</div>
          <div className="text-red-400 font-semibold tabular-nums">{setup.stopLoss!.toFixed(2)}</div>
        </div>
        <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2 py-1.5">
          <div className="text-gray-500 light:text-slate-500 text-[10px]">Target</div>
          <div className="text-emerald-400 font-semibold tabular-nums">{setup.target!.toFixed(2)}</div>
        </div>
      </div>
      <p className="text-[10px] text-gray-600 mt-2.5 leading-snug">
        Heuristic from live data — not investment advice.{lockedNote}
      </p>
    </IntelCard>
  );
}
