'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useMarketStore } from '@/stores';
import { api, ApiError } from '@/lib/api';
import { formatIndianNumber, formatCompact } from '@fno/shared';
import type { FuturesChainResponse, FuturesData } from '@fno/shared';
import { OIBadge } from '@/components/common/badges';

const REFRESH_INTERVAL_MS = 15000;

const EXPIRY_LABEL_TEXT: Record<FuturesData['expiryLabel'], string> = {
  current: 'Current Month',
  next: 'Next Month',
  far: 'Far Month',
};

export function FuturesPage() {
  const { selectedSymbol, selectedExchange } = useMarketStore();
  const [data, setData] = useState<FuturesChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchFutures = useCallback(
    async (silent = false) => {
      if (!selectedSymbol) return;
      if (!silent) setLoading(true);
      setError(null);

      try {
        const result = await api.getFutures(selectedSymbol, selectedExchange);
        setData(result);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load futures data');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [selectedSymbol, selectedExchange]
  );

  useEffect(() => {
    fetchFutures();
    const interval = setInterval(() => fetchFutures(true), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchFutures]);

  // NOTE: live WS tick merging is intentionally disabled — see the same
  // note in components/option-chain/index.tsx. REST polling above (every
  // 15s) is the verified-correct data source until the binary tick parser
  // is fixed.
  const contracts = data?.contracts ?? [];

  if (!selectedSymbol) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="text-5xl mb-4">📉</div>
        <h2 className="text-xl font-bold text-gray-200 mb-2">No Asset Selected</h2>
        <p className="text-sm text-gray-500 max-w-md">
          Use "+ Add Asset" to pick an index or F&O stock and load its live futures data.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 min-h-full">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-100">{selectedSymbol} Futures</h1>
          {data && (
            <span className="text-sm text-gray-400 tabular-nums">
              Spot: <span className="text-gray-200 font-medium">{formatIndianNumber(data.spotPrice, 2)}</span>
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2 text-red-400 text-xs">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-sm text-gray-500 py-12 text-center">Loading futures data…</div>
      )}

      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {contracts.map((c) => (
            <ContractCard key={c.symbol} contract={c} />
          ))}
        </div>
      )}

      {data && contracts.length > 0 && (
        <div className="bg-[#12121a] border border-gray-800/50 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800/50">
            <h2 className="text-sm font-semibold text-gray-200">Futures OI Trend (Snapshot)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-900/50 text-gray-500 uppercase tracking-wider">
                  <th className="text-left px-4 py-2 font-medium">Expiry</th>
                  <th className="text-right px-3 py-2 font-medium">Price</th>
                  <th className="text-right px-3 py-2 font-medium">Basis</th>
                  <th className="text-right px-3 py-2 font-medium">OI</th>
                  <th className="text-right px-3 py-2 font-medium">Chg OI</th>
                  <th className="text-left px-3 py-2 font-medium">Activity</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.symbol} className="border-t border-gray-800/30">
                    <td className="px-4 py-2.5 text-gray-300">{c.symbol}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-200">{formatIndianNumber(c.futuresPrice, 2)}</td>
                    <td className={`text-right px-3 py-2.5 tabular-nums ${c.basis >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {c.basis >= 0 ? '+' : ''}{c.basis.toFixed(2)}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums text-gray-300">{formatCompact(c.oi)}</td>
                    <td className={`text-right px-3 py-2.5 tabular-nums ${c.changeOi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {c.changeOi >= 0 ? '+' : ''}{formatCompact(c.changeOi)}
                    </td>
                    <td className="px-3 py-2.5"><OIBadge type={c.interpretation} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ContractCard({ contract }: { contract: FuturesData }) {
  return (
    <div className="bg-[#12121a] border border-gray-800/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-400">{EXPIRY_LABEL_TEXT[contract.expiryLabel]}</span>
        <span className="text-[10px] text-gray-500">DTE: {contract.dte}</span>
      </div>
      <div className="text-xl font-bold tabular-nums text-gray-100 mb-1">
        {formatIndianNumber(contract.futuresPrice, 2)}
      </div>
      <div className="flex items-center gap-2 mb-3">
        <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
          contract.premiumDiscountType === 'PREMIUM' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          {contract.basis >= 0 ? '+' : ''}{contract.basis.toFixed(2)} ({contract.premiumDiscount.toFixed(2)}% {contract.premiumDiscountType.toLowerCase()})
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-gray-500 mb-0.5">OI</div>
          <div className="text-gray-300 font-medium tabular-nums">{formatCompact(contract.oi)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Change OI</div>
          <div className={`font-medium tabular-nums ${contract.changeOi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {contract.changeOi >= 0 ? '+' : ''}{formatCompact(contract.changeOi)}
          </div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Volume</div>
          <div className="text-gray-300 font-medium tabular-nums">{formatCompact(contract.volume)}</div>
        </div>
        <div>
          <div className="text-gray-500 mb-0.5">Activity</div>
          <OIBadge type={contract.interpretation} />
        </div>
      </div>
      <div className="text-[10px] text-gray-600 mt-3">Expiry: {contract.expiry}</div>
    </div>
  );
}
