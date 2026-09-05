'use client';

import React from 'react';
import { useWatchlistStore, useMarketStore, useAssetTabsStore } from '@/stores';
import type { MarketQuote, FnoScannerRow } from '@fno/shared';
import { formatIndianNumber, formatPercent, formatCompact } from '@fno/shared';

/**
 * Joins each watchlist item against data the Dashboard already has in
 * memory (index quotes for NIFTY/BANKNIFTY-type symbols, F&O scanner rows
 * for stocks) rather than firing a new per-symbol request for every item.
 */
export function WatchlistPanel({ allIndices, fnoRows }: { allIndices: MarketQuote[]; fnoRows: FnoScannerRow[] }) {
  const watchlists = useWatchlistStore((s) => s.watchlists);
  const activeWatchlistId = useWatchlistStore((s) => s.activeWatchlistId);
  const togglePin = useWatchlistStore((s) => s.togglePin);
  const removeItem = useWatchlistStore((s) => s.removeItem);
  const openTab = useAssetTabsStore((s) => s.openTab);
  const setActiveTab = useMarketStore((s) => s.setActiveTab);

  const activeWatchlist = watchlists.find((w) => w.id === activeWatchlistId) ?? watchlists[0] ?? null;
  const indexBySymbol = new Map(allIndices.map((i) => [i.symbol, i]));
  const stockBySymbol = new Map(fnoRows.map((r) => [r.symbol, r]));

  const rows = (activeWatchlist?.items ?? [])
    .map((item) => {
      const idx = indexBySymbol.get(item.symbol);
      const stock = stockBySymbol.get(item.symbol);
      return {
        ...item,
        ltp: idx?.ltp ?? stock?.price ?? null,
        changePercent: idx?.changePercent ?? stock?.changePercent ?? null,
        volume: idx?.volume ?? stock?.volume ?? null,
        oi: stock?.futuresOi ?? null,
      };
    })
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || a.sortOrder - b.sortOrder);

  return (
    <div className="card-premium overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-800/40 light:border-slate-200 flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-100 light:text-slate-900">⭐ {activeWatchlist?.name ?? 'Watchlist'}</h3>
        <span className="text-[10px] text-gray-500 light:text-slate-500">{rows.length} symbols</span>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-xs text-gray-500 light:text-slate-500 text-center">
          Your watchlist is empty — add symbols via Add Asset.
        </div>
      ) : (
        <div className="divide-y divide-gray-800/30 light:divide-slate-100 max-h-[380px] overflow-y-auto">
          {rows.map((r) => {
            const isPos = (r.changePercent ?? 0) >= 0;
            return (
              <div
                key={r.id}
                className="px-4 py-2.5 flex items-center gap-3 hover:bg-gray-800/20 light:hover:bg-slate-50 transition-colors group"
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeWatchlist) togglePin(activeWatchlist.id, r.id);
                  }}
                  className={`text-sm shrink-0 ${r.pinned ? 'text-amber-400' : 'text-gray-600 light:text-slate-300 opacity-0 group-hover:opacity-100'} transition-opacity`}
                  title={r.pinned ? 'Unpin' : 'Pin to top'}
                >
                  {r.pinned ? '★' : '☆'}
                </button>

                <div onClick={() => openTab(r.symbol, r.exchange)} className="flex-1 min-w-0 cursor-pointer">
                  <div className="text-xs font-bold text-gray-100 light:text-slate-900 truncate">{r.symbol}</div>
                  <div className="text-[10px] text-gray-500 light:text-slate-500 tabular-nums">
                    {r.exchange}
                    {r.oi != null ? ` · OI ${formatCompact(r.oi)}` : ''}
                    {r.volume != null ? ` · Vol ${formatCompact(r.volume)}` : ''}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div className="text-xs font-bold tabular-nums text-gray-100 light:text-slate-900">
                    {r.ltp != null ? formatIndianNumber(r.ltp, 2) : '—'}
                  </div>
                  {r.changePercent != null && (
                    <div className={`text-[10px] font-semibold tabular-nums ${isPos ? 'text-emerald-400' : 'text-red-400'}`}>
                      {isPos ? '+' : ''}
                      {formatPercent(r.changePercent)}
                    </div>
                  )}
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveTab('alerts');
                  }}
                  className="text-gray-500 light:text-slate-400 hover:text-amber-400 text-sm shrink-0"
                  title="Manage alerts for this symbol"
                >
                  🔔
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeWatchlist) removeItem(activeWatchlist.id, r.id);
                  }}
                  className="text-gray-600 light:text-slate-300 hover:text-red-400 text-xs shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove from watchlist"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
