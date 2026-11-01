'use client';

import { useEffect, useState } from 'react';
import type { OptionChain } from '@fno/shared';
import { api } from './api';

/** One underlying's option chain, polled every `ms` (the server caches the chain for ~10 s). */
export function useChain(symbol: string | null, exchange = 'NSE', expiry?: string, ms = 15_000): { chain: OptionChain | null; error: string | null; loading: boolean } {
  const key = `${exchange}:${symbol}:${expiry ?? ''}`;
  // The answer is tagged with the request it belongs to, so switching underlying never shows the previous chain.
  const [state, setState] = useState<{ key: string; chain: OptionChain | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!symbol) return;
    let active = true;
    const load = () =>
      api
        .getOptionChain(symbol, { exchange, expiry, strikeRange: 12 })
        .then((chain) => active && setState({ key, chain, error: null }))
        .catch((e) => active && setState((s) => ({ key, chain: s?.key === key ? s.chain : null, error: (e instanceof Error && e.message) || 'Option chain unavailable' })));
    void load();
    const t = setInterval(() => void load(), ms);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [symbol, exchange, expiry, ms, key]);
  const current = state?.key === key ? state : null;
  return { chain: current?.chain ?? null, error: current?.error ?? null, loading: !current };
}
