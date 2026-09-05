'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { MOCK_INSTITUTIONAL_SNAPSHOT } from './mock-data';
import type { InstitutionalFlowSnapshot, NextDayBias, InstitutionalCommentary, InstitutionalFlowPrediction, PredictionAccuracyStats } from '@fno/shared';

const POLL_INTERVAL_MS = 60000; // matches the backend's own 60s snapshot/bias cache TTL

/** snapshot falls back to realistic mock data (isLive: false) when the backend is unreachable — same pattern as useLiveIndices. */
export function useInstitutionalFlow(): {
  snapshot: InstitutionalFlowSnapshot | null;
  biases: NextDayBias[];
  commentary: InstitutionalCommentary | null;
  loading: boolean;
  isLive: boolean;
} {
  const [snapshot, setSnapshot] = useState<InstitutionalFlowSnapshot | null>(MOCK_INSTITUTIONAL_SNAPSHOT);
  const [biases, setBiases] = useState<NextDayBias[]>([]);
  const [commentary, setCommentary] = useState<InstitutionalCommentary | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      Promise.all([api.getInstitutionalSnapshot(), api.getNextDayBias(), api.getInstitutionalCommentary()])
        .then(([snap, bias, comm]) => {
          if (cancelled) return;
          setSnapshot(snap);
          setBiases(bias);
          setCommentary(comm);
          setIsLive(true);
          setLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setIsLive(false);
          setLoading(false);
        });
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
