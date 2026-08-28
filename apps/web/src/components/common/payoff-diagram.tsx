'use client';

import React, { useMemo } from 'react';
import { formatIndianNumber } from '@fno/shared';
import type { TradeSetup, OptionChain, OptionType } from '@fno/shared';

// ============================================================
// PAYOFF DIAGRAM — Lightweight inline SVG P&L-at-expiry chart
// ============================================================
// No chart library in this codebase (Sparkline is hand-rolled SVG too) —
// follows the same pattern rather than adding a dependency for one chart.
//
// P&L is computed at EXPIRY from intrinsic value (the standard "hockey
// stick" payoff convention), not live mark-to-market — this is "what does
// this structure look like at every possible outcome," not a live P&L
// tracker (that's what the sticky-setup mark-to-market in market-bias.ts
// already does). Units are per-share/premium, matching how entry/target/
// maxProfit/maxLoss are already shown everywhere else in this app — not
// lot-multiplied rupee totals.
//
// Sizing: the SVG's height is driven by a CSS aspect-ratio on its wrapper,
// not `h-auto` + `preserveAspectRatio="none"` — that combination is a known
// footgun (no explicit height + a non-preserving viewBox mapping can make
// browsers compute a huge, unpredictable intrinsic height instead of
// scaling down with the width). aspect-ratio keeps it bounded and
// predictable at any container width.
// ============================================================

const POINTS = 80;
// Sized for the ~320px sidebar column this now lives in (moved out of the
// wide main column) — SVG text scales with the viewBox, not the container,
// so a viewBox this close to the real rendered width keeps it near 1:1
// instead of shrinking to near-illegible size. X-axis labels are plain
// HTML below the chart (crisp at any size) rather than in the SVG, since
// they don't need to track chart geometry the way the Y-axis gridlines do.
const W = 300;
const H = 190;
const MARGIN = { l: 36, r: 8, t: 8, b: 8 };

function intrinsicValue(spot: number, strike: number, side: OptionType): number {
  return side === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
}

function payoffAt(setup: TradeSetup, spot: number): number {
  if (setup.structureType === 'SPREAD' && setup.legs) {
    const value = setup.legs.reduce(
      (sum, l) => sum + (l.action === 'BUY' ? intrinsicValue(spot, l.strike, l.side) : -intrinsicValue(spot, l.strike, l.side)),
      0
    );
    return value - (setup.netPremium ?? 0);
  }
  if (setup.side && setup.strike != null && setup.entry != null) {
    return intrinsicValue(spot, setup.strike, setup.side) - setup.entry;
  }
  return 0;
}

function findMaxOiStrike(chain: OptionChain, side: 'call' | 'put'): number | null {
  let best: { strike: number; oi: number } | null = null;
  for (const s of chain.strikes) {
    const leg = side === 'call' ? s.call : s.put;
    if (leg && leg.oi > 0 && (!best || leg.oi > best.oi)) best = { strike: s.strike, oi: leg.oi };
  }
  return best?.strike ?? null;
}

