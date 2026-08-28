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
// ============================================================

const POINTS = 80;

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
  const W = 640;
  const H = 200;
  const marginL = 8;
  const marginR = 8;
  const marginT = 10;
  const marginB = 10;
  const plotW = W - marginL - marginR;
  const plotH = H - marginT - marginB;

  const xToPx = (x: number) => marginL + ((x - xMin) / (xMax - xMin)) * plotW;
  const yToPx = (y: number) => marginT + plotH - ((y - yMin) / (yMax - yMin)) * plotH;
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
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-semibold text-gray-500 light:text-slate-500 uppercase tracking-wider">Payoff Diagram — At Expiry</h3>
        <span className={`text-[10px] font-semibold tabular-nums ${spotPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          At spot ({formatIndianNumber(chain.spotPrice, 0)}): {spotPnl >= 0 ? '+' : ''}{spotPnl.toFixed(2)}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
        {/* Expected move band */}
        {emHigh > emLow && (
          <rect
            x={xToPx(emLow)}
            y={marginT}
            width={xToPx(emHigh) - xToPx(emLow)}
            height={plotH}
            fill="rgb(56 189 248)"
            fillOpacity={0.06}
          />
        )}

        {/* Zero line */}
        <line x1={marginL} y1={zeroY} x2={W - marginR} y2={zeroY} stroke="currentColor" className="text-gray-700 light:text-slate-300" strokeWidth={1} strokeDasharray="3 3" />

        {/* Max pain */}
        {chain.maxPain >= xMin && chain.maxPain <= xMax && (
          <line x1={xToPx(chain.maxPain)} y1={marginT} x2={xToPx(chain.maxPain)} y2={H - marginB} stroke="rgb(250 204 21)" strokeWidth={1} strokeDasharray="4 3" opacity={0.7} />
        )}
        {/* Put wall (support) */}
        {putWall != null && putWall >= xMin && putWall <= xMax && (
          <line x1={xToPx(putWall)} y1={marginT} x2={xToPx(putWall)} y2={H - marginB} stroke="rgb(52 211 153)" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
        )}
        {/* Call wall (resistance) */}
        {callWall != null && callWall >= xMin && callWall <= xMax && (
          <line x1={xToPx(callWall)} y1={marginT} x2={xToPx(callWall)} y2={H - marginB} stroke="rgb(248 113 113)" strokeWidth={1} strokeDasharray="2 3" opacity={0.5} />
        )}
        {/* Breakeven(s) */}
        {breakevens.map((be, i) =>
          be >= xMin && be <= xMax ? (
            <line key={i} x1={xToPx(be)} y1={marginT} x2={xToPx(be)} y2={H - marginB} stroke="rgb(168 85 247)" strokeWidth={1} strokeDasharray="5 2" opacity={0.8} />
          ) : null
        )}

        {/* P&L area + curve */}
        <path d={greenArea} fill="rgb(16 185 129)" fillOpacity={0.25} />
        <path d={redArea} fill="rgb(239 68 68)" fillOpacity={0.25} />
        <path d={linePath} fill="none" stroke="rgb(226 232 240)" strokeWidth={1.75} />

        {/* Current spot marker */}
        <line x1={xToPx(chain.spotPrice)} y1={marginT} x2={xToPx(chain.spotPrice)} y2={H - marginB} stroke="rgb(34 211 238)" strokeWidth={1.5} />
        <circle cx={xToPx(chain.spotPrice)} cy={yToPx(spotPnl)} r={4} fill="rgb(34 211 238)" stroke="#0d0d14" strokeWidth={1.5} />
      </svg>

      <div className="flex items-center justify-between text-[9px] text-gray-500 light:text-slate-500 tabular-nums mt-0.5 mb-2.5">
        <span>{formatIndianNumber(xMin, 0)}</span>
        <span>{formatIndianNumber(xMax, 0)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-gray-500 light:text-slate-500">
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
