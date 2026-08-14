'use client';

import React from 'react';
import { formatPercent, formatCompact } from '@fno/shared';
import type { FnoScannerRow } from '@fno/shared';
import { useAssetTabsStore } from '@/stores';

const ACCENT_COLORS: Record<string, {
  border: string;
  rankBg: string;
  rankText: string;
  barBg: string;
}> = {
  emerald: {
    border: 'border-l-emerald-500/70',
    rankBg: 'bg-emerald-500/15',
    rankText: 'text-emerald-400 light:text-emerald-700',
    barBg: 'bg-emerald-500/40',
  },
  red: {
    border: 'border-l-red-500/70',
    rankBg: 'bg-red-500/15',
    rankText: 'text-red-400 light:text-red-700',
    barBg: 'bg-red-500/40',
  },
  yellow: {
    border: 'border-l-yellow-500/70',
    rankBg: 'bg-yellow-500/15',
    rankText: 'text-yellow-400 light:text-yellow-700',
    barBg: 'bg-yellow-500/40',
  },
  orange: {
    border: 'border-l-orange-500/70',
    rankBg: 'bg-orange-500/15',
    rankText: 'text-orange-400 light:text-orange-700',
    barBg: 'bg-orange-500/40',
  },
};

export function ActivityList({
  title,
  items,
  color,
}: {
  title: string;
  items: FnoScannerRow[];
  color: string;
}) {
  const accent = ACCENT_COLORS[color] || ACCENT_COLORS.emerald;
  const maxOiChange = Math.max(1, ...items.map((s) => Math.abs(s.futuresChangeOi)));

  return (
    <div className={`bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.12)] hover:border-gray-700/80 light:hover:border-slate-300 transition-all duration-200 overflow-hidden`}>
      <div className="px-3.5 pt-3.5 pb-2">
        <h3 className="text-xs font-bold text-gray-300 light:text-slate-700">{title}</h3>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-gray-600 light:text-slate-400 py-4 px-3.5 text-center">No activity</div>
      ) : (
        <div className="pb-2">
          {items.map((s, idx) => {
            const oiBarWidth = Math.max(4, (Math.abs(s.futuresChangeOi) / maxOiChange) * 100);
            return (
              <div
                key={s.symbol}
                onClick={() => useAssetTabsStore.getState().openTab(s.symbol, s.exchange)}
                className={`flex items-center gap-2 text-xs py-2 px-3.5 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-colors border-l-2 ${accent.border} stagger-item`}
                style={{ '--stagger-index': idx } as React.CSSProperties}
              >
                {/* Rank badge */}
                <span className={`w-5 h-5 flex items-center justify-center rounded-md text-[10px] font-bold shrink-0 ${accent.rankBg} ${accent.rankText}`}>
                  {idx + 1}
                </span>
                <span className="text-gray-300 light:text-slate-700 font-medium flex-1 truncate">{s.symbol}</span>
                {/* Mini OI change bar */}
                <div className="w-14 h-1.5 bg-gray-800/50 light:bg-slate-200 rounded-full overflow-hidden shrink-0">
                  <div className={`h-full rounded-full bar-animated ${accent.barBg}`} style={{ width: `${oiBarWidth}%` }} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`tabular-nums ${s.changePercent >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
                    {formatPercent(s.changePercent)}
                  </span>
                  <span className="text-gray-500 light:text-slate-500 tabular-nums text-[10px] w-10 text-right">{formatCompact(s.futuresChangeOi)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
