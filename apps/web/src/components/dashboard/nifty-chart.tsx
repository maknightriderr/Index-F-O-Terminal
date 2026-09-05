'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useUISettingsStore } from '@/stores';
import { api } from '@/lib/api';
import { KNOWN_INDEX_TOKENS } from '@fno/shared';
import type { CandleInterval } from '@fno/shared';

type Timeframe = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y';

const TIMEFRAMES: Timeframe[] = ['1D', '5D', '1M', '3M', '6M', '1Y'];

// A few extra calendar days of lookback beyond the nominal window covers
// weekends/holidays so the most recent trading session is never cut off.
const TIMEFRAME_CONFIG: Record<Timeframe, { interval: CandleInterval; days: number }> = {
  '1D': { interval: 'FIFTEEN_MINUTE', days: 4 },
  '5D': { interval: 'FIFTEEN_MINUTE', days: 9 },
  '1M': { interval: 'ONE_HOUR', days: 34 },
  '3M': { interval: 'ONE_DAY', days: 95 },
  '6M': { interval: 'ONE_DAY', days: 186 },
  '1Y': { interval: 'ONE_DAY', days: 370 },
};

// Same positive/negative language as the rest of the app (--positive/
// --negative tokens in globals.css) — lightweight-charts takes JS color
// values, not CSS custom properties, so these are kept in sync by hand.
const CHART_COLORS = {
  dark: { text: '#9ca3af', grid: 'rgba(255,255,255,0.06)', up: '#34d399', down: '#f87171', border: 'rgba(255,255,255,0.08)' },
  light: { text: '#475569', grid: 'rgba(15,23,42,0.06)', up: '#059669', down: '#dc2626', border: 'rgba(15,23,42,0.1)' },
};

function formatForApi(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resolveTheme(theme: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (theme !== 'system') return theme;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function NiftyChart({ symbol = 'NIFTY', exchange = 'NSE' }: { symbol?: string; exchange?: string }) {
  const theme = useUISettingsStore((s) => s.theme);
  const resolvedTheme = resolveTheme(theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);

  // Chart instance created once per mount, not per theme/timeframe change —
  // recreating it on every render would drop zoom/scroll state and flicker.
  useEffect(() => {
    if (!containerRef.current) return;
    const c = CHART_COLORS[resolvedTheme];
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme in place on toggle, without tearing down/recreating the chart.
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;
    const c = CHART_COLORS[resolvedTheme];
    chartRef.current.applyOptions({
      layout: { textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
    });
    seriesRef.current.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
  }, [resolvedTheme]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const token = KNOWN_INDEX_TOKENS[symbol] ?? symbol;
    const { interval, days } = TIMEFRAME_CONFIG[timeframe];
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    api
      .getHistoricalData(token, formatForApi(from), formatForApi(to), exchange, interval)
      .then((candles: any[]) => {
        if (cancelled || !seriesRef.current) return;
        const data = candles.map((c) => ({
          time: Math.floor(new Date(c.timestamp).getTime() / 1000) as any,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        seriesRef.current.setData(data);
        chartRef.current?.timeScale().fitContent();
        setHasData(data.length > 0);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setHasData(false);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, timeframe]);

  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              timeframe === tf
                ? 'bg-indigo-500/15 text-indigo-500 light:text-indigo-700'
                : 'text-gray-400 light:text-slate-500 hover:bg-gray-800/40 light:hover:bg-slate-100'
            }`}
          >
            {tf}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="w-full h-[360px] relative">
        {(loading || !hasData) && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 light:text-slate-400 pointer-events-none">
            {loading ? 'Loading chart…' : 'No chart data for this range'}
          </div>
        )}
      </div>
    </div>
  );
}
