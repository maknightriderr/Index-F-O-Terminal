'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// Outcomes are graded hours after a decision, so the report cannot change
// faster than this.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export type LossAttributionScope = 'TAKE' | 'REFUSE' | 'ALL';

/** Mirrors apps/server/src/services/loss-attribution-model.ts GroupStats. */
export interface AttributionGroup {
  key: string;
  n: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: number | null;
  avgSimR: number | null;
  totalSimR: number;
  premiumR: { n: number; avg: number | null };
  exitReasons: Record<string, number>;
  exitReasonPct: Record<string, number | null>;
  sample: 'INSUFFICIENT' | 'LOW' | 'ADEQUATE';
}

export interface AttributionQuestionAnswer {
  id: string;
  question: string;
  dimension: string;
  groups: AttributionGroup[];
}

export interface AttributionReport {
  simulated: true;
  note: string;
  population: { rows: number; graded: number; from: string | null; to: string | null };
  overall: AttributionGroup;
  questions: AttributionQuestionAnswer[];
  mae: AttributionGroup[];
  deadTrades: { flaggedDead: AttributionGroup; neverFlagged: AttributionGroup; recoveredPct: number | null; note: string };
  /** Phase 2. Optional so an older backend still renders. */
  invalidation?: AttributionGroup[];
  exposure?: { sameDirection: AttributionGroup[]; correlated: AttributionGroup[]; note: string };
  /** Validation review: the same outcomes split by logic version. Optional so an older backend still renders. */
  byLogicVersion?: AttributionGroup[];
  /** Momentum-break round: the same outcomes split by setup family. Optional so an older backend still renders. */
  byStrategy?: AttributionGroup[];
  /** Validation review: what each R measure is. */
  rDefinitions?: { simR: string; premiumR: string; backtestingR: string };
}

/** Mirrors apps/server/src/services/shadow-comparison-model.ts. */
interface ShadowGroupBase {
  key: string;
  n: number;
  sample: 'INSUFFICIENT' | 'LOW' | 'ADEQUATE';
}
export interface ShadowStrikeGroup extends ShadowGroupBase {
  differs: number;
  differsPct: number | null;
  livePremiumRWhenAgreed: { n: number; avg: number | null };
  livePremiumRWhenDiffered: { n: number; avg: number | null };
}
export interface ShadowExecutionGroup extends ShadowGroupBase {
  degraded: number;
  avgLiveNetR: number | null;
  avgShadowNetR: number | null;
  avgNetRDelta: number | null;
  avgEntrySlippagePct: number | null;
}
export interface ShadowTargetGroup extends ShadowGroupBase {
  avgDivergencePts: number | null;
  avgDivergencePctOfEntry: number | null;
  v2BelowLivePct: number | null;
  avgShadowExpectedNetRV2: number | null;
  avgLiveNetR: number | null;
  liveTargetHitRate: { v2Below: { n: number; pct: number | null }; v2AtOrAbove: { n: number; pct: number | null } };
}
export interface ShadowComparison {
  simulated: true;
  shadowOnly: true;
  note: string;
  caveats: string[];
  population: { rows: number; from: string | null; to: string | null };
  strike: { overall: ShadowStrikeGroup; byDte: ShadowStrikeGroup[] };
  execution: { overall: ShadowExecutionGroup; byDte: ShadowExecutionGroup[] };
  target: { overall: ShadowTargetGroup; byDte: ShadowTargetGroup[] };
}

export interface AttributionSplit {
  splitAt: string;
  splitReason: string;
  inSample: AttributionReport;
  outOfSample: AttributionReport;
}

export interface GateSummaryRow {
  gate: string;
  pass: number;
  fail: number;
  notEvaluated: number;
  failedButNotDeciding: number;
  decidingCount: number;
}

export interface LossAttributionData {
  report: AttributionReport | null;
  split: AttributionSplit | null;
  gates: GateSummaryRow[];
  /** Phase 2 shadow-vs-live comparison; null when unavailable (e.g. an older backend). */
  shadow: ShadowComparison | null;
  loading: boolean;
  /** False when the backend could not be reached — distinct from "no rows". */
  isLive: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLossAttribution(scope: LossAttributionScope, logicVersion: string = 'all'): LossAttributionData {
  const [state, setState] = useState<Omit<LossAttributionData, 'refresh'>>({
    report: null,
    split: null,
    gates: [],
    shadow: null,
    loading: true,
    isLive: false,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      Promise.all([
        api.getLossAttributionReport({ scope, logicVersion }),
        api.getLossAttributionSplit({ scope, logicVersion }),
        api.getLossAttributionGates(),
        // A Phase 2 endpoint an older backend lacks: its absence must not
        // blank the Phase 1 panels, so it degrades to null on its own.
        api.getLossAttributionShadow().catch(() => null),
      ])
        .then(([report, split, gates, shadow]) => {
          if (cancelled) return;
          setState({
            report: report as AttributionReport,
            split: split as AttributionSplit,
            gates: ((gates as { gates?: GateSummaryRow[] } | null)?.gates ?? []) as GateSummaryRow[],
            shadow: (shadow as ShadowComparison | null) ?? null,
            loading: false,
            isLive: true,
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const message = err instanceof Error ? err.message : 'unreachable';
          setState((s) => ({ ...s, loading: false, isLive: false, error: message }));
        });
    };
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [scope, logicVersion, nonce]);

  return { ...state, refresh };
}
