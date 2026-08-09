'use client';

import React, { useState, useEffect } from 'react';
import { useMarketStore, useSystemHealthStore } from '@/stores';
import { formatIndianNumber, formatPercent, isMarketOpen } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { useLiveIndices } from '@/lib/use-live-indices';

export function TopBar() {
  const { selectedExchange } = useMarketStore();
  const { health } = useSystemHealthStore();
  const [currentTime, setCurrentTime] = useState('');
  const [marketOpen, setMarketOpen] = useState(() => isMarketOpen(selectedExchange as Exchange));

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(
        new Date().toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
      setMarketOpen(isMarketOpen(selectedExchange as Exchange));
    }, 1000);
    return () => clearInterval(timer);
  }, [selectedExchange]);

  const { indices, isLive } = useLiveIndices();
  const nifty = indices.find((i) => i.symbol === 'NIFTY') ?? indices[0];
  const bankNifty = indices.find((i) => i.symbol === 'BANKNIFTY') ?? indices[1];

  return (
    <header className="flex items-center h-12 px-4 bg-[#0d0d14] border-b border-gray-800/50 shrink-0 gap-4">
      {/* Quick Index Prices */}
      <div className="flex items-center gap-5">
        <IndexChip symbol="NIFTY" price={nifty.ltp} change={nifty.change} changePercent={nifty.changePercent} />
        <IndexChip symbol="BANKNIFTY" price={bankNifty.ltp} change={bankNifty.change} changePercent={bankNifty.changePercent} />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Market Status */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`w-2 h-2 rounded-full ${marketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}`} />
        <span className="text-gray-400">
          {selectedExchange} {marketOpen ? 'Market Open' : 'Market Closed'}
        </span>
      </div>

      {/* WebSocket Status */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`w-2 h-2 rounded-full ${
          health.websocket.connected ? 'bg-emerald-400' : 'bg-red-400'
        }`} />
        <span className="text-gray-400">
          {health.websocket.connected ? 'WS Connected' : 'WS Disconnected'}
        </span>
      </div>

      {/* Data Freshness — reflects the REST-polled index quotes (the live
          mechanism actually in use right now; WS tick display is off, see
          option-chain/futures pages) rather than WS subscription state. */}
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`w-2 h-2 rounded-full ${isLive ? 'bg-emerald-400' : 'bg-red-400'}`} />
        <span className="text-gray-400">{isLive ? 'Live' : 'Mock Data'}</span>
      </div>

      {/* Clock */}
      <div className="text-sm font-mono text-gray-300 tabular-nums min-w-[70px] text-right">
        {currentTime}
      </div>
    </header>
  );
}

// --- Index Chip Component ---

function IndexChip({
  symbol,
  price,
  change,
  changePercent,
}: {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
}) {
  const isPositive = change >= 0;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-gray-400 font-medium">{symbol}</span>
      <span className="text-gray-100 font-semibold tabular-nums">
        {formatIndianNumber(price, 2)}
      </span>
      <span
        className={`font-medium tabular-nums ${
          isPositive ? 'text-emerald-400' : 'text-red-400'
        }`}
      >
        {isPositive ? '+' : ''}{change.toFixed(2)} ({formatPercent(changePercent)})
      </span>
    </div>
  );
}
