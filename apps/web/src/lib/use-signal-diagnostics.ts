'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type DiagnosticsFilter } from './api';

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

/** Mirrors apps/server/src/services/diagnostics-metrics.ts. */
export interface DiagnosticsRate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface DiagnosticsPerformanceStats {
  count: number;
  wins: number;
  winRate: number | null;
  grossR: number;
  avgGrossR: number | null;
  netCount: number;
  netR: number | null;
  avgNetR: number | null;
  profitFactor: number | null;
  profitFactorNet: number | null;
  maxDrawdownR: number;
  maxDrawdownNetR: number | null;
  avgMfeR: number | null;
  avgMaeR: number | null;
}

export interface DiagnosticsCostStats {
  priced: number;
  observed: number;
  modelled: number;
  totalCostR: number | null;
  avgCostR: number | null;
  costLeakageR: number | null;
  flippedByCost: number;
  spreadLeakageR: number | null;
  slippageLeakageR: number | null;
  chargesLeakageR: number | null;
}

export type DiagnosticsSegment = 'INDEX' | 'MCX';
export type DiagnosticsCohort = 'TRADED' | 'REJECTED';

export interface DiagnosticsPerformanceRow {
  instrument: string;
  exchange: string;
  segment: DiagnosticsSegment;
  cohort: DiagnosticsCohort;
  performance: DiagnosticsPerformanceStats;
  cost: DiagnosticsCostStats;
}

export interface DiagnosticsPerformanceSegmentRow {
  segment: DiagnosticsSegment;
  cohort: DiagnosticsCohort;
  performance: DiagnosticsPerformanceStats;
  cost: DiagnosticsCostStats;
}

export interface DiagnosticsOpportunityStats {
  opportunities: number;
  dataGap: number;
  coveredOpportunities: number;
  detected: number;
  traded: number;
  rejected: number;
  late: number;
  neverDetected: number;
  detectionRate: DiagnosticsRate;
  captureRate: DiagnosticsRate;
  missedRate: DiagnosticsRate;
  lateRate: DiagnosticsRate;
  rejectionRate: DiagnosticsRate;
}

export interface DiagnosticsOpportunityRow extends DiagnosticsOpportunityStats {
  instrument: string;
  exchange: string;
  segment: DiagnosticsSegment;
  sessions: number;
  correctlyEmptySessions: number;
  candidatesCreated: number;
  tradeReady: number;
  noFill: number;
}

/** Mirrors signal-diagnostics.ts diagnosticsMajorMoves(). */
export interface DiagnosticsMajorMoveRow {
  sessionDate: string;
  instrument: string;
  exchange: string;
  segment: DiagnosticsSegment;
  direction: string;
  startTime: number | null;
  endTime: number | null;
  startPrice: number | null;
  endPrice: number | null;
  sizeAdr: number | null;
  classification: string;
  coverage: string | null;
  firstEventType: string | null;
  firstEventTime: number | null;
  familiesRecognized: string[];
  firstActionable: { triggerId: string; entry: number; remainingMovePct: number; decisionTime?: number } | null;
  traded: boolean | null;
  reason: string | null;
}

/** Mirrors @fno/analytics TriggerDefinition. */
export interface DiagnosticsTrigger {
  triggerId: string;
  family: string;
  version: string;
  name: string;
  exactRule: string;
  decisionBar: string;
  entryRule: string;
  stopRule: string;
  targetRule: string;
  status: string;
  priorEvidence?: string;
}

export interface DiagnosticsOpportunitySegmentRow extends DiagnosticsOpportunityStats {
  segment: DiagnosticsSegment;
}

