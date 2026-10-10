'use client';

// ============================================================
// STATUS BADGE — one meaning per colour, never colour alone
// ============================================================
// Every status shown anywhere in the terminal goes through this: a tone (colour
// token), a glyph, and a text label. The glyph and label mean the status is
// legible without colour (colour-blind users, greyscale, high-contrast mode).
// ============================================================

import React from 'react';
import type { Freshness } from '@/lib/freshness';
import type { HealthStatus } from '@/lib/health-model';
import { statusLabel } from '@/lib/health-model';
import type { PaperTradeState, PaperTradeStatus } from '@fno/shared';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';

const TONE: Record<Tone, { glyph: string; cls: string }> = {
  ok: { glyph: '●', cls: 'text-[var(--status-ok)] border-[var(--status-ok)]/40 bg-[var(--status-ok)]/10' },
  warn: { glyph: '▲', cls: 'text-[var(--status-warn)] border-[var(--status-warn)]/40 bg-[var(--status-warn)]/10' },
  bad: { glyph: '✖', cls: 'text-[var(--status-bad)] border-[var(--status-bad)]/40 bg-[var(--status-bad)]/10' },
  info: { glyph: 'ℹ', cls: 'text-[var(--status-info)] border-[var(--status-info)]/40 bg-[var(--status-info)]/10' },
  off: { glyph: '○', cls: 'text-[var(--status-off)] border-[var(--status-off)]/40 bg-[var(--status-off)]/10' },
};

export function StatusBadge({ tone, label, title, className = '' }: { tone: Tone; label: string; title?: string; className?: string }) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      data-tone={tone}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-semibold leading-5 ${t.cls} ${className}`}
    >
      <span aria-hidden="true">{t.glyph}</span>
      <span>{label}</span>
    </span>
  );
}

export const FRESHNESS_TONE: Record<Freshness, Tone> = { FRESH: 'ok', STALE: 'warn', DISCONNECTED: 'bad', UNAVAILABLE: 'off', MARKET_CLOSED: 'info' };

export function FreshnessBadge({ state, label, detail }: { state: Freshness; label?: string; detail?: string }) {
  return <StatusBadge tone={FRESHNESS_TONE[state]} label={label ?? state.replace(/_/g, ' ')} title={detail} />;
}

export const HEALTH_TONE: Record<HealthStatus, Tone> = {
  HEALTHY: 'ok',
  DEGRADED: 'warn',
  STALE: 'warn',
  DISCONNECTED: 'bad',
  UNAVAILABLE: 'off',
  NOT_IMPLEMENTED: 'off',
  API_UNREACHABLE: 'bad',
  MARKET_CLOSED: 'info',
};

export function HealthBadge({ status, detail }: { status: HealthStatus; detail?: string }) {
  return <StatusBadge tone={HEALTH_TONE[status]} label={statusLabel(status)} title={detail} />;
}

/** Trade outcome / tracking status, in one vocabulary. */
export function TradeStateBadge({ state, status }: { state: PaperTradeState; status?: PaperTradeStatus }) {
  if (status === 'VOIDED') return <StatusBadge tone="bad" label="VOIDED" title="The recorded outcome is known to be invalid; excluded from performance." />;
  if (status === 'TRACKING_LOST') return <StatusBadge tone="bad" label="TRACKING LOST" title="The real exit is unknown; excluded from performance." />;
  if (status === 'OPEN_UNTRACKED') return <StatusBadge tone="warn" label="OPEN · NOT TRACKED" title="The trade row is open but no live slot is tracking it." />;
  if (status === 'OFF_SESSION') return <StatusBadge tone="off" label={`${state} · OFF-SESSION`} title="Minted while the market was closed; excluded from performance." />;
  switch (state) {
    case 'OPEN':
      return <StatusBadge tone="info" label="OPEN" />;
    case 'WIN':
      return <StatusBadge tone="ok" label="WIN" />;
    case 'LOSS':
      return <StatusBadge tone="bad" label="LOSS" />;
    case 'EXPIRED':
      return <StatusBadge tone="warn" label="EXPIRED" title="Closed without reaching the stop or the target." />;
  }
}

/** Order-flow data quality. */
export function DataModeBadge({ mode }: { mode: 'EXACT' | 'INFERRED' | 'PARTIAL' | 'UNAVAILABLE' }) {
  const m = {
    EXACT: { tone: 'ok' as Tone, title: 'Exchange-reported aggressor side.' },
    INFERRED: { tone: 'warn' as Tone, title: 'Aggressor side inferred from bid/ask or tick direction; not exchange delta.' },
    PARTIAL: { tone: 'warn' as Tone, title: 'Only part of the bar has data.' },
    UNAVAILABLE: { tone: 'off' as Tone, title: 'No order-flow data for this bar.' },
  }[mode];
  return <StatusBadge tone={m.tone} label={mode} title={m.title} />;
}

/** Whether a setup can create a paper trade. */
export type DecisionState = 'LIVE_PAPER_ELIGIBLE' | 'SHADOW_ONLY' | 'REJECTED' | 'UNAVAILABLE';
export function DecisionBadge({ state }: { state: DecisionState }) {
  const m = {
    LIVE_PAPER_ELIGIBLE: { tone: 'ok' as Tone, label: 'LIVE PAPER-ELIGIBLE', title: 'Can create a paper trade if every gate passes.' },
    SHADOW_ONLY: { tone: 'info' as Tone, label: 'SHADOW ONLY', title: 'Measured only; this can never create a paper trade.' },
    REJECTED: { tone: 'bad' as Tone, label: 'REJECTED', title: 'A gate refused it.' },
    UNAVAILABLE: { tone: 'off' as Tone, label: 'UNAVAILABLE', title: 'Not enough recorded information to say.' },
  }[state];
  return <StatusBadge tone={m.tone} label={m.label} title={m.title} />;
}
