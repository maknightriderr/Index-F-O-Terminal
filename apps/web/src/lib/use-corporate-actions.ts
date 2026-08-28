'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import type { CorporateAction } from '@fno/shared';

// Corporate actions are cached server-side for 6h and don't change
// intraday — a 30-minute poll is more than enough freshness without any
// real point to going faster.
const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Market-wide upcoming dividends/bonuses/splits/rights/buybacks across NSE, ex-date today or later. */
export function useUpcomingCorporateActions(): { actions: CorporateAction[]; isLive: boolean; loading: boolean } {
  const [actions, setActions] = useState<CorporateAction[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getUpcomingCorporateActions()
        .then((data) => {
          if (cancelled) return;
          setActions(data);
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

  return { actions, isLive, loading };
}

// Corporate actions only exist for NSE-listed equities — indices (NIFTY,
// BANKNIFTY, ...) and MCX commodities have none, so this doesn't fetch for
// them at all rather than hitting the API for a guaranteed-empty result on
// every asset-workspace visit.
export function useCorporateActionsForSymbol(symbol: string, exchange: string): { actions: CorporateAction[]; loading: boolean } {
  const [actions, setActions] = useState<CorporateAction[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (exchange !== 'NSE') {
      setActions([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getCorporateActionsForSymbol(symbol)
      .then((data) => {
        if (cancelled) return;
        setActions(data);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setActions([]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  return { actions, loading };
}