/** "12345" -> "12.3k" style compaction for the tight Y-axis label column. */
function compact(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

export function PayoffDiagram({ setup, chain }: { setup: TradeSetup; chain: OptionChain }) {
  const data = useMemo(() => {
    if (!setup.available) return null;

    const strikes =
      setup.structureType === 'SPREAD' && setup.legs
        ? setup.legs.map((l) => l.strike)
        : setup.strike != null
        ? [setup.strike]
        : [];
    if (strikes.length === 0) return null;

    const strikeMin = Math.min(...strikes);
    const strikeMax = Math.max(...strikes);
    // Pad past the strikes far enough to show the expected-move band and
    // both wings fully flattening out, not just the kink points.
    const pad = Math.max(chain.expectedMove.points, (strikeMax - strikeMin) * 0.6, strikeMax * 0.02);
    const xMin = Math.max(0, Math.min(strikeMin, chain.spotPrice) - pad);
    const xMax = Math.max(strikeMax, chain.spotPrice) + pad;

    const points: Array<{ x: number; pnl: number }> = [];
    for (let i = 0; i <= POINTS; i++) {
      const x = xMin + ((xMax - xMin) * i) / POINTS;
      points.push({ x, pnl: payoffAt(setup, x) });
    }

    const pnlValues = points.map((p) => p.pnl);
    const spotPnl = payoffAt(setup, chain.spotPrice);
    const yMin = Math.min(...pnlValues, spotPnl, 0);
    const yMax = Math.max(...pnlValues, spotPnl, 0);
    const yPad = Math.max((yMax - yMin) * 0.12, 1);

    return {
      points,
      xMin,
      xMax,
      yMin: yMin - yPad,
      yMax: yMax + yPad,
      spotPnl,
      putWall: findMaxOiStrike(chain, 'put'),
      callWall: findMaxOiStrike(chain, 'call'),
    };
  }, [setup, chain]);

  if (!data) return null;

  const { points, xMin, xMax, yMin, yMax, spotPnl, putWall, callWall } = data;
  const plotW = W - MARGIN.l - MARGIN.r;
  const plotH = H - MARGIN.t - MARGIN.b;

  const xToPx = (x: number) => MARGIN.l + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (y: number) => MARGIN.t + plotH - ((y - yMin) / (yMax - yMin)) * plotH;
  const zeroY = yToPx(0);

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xToPx(p.x).toFixed(1)} ${yToPx(p.pnl).toFixed(1)}`).join(' ');
  const greenArea =
    `M ${xToPx(points[0].x).toFixed(1)} ${zeroY.toFixed(1)} ` +
    points.map((p) => `L ${xToPx(p.x).toFixed(1)} ${yToPx(Math.max(p.pnl, 0)).toFixed(1)}`).join(' ') +
    ` L ${xToPx(points[points.length - 1].x).toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const redArea =
    `M ${xToPx(points[0].x).toFixed(1)} ${zeroY.toFixed(1)} ` +
    points.map((p) => `L ${xToPx(p.x).toFixed(1)} ${yToPx(Math.min(p.pnl, 0)).toFixed(1)}`).join(' ') +
    ` L ${xToPx(points[points.length - 1].x).toFixed(1)} ${zeroY.toFixed(1)} Z`;

  const emLow = Math.max(chain.expectedMove.lowerBound, xMin);
  const emHigh = Math.min(chain.expectedMove.upperBound, xMax);

  const breakevens =
    setup.breakevenLower != null && setup.breakevenUpper != null
      ? [setup.breakevenLower, setup.breakevenUpper]
      : setup.breakeven != null
      ? [setup.breakeven]
      : [];

  return (
    <div className="bg-gradient-to-b from-[#151522] to-[#0d0d14] light:from-white light:to-slate-50 border border-gray-800/60 light:border-slate-200 border-t-2 border-t-emerald-500/50 rounded-xl p-4 shadow-[0_8px_28px_-14px_rgba(0,0,0,0.75)] light:shadow-[0_4px_16px_-8px_rgba(0,0,0,0.15)]">
      <div className="flex items-center justify-between mb-0.5">
        <h3 className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider">Payoff Diagram — At Expiry</h3>
        <span className={`text-[10px] font-semibold tabular-nums ${spotPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          At spot ({formatIndianNumber(chain.spotPrice, 0)}): {spotPnl >= 0 ? '+' : ''}{spotPnl.toFixed(2)}
        </span>
      </div>
      <p className="text-[10px] text-gray-600 light:text-slate-400 mb-2 leading-snug">
        Profit/loss <span className="text-emerald-400">(green)</span> or <span className="text-red-400">(red)</span> if held to expiry at each possible spot price — not a live price, a projection.
      </p>

      {/* Fixed aspect-ratio wrapper keeps height bounded/predictable at any
          container width — do not switch back to h-auto + preserveAspectRatio=none. */}
      <div className="w-full" style={{ aspectRatio: `${W} / ${H}`, maxHeight: 220 }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-full block">
          {/* Expected move band */}
          {emHigh > emLow && (
            <rect x={xToPx(emLow)} y={MARGIN.t} width={xToPx(emHigh) - xToPx(emLow)} height={plotH} fill="rgb(56 189 248)" fillOpacity={0.06} />
          )}

          {/* Y-axis gridlines + labels: max, zero, min */}
          {[yMax, 0, yMin].map((y, i) => (
            <g key={i}>
              <line x1={MARGIN.l} y1={yToPx(y)} x2={W - MARGIN.r} y2={yToPx(y)} stroke="currentColor" className="text-gray-800 light:text-slate-200" strokeWidth={1} />
              <text x={MARGIN.l - 5} y={yToPx(y)} textAnchor="end" dominantBaseline="middle" className="fill-gray-500 light:fill-slate-400" fontSize={11}>
                {compact(y)}
              </text>
            </g>
          ))}

          {/* Max pain */}
          {chain.maxPain >= xMin && chain.maxPain <= xMax && (
            <line x1={xToPx(chain.maxPain)} y1={MARGIN.t} x2={xToPx(chain.maxPain)} y2={H - MARGIN.b} stroke="rgb(250 204 21)" strokeWidth={1} strokeDasharray="4 3" opacity={0.55} />
          )}
          {/* Put wall (support) */}
          {putWall != null && putWall >= xMin && putWall <= xMax && (
            <line x1={xToPx(putWall)} y1={MARGIN.t} x2={xToPx(putWall)} y2={H - MARGIN.b} stroke="rgb(52 211 153)" strokeWidth={1} strokeDasharray="2 3" opacity={0.4} />
          )}
          {/* Call wall (resistance) */}
          {callWall != null && callWall >= xMin && callWall <= xMax && (
            <line x1={xToPx(callWall)} y1={MARGIN.t} x2={xToPx(callWall)} y2={H - MARGIN.b} stroke="rgb(248 113 113)" strokeWidth={1} strokeDasharray="2 3" opacity={0.4} />
          )}
          {/* Breakeven(s) */}
          {breakevens.map((be, i) =>
            be >= xMin && be <= xMax ? (
              <line key={i} x1={xToPx(be)} y1={MARGIN.t} x2={xToPx(be)} y2={H - MARGIN.b} stroke="rgb(168 85 247)" strokeWidth={1.25} strokeDasharray="5 2" opacity={0.85} />
            ) : null
          )}

          {/* P&L area + curve */}
          <path d={greenArea} fill="rgb(16 185 129)" fillOpacity={0.25} />
          <path d={redArea} fill="rgb(239 68 68)" fillOpacity={0.25} />
          <path d={linePath} fill="none" stroke="rgb(226 232 240)" strokeWidth={2} />

          {/* Current spot marker */}
          <line x1={xToPx(chain.spotPrice)} y1={MARGIN.t} x2={xToPx(chain.spotPrice)} y2={H - MARGIN.b} stroke="rgb(34 211 238)" strokeWidth={1.5} />
          <circle cx={xToPx(chain.spotPrice)} cy={yToPx(spotPnl)} r={4.5} fill="rgb(34 211 238)" stroke="#0d0d14" strokeWidth={1.5} />
        </svg>
      </div>
      {/* X-axis labels as plain HTML — crisp at any container width, unlike
          SVG text which scales (and can shrink to illegible) with the viewBox. */}
      <div className="flex items-center justify-between text-[10px] text-gray-500 light:text-slate-400 tabular-nums px-0.5 mt-1">
        <span>{formatIndianNumber(xMin, 0)}</span>
        <span className="text-gray-600 light:text-slate-400">Spot price at expiry</span>
        <span>{formatIndianNumber(xMax, 0)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-500 light:text-slate-500 mt-2">
        <LegendItem color="rgb(34 211 238)" label={`Spot ${formatIndianNumber(chain.spotPrice, 0)}`} />
        {breakevens.length > 0 && <LegendItem color="rgb(168 85 247)" label={`Breakeven ${breakevens.map((b) => formatIndianNumber(b, 0)).join(' / ')}`} dashed />}
        <LegendItem color="rgb(250 204 21)" label={`Max Pain ${formatIndianNumber(chain.maxPain, 0)}`} dashed />
        {putWall != null && <LegendItem color="rgb(52 211 153)" label={`Put Wall ${formatIndianNumber(putWall, 0)}`} dashed />}
        {callWall != null && <LegendItem color="rgb(248 113 113)" label={`Call Wall ${formatIndianNumber(callWall, 0)}`} dashed />}
        <LegendItem color="rgb(56 189 248)" label="Expected Move" swatch />
      </div>
    </div>
  );
}

function LegendItem({ color, label, dashed, swatch }: { color: string; label: string; dashed?: boolean; swatch?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {swatch ? (
        <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color, opacity: 0.3 }} />
      ) : (
        <span className="w-3 h-0.5" style={{ backgroundColor: color, opacity: dashed ? 0.8 : 1 }} />
      )}
      {label}
    </span>
  );
}
