'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// setup_events is graded hours after a session ends, so the report cannot
// change faster than this.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Mirrors apps/server/src/services/signal-diagnostics.ts diagnosticsSummary(). */
export interface DiagnosticsSummaryRow {
  instrument: string;
  exchange: string;
  detection: { opportunitiesAvailable: number | null; detectionRate: number | null; neverDetected: number | null };
  decision: { watch: number; detected: number; rejected: number; traded: number };
  byEventType: Record<string, number>;
}

export interface DiagnosticsRejectionRow {
  instrument: string;
  exchange: string;
  eventType: string;
  reason: string | null;
  count: number;
}

export interface DiagnosticsCensusRow {
  session_date: string;
  instrument: string;
  exchange: string;
  opportunities: number;
  traded: number;
  rejected: number;
  late: number;
  never_detected: number;
  capture_rate: number | null;
  correctly_empty: boolean;
}

export interface DiagnosticsGradeRow {
  instrument: string;
  exchange: string;
  grade: string | null;
  poolType: string | null;
  triggerType: string | null;
  count: number;
  winRate: number | null;
  avgR: number | null;
  netR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
}

export interface DiagnosticsLeakageRow {
  instrument: string;
  exchange: string;
  eventType: string;
  rejectedGraded: number;
  laterHit2R: number;
  leakageRate: number | null;
}

export interface SignalDiagnosticsData {
  loading: boolean;
  error: string | null;
  summary: DiagnosticsSummaryRow[];
  rejections: DiagnosticsRejectionRow[];
  census: DiagnosticsCensusRow[];
  grades: DiagnosticsGradeRow[];
  leakage: DiagnosticsLeakageRow[];
  refresh: () => void;
}

export function useSignalDiagnostics(opts: { from?: string; to?: string; instrument?: string } = {}): SignalDiagnosticsData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiagnosticsSummaryRow[]>([]);
  const [rejections, setRejections] = useState<DiagnosticsRejectionRow[]>([]);
  const [census, setCensus] = useState<DiagnosticsCensusRow[]>([]);
  const [grades, setGrades] = useState<DiagnosticsGradeRow[]>([]);
  const [leakage, setLeakage] = useState<DiagnosticsLeakageRow[]>([]);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [summaryRes, rejectionsRes, censusRes, gradesRes, leakageRes] = await Promise.all([
          api.getDiagnosticsSummary(opts),
          api.getDiagnosticsRejections(opts),
          api.getDiagnosticsCensus(opts),
          api.getDiagnosticsGrades(opts),
          api.getDiagnosticsLeakage(opts),
        ]);
        if (cancelled) return;
        setSummary(((summaryRes as any)?.data?.byInstrument ?? []) as DiagnosticsSummaryRow[]);
        setRejections(((rejectionsRes as any)?.data?.rows ?? []) as DiagnosticsRejectionRow[]);
        setCensus(((censusRes as any)?.data?.rows ?? []) as DiagnosticsCensusRow[]);
        setGrades(((gradesRes as any)?.data?.rows ?? []) as DiagnosticsGradeRow[]);
        setLeakage(((leakageRes as any)?.data?.rows ?? []) as DiagnosticsLeakageRow[]);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? 'Failed to load signal diagnostics');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.from, opts.to, opts.instrument, nonce]);

  return { loading, error, summary, rejections, census, grades, leakage, refresh };
}
