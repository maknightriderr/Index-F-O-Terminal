'use client';
/* eslint-disable react-hooks/set-state-in-effect -- state is reset or loaded when an input changes; behaviour verified in production, not restructured */
import type { LooseJson } from '@/lib/loose-json';

import { closedChartBars, swingConfirmationIndex } from '@/lib/chart-confirmation';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp } from 'lightweight-charts';
import { chartCrosshairIst, chartTickIst } from '@/lib/chart-time';
import { useUISettingsStore } from '@/stores';
import { equityChartToken } from '@/lib/fno-radar';
import { api } from '@/lib/api';
import { useMarketTicks } from '@/lib/ws';
import { detectPattern, detectCandlestickPattern } from '@fno/analytics';
import type { DetectedPattern } from '@fno/analytics';
import { CM_SEGMENT, FO_SEGMENT, KNOWN_INDEX_TOKENS, isMarketOpen } from '@fno/shared';
import type { Exchange } from '@fno/shared';
import { buildChartZones, selectChartZones, type ChartZone } from '@/lib/chart-zones';
import { ChartZonePrimitive } from '@/lib/chart-zone-primitive';
import type { ChartOverlayLine, OverlayTone } from '@/lib/chart-overlays';
import { aggregateWeekly, cleanBars, CHART_INTERVALS, INTERVAL_CONFIG, rangesFor, rangeStart, type Bar, type ChartInterval, type ChartRange } from '@/lib/chart-bars';

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

function formatPatternName(pattern: string): string {
  return pattern.split('_').map((w) => w[0] + w.slice(1).toLowerCase()).join(' ');
}

type ChartMode = 'SPOT' | 'FUTURES';

// Same positive/negative language as the rest of the app (--positive/
// --negative tokens in globals.css) — lightweight-charts takes JS color
// values, not CSS custom properties, so these are kept in sync by hand.
const CHART_COLORS = {
  dark: { text: '#919ba8', grid: 'rgba(145,155,168,0.08)', up: '#34d399', down: '#ff6b6b', border: '#232b35', support: '#34d399', resistance: '#ff6b6b' },
  light: { text: '#56606d', grid: 'rgba(86,96,109,0.08)', up: '#08754a', down: '#b42318', border: '#dde1e6', support: '#08754a', resistance: '#b42318' },
};

