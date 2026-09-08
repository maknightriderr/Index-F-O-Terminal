'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { useUISettingsStore } from '@/stores';
import { api } from '@/lib/api';
import { useMarketTicks } from '@/lib/ws';
import { detectPattern, detectCandlestickPattern } from '@fno/analytics';
import type { DetectedPattern } from '@fno/analytics';
import { CM_SEGMENT, FO_SEGMENT, KNOWN_INDEX_TOKENS } from '@fno/shared';
import type { CandleInterval, Exchange } from '@fno/shared';

// Only genuine reversal shapes get marked. detectCandlestickPattern scores
// Morning/Evening Star at 75, Engulfing at 65, Hammer/Shooting Star at 60,
// Hanging Man/Inverted Hammer at 55 and Doji at 45 — a doji is indecision
// rather than a reversal, so 60 drops it and the weakest single-candle
// shapes.
//
// This threshold does less work than it looks like it does: measured on
// live NIFTY 15m bars it only took 15 detections down to 13. What actually
// made these markers mean something was requiring engulfing patterns to
// have a trend to reverse (see candlestick-patterns/index.ts) — that took
// the same sample from 13 marked bars to 2.
const STRONG_REVERSAL_MIN_CONFIDENCE = 60;

// A reversal has to reverse something, which means it has to sit at a
// TURNING POINT — not merely be a recognisable shape somewhere in the
// middle of a move. Requiring the bar to be the local extreme of a +-3
// window is the standard swing-pivot definition, and it is what separates
// "this candle is shaped like a hammer" from "this is where price turned".
//
// Measured on real NIFTY data, the shape test alone was nowhere near
// enough: on a 3-month daily chart it produced 5 markers of which ZERO sat
// at a swing extreme, and over a full year it marked 20 bars — roughly one
// every 13 sessions, which is why they read as noise. Adding this test
// takes that year down to 3.
const SWING_WINDOW = 3;
// Ties count. An exact float equality against the window's min/max would
// drop a bar that made the low by a hair's breadth on a later retest.
const SWING_TOLERANCE = 0.001;

/**
 * Is bar `i` the local high (bearish reversal) or low (bullish reversal)
 * of its neighbourhood?
 *
 * Near the right edge there are fewer future bars to compare against, so
 * the most recent bars are judged on a shorter window and are effectively
 * PROVISIONAL — which is honest rather than a flaw: whether a bar turned
 * out to be the turn genuinely isn't knowable until price has moved away
 * from it. A marker there can disappear on the next refresh if price makes
 * a new extreme, and that is the correct behaviour.
 */
function isSwingExtreme(
  bars: Array<{ high: number; low: number }>,
  i: number,
  direction: 'BULLISH' | 'BEARISH'
): boolean {
  const from = Math.max(0, i - SWING_WINDOW);
  const to = Math.min(bars.length, i + SWING_WINDOW + 1);
  const window = bars.slice(from, to);
  if (window.length < 2) return false;
  if (direction === 'BULLISH') {
    const lowest = Math.min(...window.map((b) => b.low));
    return bars[i].low <= lowest * (1 + SWING_TOLERANCE);
  }
  const highest = Math.max(...window.map((b) => b.high));
  return bars[i].high >= highest * (1 - SWING_TOLERANCE);
}

// How often to re-pull candles so newly-CLOSED bars appear. Live ticks
// (below) already move the current bar in real time; this only exists to
// roll it over and correct any drift, so it's tied to the bar duration
// rather than run on a fixed fast timer — a 1-minute chart genuinely needs
// a new bar each minute, a 1-year chart does not. Floored so no timeframe
// can hammer the API, which this app has already had one outage from.
const REFRESH_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 60_000,
  '15m': 120_000,
  '30m': 180_000,
  '1H': 300_000,
  '1D': 120_000,
  '5D': 300_000,
  '1M': 600_000,
  '3M': 900_000,
  '6M': 900_000,
  '1Y': 900_000,
};

