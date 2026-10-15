'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// ============================================================
// EVIDENCE REPORTS — read-only hooks (2026-10-15)
// ============================================================
// The server computes everything (evaluation-core.ts); these hooks only fetch.
// The reports move only when trades close, so they are read every 10 minutes.
// ============================================================

const POLL_MS = 10 * 60_000;

export interface ClusterStat {
  n: number;
  clusters: number;
  mean: number | null;
  lo: number | null;
  hi: number | null;
}

export type ScorecardAction = 'PROTECTED_BENCHMARK' | 'PROMOTE_ELIGIBLE' | 'DEMOTE_CANDIDATE' | 'KEEP_MEASURING';

export interface ScorecardEntry {
  strategy: string;
  n: number;
  days: number;
  wins: number;
  losses: number;
  expired: number;
  winRateClosedOnly: number | null;
  winRateAllTrades: number | null;
  netR: ClusterStat;
  netRCorrected: { lo: number | null; hi: number | null; comparisons: number };
  grossR: number | null;
  avgNetWin: number | null;
  avgNetLoss: number | null;
  firstHalfNetR: number | null;
  secondHalfNetR: number | null;
  action: ScorecardAction;
  reason: string;
  /** Set when the strategy is already off the paper slot in code (TRIGGER_DEMOTIONS). */
  currentStage?: { stage: string; since: string } | null;
}

export interface ScorecardReport {
  note: string;
  rules: { VERSION: string; REGISTERED_AT: string; MIN_N_DEMOTE: number; MIN_N_PROMOTE: number; MIN_DAYS_PROMOTE: number };
  paper: ScorecardEntry[];
  measurementReliable: ScorecardEntry[];
  candidates: ScorecardEntry[];
}

export type HorizonStat = ClusterStat & { hitRate: number | null };

export interface SignalQualityReport {
  note: string;
  decisions: number;
  days: number;
  symbols: number;
  horizons: Array<HorizonStat & { minutes: number }>;
  toDayEnd: HorizonStat;
  baseline60: HorizonStat;
  agreesWithMomentumPct: number | null;
  byExchange: Array<HorizonStat & { key: string }>;
  byConfidence: Array<HorizonStat & { key: string }>;
  dimensions: Array<{ dimension: string; n: number; rho: number | null; lo: number | null; hi: number | null }>;
}

export interface GateValidationReport {
  note: string;
  taken: ClusterStat;
  gates: Array<{ code: string; refused: ClusterStat; diffVsTaken: { diff: number | null; lo: number | null; hi: number | null; days: number }; verdict: 'FILTERS_WORSE' | 'REFUSES_NO_WORSE' | 'INCONCLUSIVE' }>;
}

export interface BookStats {
  trades: number;
  totalNetR: number;
  meanNetR: number | null;
  winRateAllTrades: number | null;
  worstDayR: number | null;
  bestDayR: number | null;
  maxDrawdownR: number;
  maxOpen: number;
  maxSameDirection: number;
}

export interface PortfolioRiskReport {
  note: string;
  baseline: BookStats;
  variants: Array<{ id: string; label: string; source: string; stats: BookStats; skipped: Record<string, number>; skippedTotal: number }>;
}

type ReportName = 'scorecard' | 'signal-quality' | 'gate-validation' | 'portfolio-risk';

export function useEvidenceReport<T>(report: ReportName): { data: T | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      api
        .getEvidence<T>(report)
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err?.status === 404 ? 'This report is not deployed on the server yet.' : err?.message ?? 'Request failed');
          setLoading(false);
        });
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [report, tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);
  return { data, loading, error, reload };
}
