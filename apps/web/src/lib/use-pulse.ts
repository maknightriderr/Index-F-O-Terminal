'use client';

// ============================================================
// MARKET PULSE — quotes, engine bias and the latest session's 5-minute path per instrument (Today screen)
// ============================================================
// Reads only what already exists: the live index quotes, GET /api/market/bias-snapshot (read-only, never runs the
// engine) and GET /api/market/historical (5-minute bars of the latest session that has any). MCX futures tokens come
// from the fresh-start status the screen already polls. Bias every minute, bars every five; nothing new on the server.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import type { FreshStartStatus } from '@fno/shared';
import { api } from './api';
import { useLiveIndices } from './use-live-indices';
import { istDayOf, PULSE_INSTRUMENTS, pulseRow, type Bar, type PulseInputs, type PulseRow } from './today';

const fmt = (t: number) => new Date(t + 19_800_000).toISOString().slice(0, 16).replace('T', ' ');

/** Bars of the newest IST day present (a weekend or pre-open screen shows the last session, labelled by its date). */
export function lastSessionBars(rows: ReadonlyArray<{ timestamp: string; open: number; high: number; low: number; close: number }>): Bar[] {
  const bars = rows.map((r) => ({ time: Date.parse(r.timestamp), open: r.open, high: r.high, low: r.low, close: r.close })).filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close)).sort((a, b) => a.time - b.time);
  if (!bars.length) return [];
  const day = istDayOf(bars[bars.length - 1].time);
  return bars.filter((b) => istDayOf(b.time) === day);
}

export function usePulse(status: FreshStartStatus | null, now: number): { rows: PulseRow[]; loading: boolean } {
  const { indices } = useLiveIndices();
  const [bias, setBias] = useState<Record<string, PulseInputs['bias']>>({});
  const [bars, setBars] = useState<Record<string, Bar[]>>({});
  const [loading, setLoading] = useState(true);

  // MCX futures tokens: the references the new engine is watching while MCX trades; outside the session (the list is
  // empty then) the spot-reference contract of GET /api/futures (read-only), fetched once per symbol.
  const [futTokens, setFutTokens] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void Promise.all(PULSE_INSTRUMENTS.filter((i) => i.exchange === 'MCX').map(async (i) => {
      try {
        const f = await api.getFutures(i.symbol, 'MCX');
        const c = f?.contracts?.find((x) => x.isSpotReference) ?? f?.contracts?.[0];
        return c?.token ? ([i.symbol, String(c.token)] as const) : null;
      } catch { return null; }
    })).then((got) => { if (live) setFutTokens(Object.fromEntries(got.filter((x): x is readonly [string, string] => x != null))); });
    return () => { live = false; };
  }, []);
  const mcxTokens = useMemo(() => {
    const out: Record<string, string> = { ...futTokens };
    for (const r of status?.feedQualification?.referenceBlockers ?? []) if (r.id.startsWith('MCX_FO:')) out[r.name] = r.id.slice(7);
    return out;
  }, [status, futTokens]);
  const indexTokens = useMemo(() => Object.fromEntries(indices.map((q) => [q.symbol, q.token])), [indices]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const got = await Promise.all(PULSE_INSTRUMENTS.map(async (i) => {
        try {
          const { data } = await api.getBiasSnapshot(i.symbol, i.exchange, 'INTRADAY');
          const inputs = ((data?.result as { bias?: { inputs?: Record<string, unknown> } } | null)?.bias?.inputs ?? {}) as Record<string, unknown>;
          const pcr = typeof inputs.pcr === 'number' ? inputs.pcr : data?.pcr ?? null;
          return [i.symbol, data ? { direction: data.direction ?? null, confidence: data.confidence ?? null, regime: data.regime ?? null, assessedAt: data.assessedAt ?? null, pcr } : null] as const;
        } catch { return [i.symbol, null] as const; }
      }));
      if (live) { setBias(Object.fromEntries(got)); setLoading(false); }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);

  const tokenKey = JSON.stringify([indexTokens, mcxTokens]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const to = Date.now(), from = to - 4 * 86_400_000;
      const got = await Promise.all(PULSE_INSTRUMENTS.map(async (i) => {
        const token = i.exchange === 'MCX' ? mcxTokens[i.symbol] : indexTokens[i.symbol];
        if (!token) return [i.symbol, [] as Bar[]] as const;
        try {
          const rows = await api.getHistoricalData(token, fmt(from), fmt(to), i.exchange, 'FIVE_MINUTE', i.exchange === 'MCX' ? 'FO' : undefined);
          return [i.symbol, lastSessionBars(rows as never)] as const;
        } catch { return [i.symbol, [] as Bar[]] as const; }
      }));
      if (live) setBars(Object.fromEntries(got));
    };
    void load();
    const t = setInterval(load, 300_000);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the token set changes, not on every poll
  }, [tokenKey]);

  const rows = useMemo(() => PULSE_INSTRUMENTS.map((i) => {
    const q = indices.find((x) => x.symbol === i.symbol);
    return pulseRow(i, { quote: q ? { ltp: q.ltp, changePercent: q.changePercent, low: q.low, high: q.high } : null, bars: bars[i.symbol], bias: bias[i.symbol] }, now);
  }), [indices, bars, bias, now]);
  return { rows, loading };
}
