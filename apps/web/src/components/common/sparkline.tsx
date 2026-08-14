'use client';

import React, { useMemo } from 'react';

// ============================================================
// SPARKLINE — Lightweight inline SVG micro-chart
// ============================================================
// Accepts real data[] when available, or generates a seeded
// random-walk from the symbol name for a consistent preview.
// Used in IndexCard, IndexChip, and ActivityList.
// ============================================================

interface SparklineProps {
  /** If provided, these values are plotted directly. */
  data?: number[];
  /** Fallback seed for generating simulated data when `data` is absent. */
  symbol?: string;
  /** SVG width in px */
  width?: number;
  /** SVG height in px */
  height?: number;
  /** Stroke color — any CSS color value */
  color?: string;
  /** If true, fills area under the line with a gradient */
  showArea?: boolean;
  /** Stroke width */
  strokeWidth?: number;
  /** Number of simulated points (only when data is absent) */
  points?: number;
  className?: string;
}

/** Simple seeded PRNG — Mulberry32 */
function mulberry32(seed: number) {
  return () => {
    /* eslint-disable no-param-reassign */
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash;
}

function generateSimulatedData(symbol: string, count: number): number[] {
  const rng = mulberry32(hashString(symbol));
  const data: number[] = [];
  let value = 50 + rng() * 50;
  for (let i = 0; i < count; i++) {
    value += (rng() - 0.48) * 3; // slight upward bias
    value = Math.max(10, Math.min(100, value));
    data.push(value);
  }
  return data;
}

export function Sparkline({
  data,
  symbol = 'DEFAULT',
  width = 80,
  height = 28,
  color = '#34d399',
  showArea = true,
  strokeWidth = 1.5,
  points = 30,
  className = '',
}: SparklineProps) {
  const values = useMemo(
    () => (data && data.length >= 2 ? data : generateSimulatedData(symbol, points)),
    [data, symbol, points]
  );

  const path = useMemo(() => {
    if (values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const padding = 1; // px padding top/bottom

    const xStep = width / (values.length - 1);
    const yScale = (height - padding * 2) / range;

    return values
      .map((v, i) => {
        const x = i * xStep;
        const y = height - padding - (v - min) * yScale;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [values, width, height]);

  const areaPath = useMemo(() => {
    if (!showArea || values.length < 2) return '';
    const lastX = width;
    return `${path} L${lastX},${height} L0,${height} Z`;
  }, [path, showArea, values.length, width, height]);

  const gradientId = useMemo(() => `spark-${hashString(symbol + color)}`, [symbol, color]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`shrink-0 ${className}`}
      style={{ overflow: 'visible' }}
    >
      {showArea && (
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {showArea && areaPath && (
        <path d={areaPath} fill={`url(#${gradientId})`} />
      )}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