export interface SignalDiagnosticsData {
  loading: boolean;
  error: string | null;
  summary: DiagnosticsSummaryRow[];
  rejections: DiagnosticsRejectionRow[];
  census: DiagnosticsCensusRow[];
  grades: DiagnosticsGradeRow[];
  leakage: DiagnosticsLeakageRow[];
  performance: { byInstrument: DiagnosticsPerformanceRow[]; bySegment: DiagnosticsPerformanceSegmentRow[] };
  opportunity: { byInstrument: DiagnosticsOpportunityRow[]; bySegment: DiagnosticsOpportunitySegmentRow[] };
  versions: { strategyVersions: string[]; costVersions: string[] };
  majorMoves: DiagnosticsMajorMoveRow[];
  triggers: DiagnosticsTrigger[];
  refresh: () => void;
}

export function useSignalDiagnostics(opts: DiagnosticsFilter = {}): SignalDiagnosticsData {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DiagnosticsSummaryRow[]>([]);
  const [rejections, setRejections] = useState<DiagnosticsRejectionRow[]>([]);
  const [census, setCensus] = useState<DiagnosticsCensusRow[]>([]);
  const [grades, setGrades] = useState<DiagnosticsGradeRow[]>([]);
  const [leakage, setLeakage] = useState<DiagnosticsLeakageRow[]>([]);
  const [performance, setPerformance] = useState<SignalDiagnosticsData['performance']>({ byInstrument: [], bySegment: [] });
  const [opportunity, setOpportunity] = useState<SignalDiagnosticsData['opportunity']>({ byInstrument: [], bySegment: [] });
  const [versions, setVersions] = useState<SignalDiagnosticsData['versions']>({ strategyVersions: [], costVersions: [] });
  const [majorMoves, setMajorMoves] = useState<DiagnosticsMajorMoveRow[]>([]);
  const [triggers, setTriggers] = useState<DiagnosticsTrigger[]>([]);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [summaryRes, rejectionsRes, censusRes, gradesRes, leakageRes, performanceRes, opportunityRes, versionsRes, majorMovesRes, triggersRes] = await Promise.all([
          api.getDiagnosticsSummary(opts),
          api.getDiagnosticsRejections(opts),
          api.getDiagnosticsCensus(opts),
          api.getDiagnosticsGrades(opts),
          api.getDiagnosticsLeakage(opts),
          api.getDiagnosticsPerformance(opts),
          api.getDiagnosticsOpportunity(opts),
          api.getDiagnosticsVersions(),
          api.getDiagnosticsMajorMoves(opts),
          api.getDiagnosticsTriggers(),
        ]);
        if (cancelled) return;
        setSummary(((summaryRes as any)?.data?.byInstrument ?? []) as DiagnosticsSummaryRow[]);
        setRejections(((rejectionsRes as any)?.data?.rows ?? []) as DiagnosticsRejectionRow[]);
        setCensus(((censusRes as any)?.data?.rows ?? []) as DiagnosticsCensusRow[]);
        setGrades(((gradesRes as any)?.data?.rows ?? []) as DiagnosticsGradeRow[]);
        setLeakage(((leakageRes as any)?.data?.rows ?? []) as DiagnosticsLeakageRow[]);
        const perf = (performanceRes as any)?.data;
        setPerformance({ byInstrument: perf?.byInstrument ?? [], bySegment: perf?.bySegment ?? [] });
        const opp = (opportunityRes as any)?.data;
        setOpportunity({ byInstrument: opp?.byInstrument ?? [], bySegment: opp?.bySegment ?? [] });
        const ver = (versionsRes as any)?.data;
        setVersions({ strategyVersions: ver?.strategyVersions ?? [], costVersions: ver?.costVersions ?? [] });
        setMajorMoves(((majorMovesRes as any)?.data?.rows ?? []) as DiagnosticsMajorMoveRow[]);
        setTriggers(((triggersRes as any)?.data?.triggers ?? []) as DiagnosticsTrigger[]);
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
  }, [opts.from, opts.to, opts.instrument, opts.strategyVersion, opts.costVersion, nonce]);

  return { loading, error, summary, rejections, census, grades, leakage, performance, opportunity, versions, majorMoves, triggers, refresh };
}
