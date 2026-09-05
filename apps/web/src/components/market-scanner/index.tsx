'use client';

import React, { useState } from 'react';
import { useMarketScanner } from '@/lib/use-market-scanner';
import { useAssetTabsStore } from '@/stores';
import { formatIndianNumber } from '@fno/shared';
import type { ScannedCandidate, ScannerScoreBreakdown } from '@fno/shared';
import { ScoreBadge } from '@/components/common/badges';

const TREND_STYLES: Record<string, { label: string; className: string; dot: string }> = {
  BULLISH: { label: 'Bullish', className: 'text-emerald-400', dot: 'bg-emerald-400' },
  BEARISH: { label: 'Bearish', className: 'text-red-400', dot: 'bg-red-400' },
  SIDEWAYS: { label: 'Sideways', className: 'text-yellow-400', dot: 'bg-yellow-400' },
};

const TIER_STYLES: Record<string, { label: string; className: string }> = {
  HIGH_CONVICTION: { label: 'High Conviction', className: 'bg-emerald-500/15 text-emerald-400 shadow-[0_0_0_1px_rgba(16,185,129,0.3)_inset]' },
  WATCHLIST: { label: 'Watchlist', className: 'bg-yellow-500/15 text-yellow-400 shadow-[0_0_0_1px_rgba(234,179,8,0.3)_inset]' },
  WEAK: { label: 'Weak', className: 'bg-gray-500/15 text-gray-400 shadow-[0_0_0_1px_rgba(156,163,175,0.25)_inset]' },
};

const BREAKDOWN_LABELS: Array<{ key: keyof ScannerScoreBreakdown; label: string; max: number }> = [
  { key: 'marketTrend', label: 'Market Trend', max: 15 },
  { key: 'sectorStrength', label: 'Sector Strength', max: 10 },
  { key: 'priceAction', label: 'Price Action', max: 20 },
  { key: 'emaTrend', label: 'EMA Trend', max: 10 },
  { key: 'volume', label: 'Volume', max: 10 },
  { key: 'optionChain', label: 'Option Chain', max: 15 },
  { key: 'oiBuildup', label: 'OI Build-up', max: 10 },
  { key: 'smcStructure', label: 'SMC Structure', max: 10 },
];

