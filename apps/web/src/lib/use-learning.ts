'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// The audit runs once a day. Polling faster than this would be asking a
// question whose answer cannot have changed.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface LearningData {
  summary: any | null;
  events: any[];
  recurring: any[];
  expected: any[];
  unresolved: any[];
  regressions: any[];
  protections: any[];
  review: any[];
  history: any[];
  loading: boolean;
  /** False when the backend could not be reached — distinct from "nothing found". */
  isLive: boolean;
  error: string | null;
  refresh: () => void;
}

export function useLearning(date?: string): LearningData {
  const [state, setState] = useState<Omit<LearningData, 'refresh'>>({
    summary: null,
    events: [],
    recurring: [],
    expected: [],
    unresolved: [],
    regressions: [],
    protections: [],
    review: [],
    history: [],
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
        api.getLearningSummary(date),
        api.getLearningEvents(date),
        api.getLearningRecurring(),
        api.getLearningExpected(),
        api.getLearningUnresolved(),
        api.getLearningRegressions(),
        api.getLearningProtections(),
        api.getLearningReviewQueue(),
        api.getLearningHistory(30),
      ])
        .then(([summary, events, recurring, expected, unresolved, regressions, protections, review, history]) => {
          if (cancelled) return;
          setState({
            summary,
            events: events?.events ?? [],
            recurring: recurring?.events ?? [],
            expected: expected?.events ?? [],
            unresolved: unresolved?.events ?? [],
            regressions: regressions?.cases ?? [],
            protections: protections?.protections ?? [],
            review: review?.queue ?? [],
            history: history?.runs ?? [],
            loading: false,
            isLive: true,
            error: null,
          });
        })
        .catch((err: any) => {
          if (cancelled) return;
          // Surfaced rather than swallowed: an unreachable backend must not
          // render as a clean audit.
          setState((s) => ({ ...s, loading: false, isLive: false, error: err?.message ?? 'unreachable' }));
        });
    };

    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [date, nonce]);

  return { ...state, refresh };
}
