'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { InstitutionalFlowSnapshot, NextDayBias, InstitutionalCommentary, InstitutionalFlowPrediction, PredictionAccuracyStats } from '@fno/shared';

const POLL_INTERVAL_MS = 60000; // matches the backend's own 60s snapshot/bias cache TTL

/**
 * Snapshot, next-day bias and commentary are fetched independently — one
 * slow or failing call (commentary needs the AI key) no longer blanks the
 * other two. isLive tracks the snapshot. Nothing starts from sample data.
 */
export function useInstitutionalFlow(): {
  snapshot: InstitutionalFlowSnapshot | null;
  biases: NextDayBias[];
  commentary: InstitutionalCommentary | null;
  loading: boolean;
  isLive: boolean;
} {
  const [snapshot, setSnapshot] = useState<InstitutionalFlowSnapshot | null>(null);
  const [biases, setBiases] = useState<NextDayBias[]>([]);
  const [commentary, setCommentary] = useState<InstitutionalCommentary | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      Promise.allSettled([api.getInstitutionalSnapshot(), api.getNextDayBias(), api.getInstitutionalCommentary()]).then(
        ([snap, bias, comm]) => {
          if (cancelled) return;
          if (snap.status === 'fulfilled') setSnapshot(snap.value);
          if (bias.status === 'fulfilled') setBiases(bias.value);
          if (comm.status === 'fulfilled') setCommentary(comm.value);
          setIsLive(snap.status === 'fulfilled');
          setLoading(false);
        }
      );
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { snapshot, biases, commentary, loading, isLive };
}

const ACCURACY_POLL_INTERVAL_MS = 120000;

export function usePredictionAccuracy(symbol: string): {
  predictions: InstitutionalFlowPrediction[];
  accuracy: PredictionAccuracyStats | null;
  loading: boolean;
} {
  const [predictions, setPredictions] = useState<InstitutionalFlowPrediction[]>([]);
  const [accuracy, setAccuracy] = useState<PredictionAccuracyStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      Promise.all([api.getPredictionHistory(symbol), api.getPredictionAccuracy(symbol)])
        .then(([preds, acc]) => {
          if (cancelled) return;
          setPredictions(preds);
          setAccuracy(acc);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setLoading(false);
        });
    };
    poll();
    const interval = setInterval(poll, ACCURACY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [symbol]);

  return { predictions, accuracy, loading };
}
