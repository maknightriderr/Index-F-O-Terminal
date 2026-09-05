'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine } from 'lightweight-charts';
import { useUISettingsStore } from '@/stores';
import { api } from '@/lib/api';
import { KNOWN_INDEX_TOKENS } from '@fno/shared';
import type { CandleInterval, Exchange } from '@fno/shared';

type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '1D' | '5D' | '1M' | '3M' | '6M' | '1Y';
type ChartMode = 'SPOT' | 'FUTURES';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '1D', '5D', '1M', '3M', '6M', '1Y'];

// A few extra calendar days of lookback beyond the nominal window covers
// weekends/holidays so the most recent trading session is never cut off.
const TIMEFRAME_CONFIG: Record<Timeframe, { interval: CandleInterval; days: number }> = {
  '1m': { interval: 'ONE_MINUTE', days: 1 },
  '5m': { interval: 'FIVE_MINUTE', days: 2 },
  '15m': { interval: 'FIFTEEN_MINUTE', days: 3 },
  '30m': { interval: 'THIRTY_MINUTE', days: 5 },
  '1H': { interval: 'ONE_HOUR', days: 10 },
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
  dark: { text: '#9ca3af', grid: 'rgba(255,255,255,0.06)', up: '#34d399', down: '#f87171', border: 'rgba(255,255,255,0.08)', support: '#34d399', resistance: '#f87171' },
  light: { text: '#475569', grid: 'rgba(15,23,42,0.06)', up: '#059669', down: '#dc2626', border: 'rgba(15,23,42,0.1)', support: '#059669', resistance: '#dc2626' },
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

export interface OiLevel {
  strike: number;
  strengthPct: number;
}

export function InstrumentChart({
  symbol,
  exchange,
  hasSpot = true,
  supportLevels = [],
  resistanceLevels = [],
}: {
  symbol: string;
  exchange: Exchange;
  hasSpot?: boolean;
  supportLevels?: OiLevel[];
  resistanceLevels?: OiLevel[];
}) {
  const theme = useUISettingsStore((s) => s.theme);
  const resolvedTheme = resolveTheme(theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [mode, setMode] = useState<ChartMode>(hasSpot ? 'SPOT' : 'FUTURES');
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [chartReady, setChartReady] = useState(false);

  // A commodity like CRUDEOIL/GOLD has no cash/spot instrument at all —
  // force Futures whenever the instrument switches to one of those.
  useEffect(() => {
    if (!hasSpot) setMode('FUTURES');
  }, [hasSpot, symbol]);

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
    setChartReady(true);

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
      setChartReady(false);
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

  // Resolve which token's candles to load — the instrument's own spot/index
  // token, or its current-month futures contract's token.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const resolveToken = async (): Promise<string | null> => {
      if (mode === 'SPOT') return KNOWN_INDEX_TOKENS[symbol] ?? null;
      try {
        const futures = await api.getFutures(symbol, exchange);
        return futures.contracts.find((c) => c.expiryLabel === 'current')?.token ?? null;
      } catch {
        return null;
      }
    };

    const { interval, days } = TIMEFRAME_CONFIG[timeframe];
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    resolveToken()
      .then((token) => {
        if (cancelled || !token) throw new Error('no token');
        return api.getHistoricalData(token, formatForApi(from), formatForApi(to), exchange, interval);
      })
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
        seriesRef.current?.setData([]);
        setHasData(false);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, timeframe, mode]);

  // Auto-drawn support/resistance — the same OI-wall levels already
  // surfaced elsewhere in the app (Market Bias's supportLevels/
  // resistanceLevels), not a separate chart-only calculation.
  useEffect(() => {
    if (!chartReady || !seriesRef.current) return;
    const series = seriesRef.current;
    const c = CHART_COLORS[resolvedTheme];

    priceLinesRef.current.forEach((line) => series.removePriceLine(line));
    priceLinesRef.current = [];

    const addLine = (price: number, color: string, title: string) => {
      if (!isFinite(price) || price <= 0) return;
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title })
      );
    };

    supportLevels.slice(0, 2).forEach((lvl, i) => addLine(lvl.strike, c.support, i === 0 ? 'Support' : `Support ${i + 1}`));
    resistanceLevels.slice(0, 2).forEach((lvl, i) => addLine(lvl.strike, c.resistance, i === 0 ? 'Resistance' : `Resistance ${i + 1}`));
  }, [chartReady, supportLevels, resistanceLevels, resolvedTheme]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-2.5 py-1 text-[11px] font-semibold rounded-md whitespace-nowrap transition-colors ${
                timeframe === tf
                  ? 'bg-indigo-500/15 text-indigo-500 light:text-indigo-700'
                  : 'text-gray-400 light:text-slate-500 hover:bg-gray-800/40 light:hover:bg-slate-100'
              }`}
            >
              {tf}
            </button>
          ))}
        </div>

        <div className="flex items-center bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200 shrink-0">
          <button
            onClick={() => hasSpot && setMode('SPOT')}
            disabled={!hasSpot}
            title={hasSpot ? undefined : 'No spot instrument for this symbol — futures/options only'}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              mode === 'SPOT' ? 'bg-indigo-500/20 text-indigo-500 light:text-indigo-700' : hasSpot ? 'text-gray-400 light:text-slate-500' : 'text-gray-700 light:text-slate-300 cursor-not-allowed'
            }`}
          >
            Spot
          </button>
          <button
            onClick={() => setMode('FUTURES')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              mode === 'FUTURES' ? 'bg-indigo-500/20 text-indigo-500 light:text-indigo-700' : 'text-gray-400 light:text-slate-500'
            }`}
          >
            Futures
          </button>
        </div>
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
