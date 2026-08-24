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
  accentGradient: string;
}> = {
  emerald: {
    border: 'border-l-emerald-500/70',
    rankBg: 'bg-emerald-500/15',
    rankText: 'text-emerald-400 light:text-emerald-700',
    barBg: 'bg-emerald-400',
    accentGradient: 'linear-gradient(90deg, rgba(16, 185, 129, 0.7), rgba(6, 182, 212, 0.4))',
  },
  red: {
    border: 'border-l-red-500/70',
    rankBg: 'bg-red-500/15',
    rankText: 'text-red-400 light:text-red-700',
    barBg: 'bg-red-400',
    accentGradient: 'linear-gradient(90deg, rgba(239, 68, 68, 0.7), rgba(251, 146, 60, 0.4))',
  },
  yellow: {
    border: 'border-l-yellow-500/70',
    rankBg: 'bg-yellow-500/15',
    rankText: 'text-yellow-400 light:text-yellow-700',
    barBg: 'bg-yellow-400',
    accentGradient: 'linear-gradient(90deg, rgba(251, 191, 36, 0.7), rgba(245, 158, 11, 0.4))',
  },
  orange: {
    border: 'border-l-orange-500/70',
    rankBg: 'bg-orange-500/15',
    rankText: 'text-orange-400 light:text-orange-700',
    barBg: 'bg-orange-400',
    accentGradient: 'linear-gradient(90deg, rgba(249, 115, 22, 0.7), rgba(245, 158, 11, 0.4))',
  },
};

const MEDALS = ['🥇', '🥈', '🥉'];

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
    <div className="card-premium card-accent-top" style={{ '--accent-gradient': accent.accentGradient } as React.CSSProperties}>
      <div className="px-3.5 pt-3.5 pb-2 border-b border-gray-800/30 light:border-slate-200">
        <h3 className="text-xs font-bold text-gray-200 light:text-slate-800">{title}</h3>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-gray-500 light:text-slate-400 py-5 px-3.5 text-center font-medium">No activity</div>
      ) : (
        <div className="py-1.5 divide-y divide-gray-800/20 light:divide-slate-100">
          {items.map((s, idx) => {
            const oiBarWidth = Math.max(8, (Math.abs(s.futuresChangeOi) / maxOiChange) * 100);
            return (
              <div
                key={s.symbol}
                onClick={() => useAssetTabsStore.getState().openTab(s.symbol, s.exchange)}
                className={`flex items-center gap-2.5 text-xs py-2 px-3.5 hover:bg-gray-800/30 light:hover:bg-slate-100 cursor-pointer transition-all duration-150 border-l-2 border-l-transparent hover:border-l-current ${accent.rankText} stagger-item group`}
                style={{ '--stagger-index': idx } as React.CSSProperties}
              >
                {/* Rank badge */}
                <span className={`w-5 h-5 flex items-center justify-center rounded-md text-[10px] font-bold shrink-0 badge-glass ${accent.rankBg} ${accent.rankText}`}>
                  {idx < 3 ? MEDALS[idx] : idx + 1}
                </span>
                <span className="text-gray-200 light:text-slate-800 font-bold flex-1 truncate group-hover:text-white transition-colors">{s.symbol}</span>
                {/* Mini OI change bar */}
                <div className="w-12 h-1.5 bg-gray-800/60 light:bg-slate-200 rounded-full overflow-hidden shrink-0">
                  <div className={`h-full rounded-full bar-animated ${accent.barBg}`} style={{ width: `${oiBarWidth}%` }} />
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`tabular-nums font-bold ${s.changePercent >= 0 ? 'text-emerald-400 light:text-emerald-700' : 'text-red-400 light:text-red-700'}`}>
                    {formatPercent(s.changePercent)}
                  </span>
                  <span className="text-gray-400 light:text-slate-500 tabular-nums text-[10px] font-medium w-11 text-right">{formatCompact(s.futuresChangeOi)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

