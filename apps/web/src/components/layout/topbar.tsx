'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useMarketStore, useSystemHealthStore, useUISettingsStore } from '@/stores';
import type { ThemeName } from '@/stores';
import { formatIndianNumber, formatPercent, isMarketOpen } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { useLiveIndices } from '@/lib/use-live-indices';
import { AlertBell } from './alert-bell';
import { Sparkline } from '@/components/common/sparkline';
import { getPriceHistory } from '@/lib/price-history-store';

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
    <header className="flex items-center h-12 px-4 bg-[#0b0b12]/95 light:bg-white/95 backdrop-blur-sm border-b border-gray-800/40 light:border-slate-200 shrink-0 gap-5 shadow-[0_1px_0_rgba(255,255,255,0.02)] light:shadow-[0_1px_0_rgba(0,0,0,0.03)] relative z-10">
      {/* Quick Index Prices */}
      <div className="flex items-center gap-4">
        <IndexChip symbol="NIFTY" price={nifty.ltp} change={nifty.change} changePercent={nifty.changePercent} />
        <div className="w-px h-5 bg-gradient-to-b from-transparent via-gray-700 to-transparent light:via-slate-300" />
        <IndexChip symbol="BANKNIFTY" price={bankNifty.ltp} change={bankNifty.change} changePercent={bankNifty.changePercent} />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Status Cluster */}
      <div className="flex items-center gap-1 bg-gray-900/50 light:bg-slate-100 border border-gray-800/40 light:border-slate-200 rounded-full pl-3 pr-1 py-1 backdrop-blur-sm">
        <StatusDot label={`${selectedExchange} ${marketOpen ? 'Open' : 'Closed'}`} on={marketOpen} pulse={marketOpen} />
        <Divider />
        <StatusDot label={health.websocket.connected ? 'WS' : 'WS Off'} on={health.websocket.connected} />
        <Divider />
        <StatusDot label={isLive ? 'Live' : 'Mock'} on={isLive} pulse={isLive} />
      </div>

      <AlertBell />

      <ThemeSwitcher />

      {/* Clock — JetBrains Mono with subtle glow */}
      <div className="text-sm font-mono text-gray-300 light:text-slate-600 tabular-nums min-w-[70px] text-right tracking-wide" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        {currentTime.split(':').map((part, i) => (
          <span key={i}>
            {i > 0 && <span className="animate-colon-blink">:</span>}
            {part}
          </span>
        ))}
      </div>
    </header>
  );
}

// --- Theme Switcher ---

const THEME_OPTIONS: Array<{ value: ThemeName; icon: string; label: string }> = [
  { value: 'dark', icon: '🌙', label: 'Dark' },
  { value: 'light', icon: '☀️', label: 'Light' },
  { value: 'system', icon: '🖥️', label: 'System' },
];

function ThemeSwitcher() {
  const { theme, setTheme } = useUISettingsStore();

  return (
    <div className="flex items-center gap-0.5 bg-gray-900/50 light:bg-slate-100 border border-gray-800/40 light:border-slate-200 rounded-full p-0.5 backdrop-blur-sm">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => setTheme(opt.value)}
          title={opt.label}
          className={`w-6 h-6 flex items-center justify-center rounded-full text-[11px] transition-all duration-200 ${
            theme === opt.value
              ? 'bg-emerald-500/20 light:bg-emerald-500/15 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.35),0_0_8px_-2px_rgba(16,185,129,0.3)] scale-110'
              : 'hover:bg-gray-800/60 light:hover:bg-slate-200/70 hover:scale-105'
          }`}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

// --- Status Cluster Helpers ---

function Divider() {
  return <div className="w-px h-3.5 bg-gradient-to-b from-transparent via-gray-700 to-transparent light:via-slate-300 mx-1" />;
}

function StatusDot({ label, on, pulse }: { label: string; on: boolean; pulse?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] px-1">
      <span className="relative flex items-center justify-center">
        <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-400' : 'bg-gray-600 light:bg-slate-400'}`} />
        {/* Outer ring */}
        {on && (
          <span className="absolute inset-[-2px] rounded-full border border-emerald-400/30" />
        )}
        {/* Pulsing ring */}
        {pulse && on && (
          <span className="absolute inset-[-2px] rounded-full border border-emerald-400/40 animate-breathe" />
        )}
      </span>
      <span className={`${on ? 'text-gray-300 light:text-slate-700' : 'text-gray-500 light:text-slate-500'}`}>{label}</span>
    </div>
  );
}

// --- Index Chip Component (with Sparkline & Flash) ---

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
  const prevPriceRef = useRef(price);
  const [flashClass, setFlashClass] = useState('');

  useEffect(() => {
    if (prevPriceRef.current !== price) {
      const direction = price > prevPriceRef.current ? 'animate-flash-green' : 'animate-flash-red';
      setFlashClass(direction);
      prevPriceRef.current = price;
      const timer = setTimeout(() => setFlashClass(''), 600);
      return () => clearTimeout(timer);
    }
  }, [price]);

  return (
    <div className={`flex items-center gap-2.5 text-xs rounded-lg px-2 py-1 -mx-1 ${flashClass} transition-colors`}>
      <Sparkline
        data={getPriceHistory(symbol)}
        symbol={symbol}
        width={32}
        height={16}
        color={isPositive ? '#34d399' : '#f87171'}
        showArea={false}
        strokeWidth={1.2}
        points={20}
      />
      <span className="text-gray-500 light:text-slate-500 font-semibold tracking-wide">{symbol}</span>
      <span className={`text-gray-50 light:text-slate-900 font-bold tabular-nums text-sm ${isPositive ? 'text-glow-emerald' : 'text-glow-red'}`}>
        {formatIndianNumber(price, 2)}
      </span>
      <span
        className={`font-medium tabular-nums px-1.5 py-0.5 rounded-md badge-glass ${
          isPositive ? 'text-emerald-400 light:text-emerald-700 bg-emerald-500/10' : 'text-red-400 light:text-red-700 bg-red-500/10'
        }`}
      >
        {isPositive ? '▲' : '▼'} {Math.abs(change).toFixed(2)} ({formatPercent(changePercent)})
      </span>
    </div>
  );
}
