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
    <header className="flex items-center h-12 px-4 bg-[#0d0d14]/95 backdrop-blur border-b border-gray-800/50 shrink-0 gap-5 shadow-[0_1px_0_rgba(255,255,255,0.03)]">
      {/* Quick Index Prices */}
      <div className="flex items-center gap-4">
        <IndexChip symbol="NIFTY" price={nifty.ltp} change={nifty.change} changePercent={nifty.changePercent} />
        <div className="w-px h-5 bg-gray-800" />
        <IndexChip symbol="BANKNIFTY" price={bankNifty.ltp} change={bankNifty.change} changePercent={bankNifty.changePercent} />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Status Cluster */}
      <div className="flex items-center gap-1 bg-gray-900/40 border border-gray-800/50 rounded-full pl-3 pr-1 py-1">
        <StatusDot label={`${selectedExchange} ${marketOpen ? 'Open' : 'Closed'}`} on={marketOpen} pulse={marketOpen} />
        <Divider />
        <StatusDot label={health.websocket.connected ? 'WS' : 'WS Off'} on={health.websocket.connected} />
        <Divider />
        <StatusDot label={isLive ? 'Live' : 'Mock'} on={isLive} />
      </div>

      {/* Clock */}
      <div className="text-sm font-mono text-gray-300 tabular-nums min-w-[70px] text-right">
        {currentTime}
      </div>
    </header>
  );
}

// --- Status Cluster Helpers ---

function Divider() {
  return <div className="w-px h-3.5 bg-gray-800 mx-1" />;
}

function StatusDot({ label, on, pulse }: { label: string; on: boolean; pulse?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] px-1">
      <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-400' : 'bg-gray-600'} ${pulse ? 'animate-pulse' : ''}`} />
      <span className="text-gray-400">{label}</span>
    </div>
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
    <div className="flex items-center gap-2.5 text-xs">
      <span className="text-gray-500 font-semibold tracking-wide">{symbol}</span>
      <span className="text-gray-50 font-bold tabular-nums text-sm">
        {formatIndianNumber(price, 2)}
      </span>
      <span
        className={`font-medium tabular-nums px-1.5 py-0.5 rounded ${
          isPositive ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'
        }`}
      >
        {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)} ({formatPercent(changePercent)})
      </span>
    </div>
  );
}
