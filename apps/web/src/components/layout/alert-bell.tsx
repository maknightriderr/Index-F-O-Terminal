'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useAlerts } from '@/lib/use-alerts';
import { relativeTime } from '@/lib/relative-time';
import { SeverityBadge } from '@/components/common/badges';
import { useAssetTabsStore, useMarketStore, useUISettingsStore } from '@/stores';
import type { Exchange } from '@fno/shared';

export function AlertBell() {
  const { alerts } = useAlerts(15);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const openTab = useAssetTabsStore((s) => s.openTab);
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  const lastSeenAt = useUISettingsStore((s) => s.lastAlertsSeenAt);
  const markAlertsSeen = useUISettingsStore((s) => s.markAlertsSeen);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  // Unread = newer than the last time the bell was opened, not a rolling
  // time window — the old version counted every alert from the last 24h
  // regardless of whether the user had already seen it, so the badge never
  // actually cleared from opening the dropdown.
  const unreadCount = alerts.filter((a) => a.createdAt > lastSeenAt).length;

  const handleAlertClick = (symbol: string, exchange?: string) => {
    // Digest alerts (OI/IV extremes across the whole universe) use this
    // pseudo-symbol since they summarize many stocks, not one — nothing to
    // open a tab for; view the full per-symbol breakdown on the Alerts page instead.
    if (symbol === 'NSE_FNO_UNIVERSE') {
      setActiveTab('alerts');
      setOpen(false);
      return;
    }
    if (exchange) openTab(symbol, exchange as Exchange);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() =>
          setOpen((o) => {
            const next = !o;
            if (next) markAlertsSeen();
            return next;
          })
        }
        className="relative w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 light:text-slate-500 hover:text-gray-200 light:hover:text-slate-800 hover:bg-gray-800/60 light:hover:bg-slate-100 transition-colors"
        title="Alerts"
      >
        🔔
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-9 w-80 max-h-96 overflow-y-auto bg-[#12121a] light:bg-white border border-gray-800/60 light:border-slate-200 rounded-xl shadow-[0_16px_40px_-12px_rgba(0,0,0,0.7)] light:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.2)] z-50">
          <div className="px-3.5 py-2.5 border-b border-gray-800/60 light:border-slate-200 flex items-center justify-between">
            <span className="text-xs font-bold text-gray-200 light:text-slate-800">Alerts</span>
            <button
              onClick={() => {
                setActiveTab('alerts');
                setOpen(false);
              }}
              className="text-[11px] text-emerald-400 light:text-emerald-700 hover:text-emerald-300 light:hover:text-emerald-600 font-medium"
            >
              View all →
            </button>
          </div>
          {alerts.length === 0 ? (
            <div className="text-xs text-gray-500 light:text-slate-500 py-8 text-center">No alerts yet</div>
          ) : (
            <div className="divide-y divide-gray-800/40 light:divide-slate-100">
              {alerts.map((a) => (
                <div
                  key={a.id}
                  onClick={() => handleAlertClick(a.symbol, a.data?.exchange as string | undefined)}
                  className="px-3.5 py-2.5 hover:bg-gray-800/30 light:hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-xs font-semibold text-gray-200 light:text-slate-800">
                      {a.symbol === 'NSE_FNO_UNIVERSE' ? 'F&O Universe' : a.symbol}
                    </span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <SeverityBadge severity={a.severity} />
                      <span className="text-[10px] text-gray-500 light:text-slate-400">{relativeTime(a.createdAt)}</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-400 light:text-slate-500 leading-snug">{a.message}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
