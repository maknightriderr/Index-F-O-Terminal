'use client';

import React from 'react';
import { formatPercent, formatCompact } from '@fno/shared';
import type { FnoScannerRow } from '@fno/shared';
import { useAssetTabsStore } from '@/stores';

export function ActivityList({
  title,
  items,
  color,
}: {
  title: string;
  items: FnoScannerRow[];
  color: string;
}) {
  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 p-3.5">
      <h3 className="text-xs font-bold text-gray-300 light:text-slate-700 mb-2.5">{title}</h3>
      {items.length === 0 ? (
        <div className="text-xs text-gray-600 light:text-slate-400 py-2">No activity</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((s) => (
            <div
              key={s.symbol}
              onClick={() => useAssetTabsStore.getState().openTab(s.symbol, s.exchange)}
              className="flex items-center justify-between text-xs py-1 hover:bg-gray-800/30 light:hover:bg-slate-100 px-1.5 rounded cursor-pointer"
            >
              <span className="text-gray-300 light:text-slate-700 font-medium">{s.symbol}</span>
              <div className="flex items-center gap-2">
                <span className={`tabular-nums ${s.changePercent >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
                  {formatPercent(s.changePercent)}
                </span>
                <span className="text-gray-500 light:text-slate-500 tabular-nums">{formatCompact(s.futuresChangeOi)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