// Overlay line colours by meaning (same hues as the status tokens; JS values because the chart cannot read CSS variables).
const OVERLAY_COLORS: Record<'dark' | 'light', Record<OverlayTone, string>> = {
  dark: { support: '#34d399', resistance: '#f87171', vwap: '#22d3ee', liquidity: '#a78bfa', zone: '#fbbf24', entry: '#a5b4fc', stop: '#f87171', target: '#34d399' },
  light: { support: '#059669', resistance: '#dc2626', vwap: '#0891b2', liquidity: '#7c3aed', zone: '#b45309', entry: '#4338ca', stop: '#dc2626', target: '#047857' },
};
const DASH_STYLE = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted } as const;

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
  overlayLines,
}: {
  symbol: string;
  exchange: Exchange;
  hasSpot?: boolean;
  supportLevels?: OiLevel[];
  resistanceLevels?: OiLevel[];
  /** The overlays to draw (already filtered to the groups switched on). When given, the legacy support / resistance props are ignored. */
  overlayLines?: ChartOverlayLine[];
}) {
  const theme = useUISettingsStore((s) => s.theme);
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() => resolveTheme('system'));
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => setSystemTheme(media.matches ? 'light' : 'dark');
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const resolvedTheme = theme === 'system' ? systemTheme : theme;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const zonesPrimitive = useRef<ChartZonePrimitive | null>(null);
  const [zoneData, setZoneData] = useState<{ identity: string; zones: ChartZone[]; reason: string | null }>({ identity: '', zones: [], reason: null });
  const [showOb, setShowOb] = useState(true);
  const [showFvg, setShowFvg] = useState(true);
  const [showZoneHistory, setShowZoneHistory] = useState(false);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const [hasVolume, setHasVolume] = useState(false);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const patternSeriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const candleTimesRef = useRef<UTCTimestamp[]>([]);
  // The bar currently forming, kept so incoming ticks can extend it in
  // place rather than waiting for the next refetch.
  const lastBarRef = useRef<{ time: UTCTimestamp; open: number; high: number; low: number; close: number } | null>(null);
  // What the chart is currently showing, so a re-run of the fetch effect can
  // tell a periodic refresh apart from an actual instrument/timeframe change.
  const identityRef = useRef<string>('');
  const [resolvedToken, setResolvedToken] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [reversalCount, setReversalCount] = useState(0);
  const [interval, setIntervalChoice] = useState<ChartInterval>('15m');
  const [range, setRange] = useState<ChartRange>(INTERVAL_CONFIG['15m'].defaultRange);
  const barsRef = useRef<Bar[]>([]);
  const [legend, setLegend] = useState<Bar | null>(null);
  const [latestBar, setLatestBar] = useState<Bar | null>(null);
  // Set by the view helper below; the resize observer and the fetch effect call it.
  const applyViewRef = useRef<() => void>(() => {});
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

  // Roll in newly-closed bars. Cadence follows the interval (INTERVAL_CONFIG.refreshMs).
  useEffect(() => {
    const id = setInterval(() => setRefreshTick((n) => n + 1), INTERVAL_CONFIG[interval].refreshMs);
    return () => clearInterval(id);
  }, [interval]);

  // Chart instance created once per mount, not per theme/timeframe change —
  // recreating it on every render would drop zoom/scroll state and flicker.
  useEffect(() => {
    if (!containerRef.current) return;
    const c = CHART_COLORS[resolvedTheme];
    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      localization: { locale: 'en-IN', timeFormatter: chartCrosshairIst },
      timeScale: { borderColor: c.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: chartTickIst },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    const volume = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    volumeRef.current = volume;
    const zonePrimitive = new ChartZonePrimitive();
    series.attachPrimitive(zonePrimitive);
    zonesPrimitive.current = zonePrimitive;
    chartRef.current = chart;
    seriesRef.current = series;
    // OHLC legend: the hovered candle, or the latest one when the pointer leaves.
    chart.subscribeCrosshairMove((param) => {
      const d = param.time != null ? (param.seriesData.get(series) as { open?: number; high?: number; low?: number; close?: number } | undefined) : undefined;
      if (d && d.open != null && d.high != null && d.low != null && d.close != null) setLegend({ time: param.time as number, open: d.open, high: d.high, low: d.low, close: d.close });
      else setLegend(null);
    });
    // A chart first laid out while hidden (inactive tab, collapsed panel) has width 0, so its view was computed for
    // nothing; re-apply the view the moment it gets a real width.
    let lastWidth = containerRef.current.clientWidth;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (lastWidth === 0 && w > 0) applyViewRef.current();
      lastWidth = w;
    });
    observer.observe(containerRef.current);
    setChartReady(true);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      zonesPrimitive.current = null;
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
      rightPriceScale: { borderColor: c.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderColor: c.border },
    });
    seriesRef.current.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
  }, [resolvedTheme]);

  // The view for the selected range: price axis back on auto-scale, time axis on the range (or everything).
  const applyView = React.useCallback(() => {
    const chart = chartRef.current, bars = barsRef.current;
    if (!chart || bars.length === 0) return;
    chart.priceScale('right').applyOptions({ autoScale: true });
    const from = rangeStart(bars, range);
    if (from == null) chart.timeScale().fitContent();
    else chart.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: (bars[bars.length - 1].time + INTERVAL_CONFIG[interval].seconds) as UTCTimestamp });
  }, [range, interval]);
  useEffect(() => {
    applyViewRef.current = applyView;
    applyView();
  }, [applyView]);

  // Resolve which token's candles to load — the instrument's own spot/index
  // token, or its current-month futures contract's token.
  useEffect(() => {
    let cancelled = false;
    // A periodic refresh must not look like a fresh load: showing the
    // skeleton and re-running fitContent() every minute would blank the
    // chart and throw away whatever the user had zoomed or scrolled to.
    //
    // What counts as "refresh" has to be decided by WHAT CHANGED, not by
    // whether the timer has ever fired. The first version tested
    // `refreshTick > 0`, which is true forever after the first tick — so a
    // minute into a session every symbol and timeframe switch was being
    // treated as a refresh and silently skipped fitContent(), which is
    // exactly the "chart doesn't adjust when I switch" symptom.
    const identity = `${symbol}|${exchange}|${interval}|${mode}`;
    const isRefresh = identityRef.current === identity && seriesRef.current != null && candleTimesRef.current.length > 0;
    identityRef.current = identity;
    if (!isRefresh) setLoading(true);

    const resolveToken = async (): Promise<string | null> => {
      if (mode === 'SPOT') {
        if (KNOWN_INDEX_TOKENS[symbol]) return KNOWN_INDEX_TOKENS[symbol];
        return equityChartToken(await api.searchInstruments(symbol, exchange, 'CM'), symbol, exchange);
      }
      try {
        const futures = await api.getFutures(symbol, exchange);
        return futures.contracts.find((c) => c.expiryLabel === 'current')?.token ?? null;
      } catch {
        return null;
      }
    };

    const { broker, days, seconds: intervalSeconds } = INTERVAL_CONFIG[interval];
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

    resolveToken()
      .then((token) => {
        if (cancelled || !token) throw new Error('no token');
        setResolvedToken(token);
        return api.getHistoricalData(token, formatForApi(from), formatForApi(to), exchange, broker, mode === 'FUTURES' ? 'FO' : 'CM');
      })
      .then((rows: Parameters<typeof cleanBars>[0]) => {
        if (cancelled || !seriesRef.current) return;
        // Sorted, de-duplicated candles; weekly candles are built from the daily ones.
        const clean = cleanBars(rows);
        const bars = interval === '1W' ? aggregateWeekly(clean) : clean;
        const candles = bars.map((b) => ({ ...b, volume: b.volume ?? 0, rawVolume: b.volume }));
        const data = bars.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close }));
        seriesRef.current.setData(data);
        barsRef.current = bars;
        setLatestBar(bars.length ? bars[bars.length - 1] : null);
        setZoneData({ identity, ...buildChartZones(data, intervalSeconds, Date.now() / 1000) });
        // Only actual reported candle volume; missing/invalid values are gaps.
        const volumeColors = CHART_COLORS[resolvedTheme];
        const volumeData = candles.flatMap((c, i) => typeof c.rawVolume === 'number' && Number.isFinite(c.rawVolume) && c.rawVolume >= 0 ? [{ time: data[i].time, value: c.rawVolume, color: `${c.close >= c.open ? volumeColors.up : volumeColors.down}66` }] : []);
        volumeRef.current?.setData(volumeData);
        setHasVolume(volumeData.some((bar) => bar.value > 0));
        if (!isRefresh) applyViewRef.current();
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
        const closedData = closedChartBars(data, intervalSeconds, Date.now() / 1000);
        const closedCandles = candles.slice(0, closedData.length);
        const ohlc = closedCandles.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 }));
        const markers: Array<{ time: UTCTimestamp; position: 'aboveBar' | 'belowBar'; color: string; shape: 'arrowUp' | 'arrowDown'; text: string }> = [];
        const cc = CHART_COLORS[resolvedTheme];
        for (let i = 2; i < ohlc.length; i++) {
          const hit = detectCandlestickPattern(ohlc.slice(0, i + 1) as LooseJson);
          if (!hit || hit.atIndex !== i || hit.confidence < STRONG_REVERSAL_MIN_CONFIDENCE) continue;
          // The shape is necessary but nowhere near sufficient — it also has
          // to be where price actually turned. See isSwingExtreme.
          const confirmedAt = swingConfirmationIndex(ohlc, i, hit.direction);
          if (confirmedAt == null) continue;
          const bullish = hit.direction === 'BULLISH';
          markers.push({
            time: data[confirmedAt].time,
            position: bullish ? 'belowBar' : 'aboveBar',
            color: bullish ? cc.up : cc.down,
            shape: bullish ? 'arrowUp' : 'arrowDown',
            // This is when the swing became confirmable, not an entry at the earlier extreme.
            text: 'Confirmed',
          });
        }
        seriesRef.current.setMarkers(markers);
        setReversalCount(markers.length);

        // Pattern detection runs on these EXACT candles — whatever timeframe
        // is on screen is what gets checked, not a separate fixed window —
        // so switching timeframes re-detects fresh rather than reusing a
        // stale read from a different interval/range.
        setDetectedPattern(
          closedCandles.length >= 15
            ? detectPattern(closedCandles.map((c) => c.high), closedCandles.map((c) => c.low), closedCandles.map((c) => c.close), closedCandles.map((c) => c.volume))
            : null
        );
      })
      .catch(() => {
        if (cancelled) return;
        seriesRef.current?.setData([]);
        barsRef.current = [];
        setLatestBar(null);
        volumeRef.current?.setData([]);
        setHasVolume(false);
        setHasData(false);
        setZoneData({ identity, zones: [], reason: 'Candle history unavailable.' });
        setDetectedPattern(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, interval, mode, refreshTick, resolvedTheme]);

  const chartIdentity = `${symbol}|${exchange}|${interval}|${mode}`;
  const matchingZones = zoneData.identity === chartIdentity ? zoneData.zones : [];
  const visibleZones = React.useMemo(() => selectChartZones(zoneData.identity === chartIdentity ? zoneData.zones : [], showOb, showFvg, showZoneHistory), [zoneData, chartIdentity, showOb, showFvg, showZoneHistory]);
  useEffect(() => { zonesPrimitive.current?.setZones(visibleZones, resolvedTheme === 'light'); }, [visibleZones, resolvedTheme, chartReady]);

  // Auto-drawn support/resistance — the same OI-wall levels already
  // surfaced elsewhere in the app (Market Bias's supportLevels/
  // resistanceLevels), not a separate chart-only calculation.
  useEffect(() => {
    if (!chartReady || !seriesRef.current) return;
    const series = seriesRef.current;
    const c = CHART_COLORS[resolvedTheme];

    priceLinesRef.current.forEach((line) => series.removePriceLine(line));
    priceLinesRef.current = [];

    const addLine = (price: number, color: string, title: string, style: keyof typeof DASH_STYLE = 'dashed') => {
      if (!isFinite(price) || price <= 0) return;
      priceLinesRef.current.push(
        series.createPriceLine({ price, color, lineWidth: 1, lineStyle: DASH_STYLE[style], axisLabelVisible: true, title })
      );
    };

    // Snapshot overlays are spot-based for NSE/BSE; do not put them on a futures price scale.
    if (hasSpot && mode === 'FUTURES') return;
    if (overlayLines) {
      const oc = OVERLAY_COLORS[resolvedTheme];
      overlayLines.forEach((l) => addLine(l.price, oc[l.tone], l.label, l.dash));
      return;
    }
    supportLevels.slice(0, 2).forEach((lvl, i) => addLine(lvl.strike, c.support, i === 0 ? 'Support' : `Support ${i + 1}`));
    resistanceLevels.slice(0, 2).forEach((lvl, i) => addLine(lvl.strike, c.resistance, i === 0 ? 'Resistance' : `Resistance ${i + 1}`));
  }, [chartReady, supportLevels, resistanceLevels, overlayLines, resolvedTheme, hasSpot, mode]);

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
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div role="group" aria-label="Candle interval" className="flex items-center gap-1 overflow-x-auto scrollbar-none">
            {CHART_INTERVALS.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => {
                  setIntervalChoice(tf);
                  setRange(INTERVAL_CONFIG[tf].defaultRange);
                }}
                aria-pressed={interval === tf}
                title={`${tf} candles`}
                className={`px-2.5 py-1 text-xs font-semibold rounded-md whitespace-nowrap transition-colors ${interval === tf ? 'bg-[var(--desk-accent)]/10 text-[var(--desk-accent)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-card-alt)]'}`}
              >
                {tf}
              </button>
            ))}
          </div>
          <span aria-hidden="true" className="h-4 w-px bg-[var(--border-secondary)]" />
          <div role="group" aria-label="Visible range" className="flex items-center gap-1 overflow-x-auto scrollbar-none">
            {rangesFor(interval).map((r) => (
              <button key={r} type="button" onClick={() => setRange(r)} aria-pressed={range === r} title={r === 'ALL' ? 'All loaded history' : `Last ${r}`} className={`px-2 py-1 text-[11px] font-medium rounded-md whitespace-nowrap ${range === r ? 'text-[var(--text-primary)] bg-[var(--surface-card-alt)]' : 'text-[var(--text-muted)] hover:bg-[var(--surface-card-alt)]'}`}>
                {r === 'ALL' ? 'All' : r}
              </button>
            ))}
            <button type="button" onClick={() => applyView()} title="Reset zoom and price scale" aria-label="Reset chart view" className="px-2 py-1 text-[11px] font-medium rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-card-alt)]">
              ⟲ Fit
            </button>
          </div>
        </div>

        <div className="flex items-center bg-gray-900/60 light:bg-slate-100 p-0.5 rounded-lg border border-gray-800/40 light:border-slate-200 shrink-0">
          <button
            onClick={() => hasSpot && setMode('SPOT')}
            disabled={!hasSpot}
            title={hasSpot ? undefined : 'No spot instrument for this symbol — futures/options only'}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
              mode === 'SPOT' ? 'bg-[var(--desk-accent)]/10 text-[var(--desk-accent)]' : hasSpot ? 'text-gray-400 light:text-slate-600' : 'text-gray-700 light:text-slate-300 cursor-not-allowed'
            }`}
          >
            Spot
          </button>
          <button
            onClick={() => setMode('FUTURES')}
            className={`px-2.5 py-1 text-xs font-semibold rounded-md transition-colors ${
              mode === 'FUTURES' ? 'bg-[var(--desk-accent)]/10 text-[var(--desk-accent)]' : 'text-gray-400 light:text-slate-600'
            }`}
          >
            Futures
          </button>
        </div>
      </div>

      <div role="group" aria-label="Candle zones" className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--text-secondary)]">Chart zones</span>
        {([{ label: `Order blocks (${matchingZones.filter(z => z.kind === 'OB' && z.active).length})`, on: showOb, toggle: () => setShowOb(!showOb) }, { label: `FVG (${matchingZones.filter(z => z.kind === 'FVG' && z.active).length})`, on: showFvg, toggle: () => setShowFvg(!showFvg) }, { label: 'Ended zones', on: showZoneHistory, toggle: () => setShowZoneHistory(!showZoneHistory) }]).map(control => <button key={control.label} type="button" aria-pressed={control.on} onClick={control.toggle} className={`min-h-8 rounded border px-2 ${control.on ? 'border-[var(--desk-accent)]/50 bg-[var(--desk-accent)]/10 text-[var(--desk-accent)]' : 'border-[var(--border-secondary)] text-[var(--text-secondary)]'}`}>{control.label}</button>)}
      </div>
      <p className="mb-2 text-xs text-[var(--text-secondary)]">{hasVolume ? 'Volume · recorded candles (refreshes with history)' : 'Volume unavailable for this instrument / range'}</p>
      <div ref={containerRef} className="relative h-[300px] w-full md:h-[360px]">
        {(loading || !hasData) && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 light:text-slate-600 pointer-events-none">
            {loading ? 'Loading chart…' : 'No chart data for this range'}
          </div>
        )}
        {hasData && (legend ?? latestBar) && (() => {
          const b = (legend ?? latestBar)!;
          const up = b.close >= b.open;
          const f = (x: number) => x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          return (
            <div className="pointer-events-none absolute top-2 left-2 z-[2] flex flex-wrap gap-x-3 rounded bg-[var(--surface-card)]/80 px-2 py-1 font-mono text-[11px]" aria-live="off">
              <span className="text-[var(--text-muted)]">{interval}</span>
              <span>O <b className={up ? 'cc-up' : 'cc-down'}>{f(b.open)}</b></span>
              <span>H <b className={up ? 'cc-up' : 'cc-down'}>{f(b.high)}</b></span>
              <span>L <b className={up ? 'cc-up' : 'cc-down'}>{f(b.low)}</b></span>
              <span>C <b className={up ? 'cc-up' : 'cc-down'}>{f(b.close)}</b></span>
            </div>
          );
        })()}
        {detectedPattern && (
          <div
            className={`absolute top-10 left-2 px-2.5 py-1.5 rounded-lg badge-glass text-xs font-semibold pointer-events-none ${
              detectedPattern.direction === 'BULLISH' ? 'bg-emerald-500/15 text-emerald-500 light:text-emerald-700' : 'bg-red-500/15 text-red-500 light:text-red-700'
            }`}
          >
            Candidate {formatPatternName(detectedPattern.pattern)} · {detectedPattern.direction === 'BULLISH' ? '▲' : '▼'} {detectedPattern.confidence}/100 fit
          </div>
        )}

        {/* Live state and reversal count. The chart had no indication of
            whether it was updating, so a stale chart and a quiet market
            looked identical — the same failure mode as the scanner's
            silent declines. */}
        {hasData && (
          <div className="absolute top-2 right-2 flex items-center gap-2 pointer-events-none">
            {reversalCount > 0 && (
              <span className="px-2 py-1 rounded-lg badge-glass text-xs font-semibold text-gray-300 light:text-slate-700">
                {reversalCount} reversal{reversalCount === 1 ? '' : 's'}
              </span>
            )}
            <span
              className={`flex items-center gap-1.5 px-2 py-1 rounded-lg badge-glass text-xs font-semibold ${
                liveTick ? 'text-emerald-400 light:text-emerald-700' : 'text-gray-400 light:text-slate-600'
              }`}
              title={
                liveTick
                  ? 'Streaming live ticks — the forming candle updates in real time'
                  : isMarketOpen(exchange)
                    ? 'No live ticks for this instrument right now; candles still refresh periodically'
                    : 'The market is closed: these are the last recorded candles, not a live update'
              }
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full ${liveTick ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500 light:bg-slate-400'}`}
              />
              {liveTick ? 'Live ticks' : isMarketOpen(exchange) ? 'No live ticks' : 'Market closed'}
            </span>
          </div>
        )}
      </div>
      <details className="mt-2 text-xs text-[var(--text-secondary)]">
        <summary className="cursor-pointer">Zone details · {interval} {mode.toLowerCase()} · {visibleZones.length} shown</summary>
        <p className="mt-2">Chart analysis from loaded closed candles using OB-2.0 and touch-based FVG rules. These are chart zones, not confirmed trade entries. Up to six of each type are shown; forming candles are excluded.</p>
        {zoneData.identity !== chartIdentity ? <p>Loading zones for this chart…</p> : zoneData.reason ? <p>{zoneData.reason}</p> : visibleZones.length === 0 ? <p>No zones match these controls in the loaded history.</p> : <ul className="mt-2 space-y-1">{visibleZones.map(z => <li key={z.id}>{z.kind} · {z.direction.toLowerCase()} · {z.bottom.toFixed(2)}–{z.top.toFixed(2)} · {z.state.toLowerCase().replace('_', ' ')}</li>)}</ul>}
      </details>
    </div>
  );
}
