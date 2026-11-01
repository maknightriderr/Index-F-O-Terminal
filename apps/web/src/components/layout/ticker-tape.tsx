'use client';

import React from 'react';
import { useLiveIndices } from '@/lib/use-live-indices';
import { useAssetTabsStore } from '@/stores';

/** A one-line strip of the live index quotes above the top bar. Empty until real quotes arrive — never sample prices. */
export function TickerTape() {
  const { indices, isLive } = useLiveIndices();
  const openTab = useAssetTabsStore((s) => s.openTab);
  return (
    <div className="cc-tape" role="region" aria-label="Index quotes">
      {indices.length === 0 ? (
        <span className="text-[var(--text-muted)]">{isLive ? 'No index quotes yet' : 'Index quotes unavailable — waiting for the feed'}</span>
      ) : (
        indices.map((q) => {
          const ch = q.changePercent;
          const cls = !Number.isFinite(ch) || ch === 0 ? 'cc-flat' : ch > 0 ? 'cc-up' : 'cc-down';
          return (
            <button key={`${q.exchange}:${q.symbol}`} type="button" onClick={() => openTab(q.symbol, q.exchange)} className="text-left hover:underline" aria-label={`${q.symbol} ${q.ltp.toFixed(2)}, ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(2)} percent. Open workspace.`}>
              <span className="text-[var(--text-muted)]">{q.symbol}</span>{' '}
              <b>{q.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</b>{' '}
              <span className={cls}>{Number.isFinite(ch) ? `${ch > 0 ? '+' : ch < 0 ? '−' : ''}${Math.abs(ch).toFixed(2)}%` : '—'}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
