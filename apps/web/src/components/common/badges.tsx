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

const SEVERITY_COLORS: Record<string, string> = {
  INFO: 'bg-cyan-500/15 text-cyan-400 light:text-cyan-700',
  WARNING: 'bg-amber-500/15 text-amber-400 light:text-amber-700',
  CRITICAL: 'bg-red-500/15 text-red-400 light:text-red-700',
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium badge-glass ${
      SEVERITY_COLORS[severity] || SEVERITY_COLORS.INFO
    }`}>
      {severity}
    </span>
  );
}

const OI_CONFIG: Record<OIInterpretation, { label: string; color: string; dot: string }> = {
  LONG_BUILDUP: {
    label: 'Long Build',
    color: 'text-emerald-400 light:text-emerald-700 bg-emerald-500/12 shadow-[0_0_0_1px_rgba(16,185,129,0.2)_inset]',
    dot: 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]',
  },
  SHORT_BUILDUP: {
    label: 'Short Build',
    color: 'text-red-400 light:text-red-700 bg-red-500/12 shadow-[0_0_0_1px_rgba(239,68,68,0.2)_inset]',
    dot: 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.8)]',
  },
  SHORT_COVERING: {
    label: 'Short Cover',
    color: 'text-yellow-400 light:text-yellow-700 bg-yellow-500/12 shadow-[0_0_0_1px_rgba(251,191,36,0.2)_inset]',
    dot: 'bg-yellow-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
  },
  LONG_UNWINDING: {
    label: 'Long Unwind',
    color: 'text-orange-400 light:text-orange-700 bg-orange-500/12 shadow-[0_0_0_1px_rgba(249,115,22,0.2)_inset]',
    dot: 'bg-orange-400 shadow-[0_0_6px_rgba(249,115,22,0.8)]',
  },
  CALL_WRITING: {
    label: 'Call Writing',
    color: 'text-red-400 light:text-red-700 bg-red-500/12 shadow-[0_0_0_1px_rgba(239,68,68,0.2)_inset]',
    dot: 'bg-red-400 shadow-[0_0_6px_rgba(239,68,68,0.8)]',
  },
  PUT_WRITING: {
    label: 'Put Writing',
    color: 'text-emerald-400 light:text-emerald-700 bg-emerald-500/12 shadow-[0_0_0_1px_rgba(16,185,129,0.2)_inset]',
    dot: 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]',
  },
  CALL_UNWINDING: {
    label: 'Call Unwind',
    color: 'text-yellow-400 light:text-yellow-700 bg-yellow-500/12 shadow-[0_0_0_1px_rgba(251,191,36,0.2)_inset]',
    dot: 'bg-yellow-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
  },
  PUT_UNWINDING: {
    label: 'Put Unwind',
    color: 'text-orange-400 light:text-orange-700 bg-orange-500/12 shadow-[0_0_0_1px_rgba(249,115,22,0.2)_inset]',
    dot: 'bg-orange-400 shadow-[0_0_6px_rgba(249,115,22,0.8)]',
  },
  NEUTRAL: {
    label: 'Neutral',
    color: 'text-gray-400 light:text-slate-500 bg-gray-500/10 shadow-[0_0_0_1px_rgba(156,163,175,0.15)_inset]',
    dot: 'bg-gray-400',
  },
};

export function OIBadge({ type }: { type: OIInterpretation | string }) {
  const info = OI_CONFIG[type as OIInterpretation] || OI_CONFIG.NEUTRAL;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold badge-glass ${info.color}`}>
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${info.dot}`} />
      <span>{info.label}</span>
    </span>
  );
}

const BIAS_COLORS: Record<string, string> = {
  BULLISH: 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700 shadow-[0_0_0_1px_rgba(16,185,129,0.25)_inset]',
  BEARISH: 'bg-red-500/15 text-red-400 light:text-red-700 shadow-[0_0_0_1px_rgba(239,68,68,0.25)_inset]',
  NEUTRAL: 'bg-gray-500/15 text-gray-400 light:text-slate-500 shadow-[0_0_0_1px_rgba(156,163,175,0.2)_inset]',
};

const BIAS_ARROWS: Record<string, string> = {
  BULLISH: '▲',
  BEARISH: '▼',
  NEUTRAL: '—',
};

export function BiasBadge({ bias, large }: { bias: BiasDirection | string; large?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-bold badge-glass ${
      BIAS_COLORS[bias] || BIAS_COLORS.NEUTRAL
    } ${large ? 'text-xs' : 'text-[10px]'}`}>
      <span className="text-[9px]">{BIAS_ARROWS[bias] || '—'}</span>
      <span>{bias}</span>
    </span>
  );
}

export function ScoreBadge({ score, large }: { score: number; large?: boolean }) {
  const color =
    score >= 70
      ? 'text-emerald-400 light:text-emerald-700 bg-emerald-500/15 shadow-[0_0_0_1px_rgba(16,185,129,0.3)_inset,0_0_10px_-2px_rgba(16,185,129,0.3)]'
      : score >= 40
      ? 'text-yellow-400 light:text-yellow-700 bg-yellow-500/15 shadow-[0_0_0_1px_rgba(251,191,36,0.3)_inset,0_0_10px_-2px_rgba(251,191,36,0.25)]'
      : 'text-red-400 light:text-red-700 bg-red-500/15 shadow-[0_0_0_1px_rgba(239,68,68,0.3)_inset,0_0_10px_-2px_rgba(239,68,68,0.25)]';

  return (
    <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-md font-bold tabular-nums badge-glass ${color} ${
      large ? 'text-xs min-w-[32px]' : 'text-[10px] min-w-[26px]'
    }`}>
      {score}
    </span>
  );
}

