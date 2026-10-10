'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

const POLL_MS = 5 * 60_000;

/** The deployed measurement report as returned (typed loosely: older deployments may lack newer sections). Read-only. */
export interface MeasurementReport {
  note?: string;
  versions?: Record<string, string>;
  schemaReady?: boolean;
  cohortBoundaries?: Record<string, string>;
  reliability?: { measurementsReliableFrom?: string; note?: string; tradesSinceReliable?: number; withCostRecord?: number; costRecordCoveragePct?: number | null };
  populations?: { historical?: string; measurementReliable?: string; netR?: string; historicalRows?: number; measurementReliableRows?: number };
  conservativeFillMethod?: { id?: string; label?: string; rule?: string; params?: Record<string, number>; limitation?: string };
  byCohort?: Array<{ cohort: string; tally: Tally }>;
  byFamily?: Array<{ cohort: string; family: string; tally: Tally }>;
  byInstrument?: Array<{ cohort: string; family: string; instrument: string; tally: Tally }>;
  reliableSample?: { byCohort: Array<{ cohort: string; tally: Tally }>; byFamily: Array<{ cohort: string; family: string; tally: Tally }>; byInstrument: Array<{ cohort: string; family: string; instrument: string; tally: Tally }> };
  costs?: MeasurementSection | null;
  postExit?: MeasurementSection | null;
  payoff?: MeasurementSection | null;
}

/**
 * A section of the server's measurement report. Deployments add fields over time, so the shape is read loosely and every
 * figure is guarded where it is displayed (a missing field shows an em dash, never 0).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MeasurementSection = Record<string, any>;

export interface Tally {
  rows: number;
  excluded: Record<string, number>;
  n: number;
  wins: number;
  losses: number;
  expired: number;
  winRateClosedOnly: number | null;
  winRateAllTrades: number | null;
  expiredShare: number | null;
  baseline: { grossR: number | null; netR: number | null; nNet: number; grossRSameTradesAsNet?: number | null };
  /** Older deployments do not send this; every figure derived from it then reads as unavailable, never 0. */
  netByOutcome?: { WIN: { n: number; meanNetR: number | null }; LOSS: { n: number; meanNetR: number | null }; EXPIRED: { n: number; meanNetR: number | null }; expiredContributionToMeanNetR: number | null };
  conservative: { basis?: string; grossR: number | null; netR: number | null; nNet: number; grossRSameTradesAsNet?: number | null };
  denominators?: { winRateClosedOnly: number; winRateAllTrades: number; expiredShare: number; grossR: number; netR: number };
  targetExits: { n: number; meanHaircut: number | null; becomeLosses: number; spreadFromQuote: number; spreadFallback: number };
}

export function useMeasurement(): { data: MeasurementReport | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<MeasurementReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      api
        .getMeasurement()
        .then((d) => {
          if (cancelled) return;
          setData(d);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err?.status === 404 ? 'NOT_DEPLOYED' : err?.message ?? 'Request failed');
          setLoading(false);
        });
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tick]);

  const reload = useCallback(() => {
    setLoading(true);
    setTick((n) => n + 1);
  }, []);
  return { data, loading, error, reload };
}
