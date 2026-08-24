'use client';

import React from 'react';
import { formatPercent, formatIndianNumber } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { useAssetTabsStore } from '@/stores';

export interface MoverItem {
  symbol: string;
  exchange: Exchange;
  ltp: number;
  changePercent: number;
}

const MEDALS = ['🥇', '🥈', '🥉'];

export function TopMoversList({
  title,
  items,
  accent,
}: {
  title: string;
  items: MoverItem[];
  accent: 'emerald' | 'red';
}) {
  const rankBg = accent === 'emerald' ? 'bg-emerald-500/15' : 'bg-red-500/15';
  const rankText = accent === 'emerald' ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700';
  const accentGradient = accent === 'emerald'
    ? 'linear-gradient(90deg, rgba(16, 185, 129, 0.7), rgba(6, 182, 212, 0.4))'
    : 'linear-gradient(90deg, rgba(239, 68, 68, 0.7), rgba(251, 146, 60, 0.4))';

  return (
    <div className="card-premium card-accent-top" style={{ '--accent-gradient': accentGradient } as React.CSSProperties}>
      <div className="px-3.5 pt-3.5 pb-2 border-b border-gray-800/30 light:border-slate-200">
        <h3 className="text-xs font-bold text-gray-200 light:text-slate-800">{title}</h3>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-gray-500 light:text-slate-400 py-5 px-3.5 text-center font-medium">No data</div>
      ) : (
        <div className="py-1.5 divide-y divide-gray-800/20 light:divide-slate-100">
          {items.map((item, idx) => (
            <div
              key={item.symbol}
              onClick={() => useAssetTabsStore.getState().openTab(item.symbol, item.exchange)}
              className={`flex items-center gap-2.5 text-xs py-2 px-3.5 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-all duration-150 border-l-2 border-l-transparent hover:border-l-current ${rankText} group`}
            >
              <span className={`w-5 h-5 flex items-center justify-center rounded-md text-[10px] font-bold shrink-0 badge-glass ${rankBg} ${rankText}`}>
                {idx < 3 ? MEDALS[idx] : idx + 1}
              </span>
              <span className="text-gray-200 light:text-slate-800 font-bold flex-1 truncate group-hover:text-white transition-colors">{item.symbol}</span>
              <span className="text-gray-400 light:text-slate-500 tabular-nums text-[11px] font-medium">{formatIndianNumber(item.ltp, 2)}</span>
              <span className={`tabular-nums w-14 text-right font-bold text-xs ${rankText}`}>{formatPercent(item.changePercent)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

