'use client';

// ============================================================
// SHARED BADGE COMPONENTS
// ============================================================
// OI/bias/score badges used across Dashboard, Option Chain and
// Futures pages — kept in one place so the color/label mapping
// stays consistent everywhere OI activity is shown.
// ============================================================

import React from 'react';
import type { OIInterpretation, BiasDirection } from '@fno/shared';

const OI_LABELS: Record<OIInterpretation, { label: string; color: string }> = {
  LONG_BUILDUP: { label: 'Long Build', color: 'text-emerald-400 bg-emerald-500/10' },
  SHORT_BUILDUP: { label: 'Short Build', color: 'text-red-400 bg-red-500/10' },
  SHORT_COVERING: { label: 'Short Cover', color: 'text-yellow-400 bg-yellow-500/10' },
  LONG_UNWINDING: { label: 'Long Unwind', color: 'text-orange-400 bg-orange-500/10' },
  CALL_WRITING: { label: 'Call Writing', color: 'text-red-400 bg-red-500/10' },
  PUT_WRITING: { label: 'Put Writing', color: 'text-emerald-400 bg-emerald-500/10' },
  CALL_UNWINDING: { label: 'Call Unwind', color: 'text-yellow-400 bg-yellow-500/10' },
  PUT_UNWINDING: { label: 'Put Unwind', color: 'text-orange-400 bg-orange-500/10' },
  NEUTRAL: { label: 'Neutral', color: 'text-gray-400 bg-gray-500/10' },
};

export function OIBadge({ type }: { type: OIInterpretation | string }) {
  const info = OI_LABELS[type as OIInterpretation] || OI_LABELS.NEUTRAL;

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${info.color}`}>
      {info.label}
    </span>
  );
}

const BIAS_COLORS: Record<string, string> = {
  BULLISH: 'bg-emerald-500/15 text-emerald-400',
  BEARISH: 'bg-red-500/15 text-red-400',
  NEUTRAL: 'bg-gray-500/15 text-gray-400',
};

export function BiasBadge({ bias, large }: { bias: BiasDirection | string; large?: boolean }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded font-medium ${
      BIAS_COLORS[bias] || BIAS_COLORS.NEUTRAL
    } ${large ? 'text-sm' : 'text-[10px]'}`}>
      {bias}
    </span>
  );
}

export function ScoreBadge({ score, large }: { score: number; large?: boolean }) {
  const color = score >= 70 ? 'text-emerald-400 bg-emerald-500/15' :
                score >= 40 ? 'text-yellow-400 bg-yellow-500/15' :
                'text-red-400 bg-red-500/15';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded font-bold tabular-nums ${color} ${
      large ? 'text-sm' : 'text-[10px]'
    }`}>
      {score}
    </span>
  );
}