function formatPatternName(pattern: string): string {
  return pattern.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');
}

type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '1D' | '5D' | '1M' | '3M' | '6M' | '1Y';
type ChartMode = 'SPOT' | 'FUTURES';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '1D', '5D', '1M', '3M', '6M', '1Y'];

// Lookback needs a real safety margin, not just "how far back this label
// implies" — a tight window can land entirely AFTER the last trading
// session ended (checking after-hours, on a weekend, the morning after a
// holiday, etc.), in which case the API correctly returns zero candles
// for that slice even though real recent data exists just outside it.
// Confirmed live: `days: 1` for '1m' returned empty because "now minus a
// day" fell after Friday's 15:30 close with no Monday session yet inside
// the window. These margins are sized to comfortably span at least one
// full recent session (a 3-4 day holiday weekend included) regardless of
// when "now" happens to fall, not just the nominal range implied by the
// button's label — fitContent() shows whatever comes back either way, so
// a slightly wider window just means a bit more scrollable history, not
// a wrong-looking chart.
const TIMEFRAME_CONFIG: Record<Timeframe, { interval: CandleInterval; days: number }> = {
  '1m': { interval: 'ONE_MINUTE', days: 5 },
  '5m': { interval: 'FIVE_MINUTE', days: 6 },
  '15m': { interval: 'FIFTEEN_MINUTE', days: 6 },
  '30m': { interval: 'THIRTY_MINUTE', days: 8 },
  '1H': { interval: 'ONE_HOUR', days: 12 },
  '1D': { interval: 'FIFTEEN_MINUTE', days: 6 },
  '5D': { interval: 'FIFTEEN_MINUTE', days: 10 },
  '1M': { interval: 'ONE_HOUR', days: 36 },
  '3M': { interval: 'ONE_DAY', days: 96 },
  '6M': { interval: 'ONE_DAY', days: 188 },
  '1Y': { interval: 'ONE_DAY', days: 372 },
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
  const patternSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const candleTimesRef = useRef<UTCTimestamp[]>([]);
  // The bar currently forming, kept so incoming ticks can extend it in
  // place rather than waiting for the next refetch.
  const lastBarRef = useRef<{ time: UTCTimestamp; open: number; high: number; low: number; close: number } | null>(null);
  const [resolvedToken, setResolvedToken] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [reversalCount, setReversalCount] = useState(0);
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [mode, setMode] = useState<ChartMode>(hasSpot ? 'SPOT' : 'FUTURES');
  const [loading, setLoading] = useState(true);
  const [hasData, setHasData] = useState(false);
  const [chartReady, setChartReady] = useState(false);
  const [detectedPattern, setDetectedPattern] = useState<DetectedPattern | null>(null);

  // A commodity like CRUDEOIL/GOLD has no cash/spot instrument at all —
  // force Futures whenever the instrument switches to one of those.
  useEffect(() => {
    if (!hasSpot) setMode('FUTURES');
  }, [hasSpot, symbol]);

  // --- Live price ---
  // The chart used to be a single fetch per symbol/timeframe with nothing
  // updating it afterwards, so it silently went stale the moment it
  // rendered. This app already runs a tick WebSocket that nothing in the UI
  // was consuming — using it means the chart moves in real time without
  // adding a single REST call, which matters here: the one previous attempt
  // to increase polling load took the whole backend down with broker rate
  // limiting.
  const tickTargets = React.useMemo(
    () =>
      resolvedToken
        ? [{ token: resolvedToken, exchange, exchangeSegment: mode === 'SPOT' ? CM_SEGMENT[exchange] : FO_SEGMENT[exchange] }]
        : [],
    [resolvedToken, exchange, mode]
  );
  const ticks = useMarketTicks(tickTargets);
  const liveTick = resolvedToken ? ticks[resolvedToken] : undefined;

  // Extend the forming bar with each tick: a new high/low if the tick made
  // one, and the latest price as its close. Deliberately does NOT invent a
  // new bar when the interval rolls over — the refresh below brings that
  // from the source rather than guessing where a bar boundary falls.
  useEffect(() => {
    if (!liveTick || !seriesRef.current || !lastBarRef.current) return;
    const bar = lastBarRef.current;
    const ltp = liveTick.ltp;
    if (!isFinite(ltp) || ltp <= 0) return;
    bar.high = Math.max(bar.high, ltp);
    bar.low = Math.min(bar.low, ltp);
    bar.close = ltp;
    seriesRef.current.update(bar);
  }, [liveTick]);

  // Roll in newly-closed bars. Cadence follows the timeframe (see REFRESH_MS).
  useEffect(() => {
    const id = setInterval(() => setRefreshTick((n) => n + 1), REFRESH_MS[timeframe]);
    return () => clearInterval(id);
  }, [timeframe]);

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
      patternSeriesRef.current = [];
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
    // A periodic refresh must not look like a fresh load: showing the
    // skeleton and re-running fitContent() every minute would blank the
    // chart and throw away whatever the user had zoomed or scrolled to.
    const isRefresh = refreshTick > 0 && seriesRef.current != null && candleTimesRef.current.length > 0;
    if (!isRefresh) setLoading(true);

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
        setResolvedToken(token);
        return api.getHistoricalData(token, formatForApi(from), formatForApi(to), exchange, interval);
      })
      .then((candles: any[]) => {
        if (cancelled || !seriesRef.current) return;
        const data = candles.map((c) => ({
          time: Math.floor(new Date(c.timestamp).getTime() / 1000) as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }));
        seriesRef.current.setData(data);
        if (!isRefresh) chartRef.current?.timeScale().fitContent();
        candleTimesRef.current = data.map((d) => d.time);
        lastBarRef.current = data.length > 0 ? { ...data[data.length - 1] } : null;
        setHasData(data.length > 0);
        setLoading(false);

        // --- Strong reversal candles ---
        // detectCandlestickPattern only ever reports the most recent match
        // in whatever array it's given, so walking the series and asking it
        // about each bar in turn is what turns a single "what is it doing
        // now" read into every reversal visible on screen. Kept to the
        // bar it actually confirms on (atIndex === i) so a pattern isn't
        // re-reported on each later bar it's still technically inside.
        const ohlc = candles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }));
        const markers: Array<{ time: UTCTimestamp; position: 'aboveBar' | 'belowBar'; color: string; shape: 'arrowUp' | 'arrowDown'; text: string }> = [];
        const cc = CHART_COLORS[resolvedTheme];
        for (let i = 2; i < ohlc.length; i++) {
          const hit = detectCandlestickPattern(ohlc.slice(0, i + 1) as any);
          if (!hit || hit.atIndex !== i || hit.confidence < STRONG_REVERSAL_MIN_CONFIDENCE) continue;
          // The shape is necessary but nowhere near sufficient — it also has
          // to be where price actually turned. See isSwingExtreme.
          if (!isSwingExtreme(ohlc, i, hit.direction)) continue;
          const bullish = hit.direction === 'BULLISH';
          markers.push({
            time: data[i].time,
            position: bullish ? 'belowBar' : 'aboveBar',
            color: bullish ? cc.up : cc.down,
            shape: bullish ? 'arrowUp' : 'arrowDown',
            text: formatPatternName(hit.pattern),
          });
        }
        seriesRef.current.setMarkers(markers);
        setReversalCount(markers.length);

        // Pattern detection runs on these EXACT candles — whatever timeframe
        // is on screen is what gets checked, not a separate fixed window —
        // so switching timeframes re-detects fresh rather than reusing a
        // stale read from a different interval/range.
        setDetectedPattern(
          data.length >= 15
            ? detectPattern(candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), candles.map((c) => c.volume))
            : null
        );
      })
      .catch(() => {
        if (cancelled) return;
        seriesRef.current?.setData([]);
        setHasData(false);
        setDetectedPattern(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, timeframe, mode, refreshTick, resolvedTheme]);

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

  // Draw whatever pattern was just detected on THIS timeframe's candles —
  // each line is a real 2-point trendline segment (lightweight-charts v4
  // has no native trendline primitive, so a 2-data-point Line series is
  // the standard way to draw one), not a full-width price line, since a
  // triangle/wedge/channel's boundaries are sloped, not horizontal.
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = chartRef.current;

    patternSeriesRef.current.forEach((s) => chart.removeSeries(s));
    patternSeriesRef.current = [];

    if (!detectedPattern?.lines) return;
    const times = candleTimesRef.current;
    const c = CHART_COLORS[resolvedTheme];
    const color = detectedPattern.direction === 'BULLISH' ? c.support : c.resistance;

    for (const line of detectedPattern.lines) {
      const fromTime = times[line.from.index];
      const toTime = times[line.to.index];
      if (fromTime == null || toTime == null) continue;
      const series = chart.addLineSeries({
        color,
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        title: line.label,
      });
      series.setData([
        { time: fromTime, value: line.from.price },
        { time: toTime, value: line.to.price },
      ]);
      patternSeriesRef.current.push(series);
    }
  }, [detectedPattern, resolvedTheme]);

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
                  : 'text-gray-400 light:text-slate-600 hover:bg-gray-800/40 light:hover:bg-slate-100'
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
              mode === 'SPOT' ? 'bg-indigo-500/20 text-indigo-500 light:text-indigo-700' : hasSpot ? 'text-gray-400 light:text-slate-600' : 'text-gray-700 light:text-slate-300 cursor-not-allowed'
            }`}
          >
            Spot
          </button>
          <button
            onClick={() => setMode('FUTURES')}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
              mode === 'FUTURES' ? 'bg-indigo-500/20 text-indigo-500 light:text-indigo-700' : 'text-gray-400 light:text-slate-600'
            }`}
          >
            Futures
          </button>
        </div>
      </div>

      <div ref={containerRef} className="w-full h-[360px] relative">
        {(loading || !hasData) && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 light:text-slate-600 pointer-events-none">
            {loading ? 'Loading chart…' : 'No chart data for this range'}
          </div>
        )}
        {detectedPattern && (
          <div
            className={`absolute top-2 left-2 px-2.5 py-1.5 rounded-lg badge-glass text-[11px] font-semibold pointer-events-none ${
              detectedPattern.direction === 'BULLISH' ? 'bg-emerald-500/15 text-emerald-500 light:text-emerald-700' : 'bg-red-500/15 text-red-500 light:text-red-700'
            }`}
          >
            {formatPatternName(detectedPattern.pattern)} · {detectedPattern.direction === 'BULLISH' ? '▲' : '▼'} {detectedPattern.confidence}%
          </div>
        )}

        {/* Live state and reversal count. The chart had no indication of
            whether it was updating, so a stale chart and a quiet market
            looked identical — the same failure mode as the scanner's
            silent declines. */}
        {hasData && (
          <div className="absolute top-2 right-2 flex items-center gap-2 pointer-events-none">
            {reversalCount > 0 && (
              <span className="px-2 py-1 rounded-lg badge-glass text-[10px] font-semibold text-gray-300 light:text-slate-700">
                {reversalCount} reversal{reversalCount === 1 ? '' : 's'}
              </span>
            )}
            <span
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg badge-glass text-[10px] font-semibold ${
                liveTick ? 'text-emerald-400 light:text-emerald-700' : 'text-gray-400 light:text-slate-600'
              }`}
              title={
                liveTick
                  ? 'Streaming live ticks — the forming candle updates in real time'
                  : 'No live ticks for this instrument right now; candles still refresh periodically'
              }
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full ${liveTick ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500 light:bg-slate-400'}`}
              />
              {liveTick ? 'Live' : 'Delayed'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