export function MarketScannerPage() {
  const { data, isLive, loading } = useMarketScanner();
  const openTab = useAssetTabsStore((s) => s.openTab);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-gray-100 light:text-slate-900">Market Scanner</h1>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-0.5">
            NIFTY trend → strongest/weakest sector → top liquid F&amp;O stocks, scored 0-100 across 8 categories. Refreshes every 5 minutes.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-gray-500 light:text-slate-500">
          <span className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600 light:bg-slate-300'}`} />
          {isLive ? `Scanned ${data ? new Date(data.scannedAt).toLocaleTimeString('en-IN') : ''}` : loading ? 'Loading…' : 'Unreachable'}
        </span>
      </div>

      {!isLive && !loading && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-4 py-2.5 text-amber-400 light:text-amber-700 text-xs font-medium">
          ⚠️ Market Scanner unreachable right now — it'll pick back up on the next successful poll.
        </div>
      )}

      {loading && !data && (
        <div className="bg-gradient-to-b from-[#141420] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl p-8 text-center text-xs text-gray-500 light:text-slate-500 animate-pulse">
          Running the top-down scan…
        </div>
      )}

      {data && <MarketStatusBanner data={data} />}

      {data && data.marketTrend.trend === 'SIDEWAYS' && (
        <div className="bg-gray-900/40 light:bg-slate-100 border border-gray-800/50 light:border-slate-200 rounded-xl p-6 text-center">
          <div className="text-sm font-bold text-gray-200 light:text-slate-800">No setups — index is sideways</div>
          <p className="text-xs text-gray-500 light:text-slate-500 mt-1 max-w-md mx-auto">
            No trade is also a position. Sector/stock scanning is skipped while NIFTY has no clean directional lean — the scanner will
            pick back up automatically once a real trend read emerges.
          </p>
        </div>
      )}

      {data && data.marketTrend.trend !== 'SIDEWAYS' && data.sector && (
        <div className="bg-gray-900/40 light:bg-slate-100 border border-gray-800/50 light:border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div>
            <span className="text-[10px] text-gray-500 light:text-slate-500 uppercase tracking-wide">
              {data.marketTrend.trend === 'BULLISH' ? 'Strongest sector' : 'Weakest sector'}
            </span>
            <div className="text-sm font-bold text-gray-100 light:text-slate-900">{data.sector.sector}</div>
          </div>
          <div className="text-xs text-gray-400 light:text-slate-500">
            Avg relative strength {data.sector.avgRelativeStrength > 0 ? '+' : ''}
            {data.sector.avgRelativeStrength}% vs NIFTY · {data.sector.memberCount} liquid F&amp;O members
          </div>
        </div>
      )}

      {data && data.marketTrend.trend !== 'SIDEWAYS' && data.candidates.length === 0 && (
        <div className="bg-gray-900/40 light:bg-slate-100 border border-gray-800/50 light:border-slate-200 rounded-xl p-6 text-center text-xs text-gray-500 light:text-slate-500">
          No candidates cleared the 60-point bar this cycle.
        </div>
      )}

      {data && data.candidates.length > 0 && (
        <div className="space-y-2">
          {data.candidates.map((c) => (
            <CandidateCard
              key={c.symbol}
              candidate={c}
              expanded={expanded === c.symbol}
              onToggle={() => setExpanded(expanded === c.symbol ? null : c.symbol)}
              onOpen={() => openTab(c.symbol, c.exchange)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MarketStatusBanner({ data }: { data: NonNullable<ReturnType<typeof useMarketScanner>['data']> }) {
  const trend = TREND_STYLES[data.marketTrend.trend] ?? TREND_STYLES.SIDEWAYS;
  const { niftyBias, bankNiftyBias, vix, breadth, score } = data.marketTrend;

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl p-4">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${trend.dot}`} />
          <span className={`text-sm font-bold ${trend.className}`}>{trend.label}</span>
          <span className="text-[10px] text-gray-500 light:text-slate-500">Market Trend score {score}/15</span>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <StatCell label="NIFTY" value={`${niftyBias.direction} ${niftyBias.confidence}%`} />
        <StatCell label="BANK NIFTY" value={`${bankNiftyBias.direction} ${bankNiftyBias.confidence}%`} />
        <StatCell label="FIN NIFTY" value={`${data.marketTrend.finniftyBias.direction} ${data.marketTrend.finniftyBias.confidence}%`} />
        <StatCell label="India VIX" value={vix != null ? vix.toFixed(2) : '—'} />
        <StatCell label="Breadth" value={`${breadth.advances} Adv / ${breadth.declines} Dec`} />
      </div>
      <ul className="mt-3 space-y-1">
        {data.marketTrend.reasoning.map((r, i) => (
          <li key={i} className="text-[11px] text-gray-400 light:text-slate-500 flex gap-1.5">
            <span className="text-gray-600 light:text-slate-400">▸</span>
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900/50 light:bg-slate-100 rounded-lg px-2.5 py-2">
      <div className="text-gray-500 light:text-slate-500 mb-1 text-[10px] uppercase tracking-wide">{label}</div>
      <div className="text-gray-200 light:text-slate-800 font-semibold text-xs tabular-nums">{value}</div>
    </div>
  );
}

function CandidateCard({
  candidate,
  expanded,
  onToggle,
  onOpen,
}: {
  candidate: ScannedCandidate;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const tier = TIER_STYLES[candidate.tier] ?? TIER_STYLES.WEAK;
  const ts = candidate.tradeSetup;
  const isCE = candidate.side === 'CE';

  return (
    <div className="bg-[#12121c] light:bg-white border border-gray-800/50 light:border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-800/30 light:hover:bg-slate-50 transition-colors" onClick={onToggle}>
        <div
          className={`w-1 h-10 rounded-full shrink-0 ${
            isCE ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]' : 'bg-red-400 shadow-[0_0_8px_rgba(239,68,68,0.7)]'
          }`}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="text-sm font-bold text-gray-100 light:text-slate-900 hover:text-purple-400 transition-colors"
        >
          {candidate.symbol}
        </button>
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-gray-800 light:bg-slate-100 text-gray-400 light:text-slate-600">
          {candidate.sector}
        </span>
        <span className={`text-xs font-bold ${isCE ? 'text-emerald-400' : 'text-red-400'}`}>{candidate.side}</span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold badge-glass ${tier.className}`}>{tier.label}</span>

        <div className="ml-auto flex items-center gap-4">
          {ts.entry != null && (
            <div className="hidden md:flex items-center gap-3 text-[11px] tabular-nums text-gray-400 light:text-slate-500">
              <span>Entry ₹{formatIndianNumber(ts.entry)}</span>
              <span className="text-red-400">SL ₹{formatIndianNumber(ts.stopLoss!)}</span>
              <span className="text-emerald-400">Target ₹{formatIndianNumber(ts.target!)}</span>
              {ts.riskReward != null && <span>R:R 1:{ts.riskReward.toFixed(1)}</span>}
              {ts.positionSize && (
                <span className={ts.positionSize.lots > 0 ? '' : 'text-amber-400'}>
                  {ts.positionSize.lots > 0 ? `${ts.positionSize.lots} lot(s), ₹${ts.positionSize.riskAmount.toFixed(0)} risk` : 'No safe lot size'}
                </span>
              )}
            </div>
          )}
          <ScoreBadge score={candidate.score} large />
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-800/40 light:border-slate-200 grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] text-gray-500 light:text-slate-500 uppercase tracking-wide mb-2">Score breakdown</div>
            <div className="space-y-1.5">
              {BREAKDOWN_LABELS.map(({ key, label, max }) => {
                const value = candidate.scoreBreakdown[key];
                const pct = Math.round((value / max) * 100);
                return (
                  <div key={key} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400 light:text-slate-500 w-24 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 bg-gray-800/80 light:bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-yellow-500' : 'bg-red-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-500 light:text-slate-500 tabular-nums w-10 text-right">
                      {value}/{max}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 light:text-slate-500 uppercase tracking-wide mb-2">Reasoning</div>
            <ul className="space-y-1">
              {candidate.reasoning.map((r, i) => (
                <li key={i} className="text-[11px] text-gray-400 light:text-slate-500 flex gap-1.5">
                  <span className="text-gray-600 light:text-slate-400">▸</span>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
