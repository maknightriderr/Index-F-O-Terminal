'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { MOCK_OPTION_CHAIN_SUMMARY } from './mock-data';
import type { OptionChain } from '@fno/shared';

const POLL_INTERVAL_MS = 15000; // backend self-caches the full chain at 10s, this just avoids re-fetching faster than that

export interface OptionChainSummary {
  callOi: number;
  putOi: number;
  callOiChange: number;
  putOiChange: number;
  pcr: number;
  maxPain: number;
  atmIv: number;
  highestCallOiStrike: number | null;
  highestPutOiStrike: number | null;
}

function summarize(chain: OptionChain): OptionChainSummary {
  let callOi = 0;
  let putOi = 0;
  let callOiChange = 0;
  let putOiChange = 0;
  let highestCallOi = -1;
  let highestCallOiStrike: number | null = null;
  let highestPutOi = -1;
  let highestPutOiStrike: number | null = null;

  for (const s of chain.strikes) {
    if (s.call) {
      callOi += s.call.oi;
      callOiChange += s.call.changeOi;
      if (s.call.oi > highestCallOi) {
        highestCallOi = s.call.oi;
        highestCallOiStrike = s.strike;
      }
    }
    if (s.put) {
      putOi += s.put.oi;
      putOiChange += s.put.changeOi;
      if (s.put.oi > highestPutOi) {
        highestPutOi = s.put.oi;
        highestPutOiStrike = s.strike;
      }
    }
  }

  const atmEntry = chain.strikes.find((s) => s.strike === chain.atmStrike);
  const atmIvSamples = [atmEntry?.call?.iv, atmEntry?.put?.iv].filter((v): v is number => !!v && v > 0);
  const atmIv = atmIvSamples.length > 0 ? atmIvSamples.reduce((a, b) => a + b, 0) / atmIvSamples.length : 0;

  return { callOi, putOi, callOiChange, putOiChange, pcr: chain.pcr, maxPain: chain.maxPain, atmIv, highestCallOiStrike, highestPutOiStrike };
}

/**
 * Option-chain summary (Call/Put OI, PCR, Max Pain, ATM IV, highest-OI
 * strikes) for any symbol/expiry — reduces the existing full chain
 * client-side rather than adding a new backend endpoint. Falls back to
 * realistic mock data (isLive: false) when the backend is unreachable.
 */
export function useOptionChainSummary(
  symbol = 'NIFTY',
  exchange = 'NSE',
  expiry?: string
): { data: OptionChainSummary | null; availableExpiries: string[]; currentExpiry: string | null; isLive: boolean; loading: boolean } {
  const [data, setData] = useState<OptionChainSummary | null>(MOCK_OPTION_CHAIN_SUMMARY);
  const [availableExpiries, setAvailableExpiries] = useState<string[]>([]);
  const [currentExpiry, setCurrentExpiry] = useState<string | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const poll = () => {
      api
        .getOptionChain(symbol, { exchange, expiry })
        .then((chain) => {
          if (cancelled || !chain) return;
          setData(summarize(chain));
          setAvailableExpiries(chain.availableExpiries);
          setCurrentExpiry(chain.expiry);
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
  }, [symbol, exchange, expiry]);

  return { data, availableExpiries, currentExpiry, isLive, loading };
}
