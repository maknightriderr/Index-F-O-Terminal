'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { isMarketOpen, LIQUID_SPREAD_MAX_PCT, type FnoScannerRow } from '@fno/shared';
import { api } from '@/lib/api';
import { buildRadar, type RadarUniverseItem } from '@/lib/fno-radar';
import { formatNumber, formatSignedPercent, formatIstDateTime } from '@/lib/format';
import { useAssetTabsStore } from '@/stores';
import { Section } from '@/components/ui/card';

export function FnoRadar({ rows, now, asOf, error }: { rows: FnoScannerRow[]; now: number; asOf: number | null; error: string | null }) {
  const [universe, setUniverse] = useState<RadarUniverseItem[] | null>(null);
  const [universeError, setUniverseError] = useState(false);
  const [retry, setRetry] = useState(0);
  const previous = useRef<{ at: number; bull: number; bear: number } | null>(null);
  const [change, setChange] = useState<{ bull: number; bear: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getFnOStocks().then(data => { if (!cancelled) { setUniverse(data); setUniverseError(false); } }).catch(() => { if (!cancelled) setUniverseError(true); });
    return () => { cancelled = true; };
  }, [retry]);
  const open = isMarketOpen('NSE', now);
  const radar = useMemo(() => buildRadar(rows, universe, now, open), [rows, universe, now, open]);
  useEffect(() => {
    if (!asOf || !universe || error) return;
    const prev = previous.current;
    if (prev && asOf > prev.at) setChange({ bull: radar.bullish-prev.bull, bear: radar.bearish-prev.bear });
    if (!prev || asOf > prev.at) previous.current = { at: asOf, bull: radar.bullish, bear: radar.bearish };
  }, [asOf, universe, error, radar.bullish, radar.bearish]);
  const openTab = useAssetTabsStore(s => s.openTab);
  const counts = [['Eligible stocks', radar.total], ['Bullish', radar.bullish], ['Bearish', radar.bearish], ['Neutral', radar.neutral], ['Missing / stale', radar.unavailable]] as const;
  return <Section title="F&O Market Radar" subtitle="Day-scale price / futures OI / PCR screening · not a 15-minute entry signal">
    <p className="mb-3 text-sm text-[var(--text-secondary)]">{error ? 'Refresh failed — last received data only. ' : ''}{open ? 'Open-session snapshot' : 'Market closed · last recorded snapshot'} · {asOf ? formatIstDateTime(asOf, now) : 'No scan timestamp'}. Counts ignore table filters.</p>
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">{counts.map(([label,value]) => <div key={label} className="rounded-xl border border-[var(--border-primary)] bg-[var(--surface-card-alt)] p-4"><div className="text-xs text-[var(--text-secondary)]">{label}</div><div className="mt-1 text-3xl font-semibold tabular-nums">{value == null ? '—' : value}</div>{label !== 'Eligible stocks' && value != null && radar.total != null && radar.total > 0 && <span className="text-xs text-[var(--text-secondary)]">{(100*value/radar.total).toFixed(1)}% of eligible</span>}</div>)}</div>
    {universe == null && <p className="mt-2 text-sm text-[var(--status-warn)]">{universeError ? 'Universe unavailable; total and missing count cannot be verified.' : 'Loading eligible universe…'} Observed scan symbols: {radar.observed}. {universeError && <button className="underline" onClick={() => setRetry(n=>n+1)}>Retry universe</button>}</p>}
    <p className="my-3 text-xs text-[var(--text-secondary)]">{change ? `Since previous observed snapshot in this visit: bullish ${change.bull >= 0 ? '+' : ''}${change.bull}; bearish ${change.bear >= 0 ? '+' : ''}${change.bear}.` : 'Breadth change: waiting for a second snapshot in this visit.'} Missing/stale rows are not neutral. Outside the session, counts describe last-known data.</p>
    <div className="grid gap-4 xl:grid-cols-2">{([{name:'Top bullish candidates',list:radar.bull, tone:'var(--status-ok)'},{name:'Top bearish candidates',list:radar.bear,tone:'var(--status-bad)'}]).map(({name,list,tone}) => <div key={name} className="overflow-hidden rounded-xl border border-[var(--border-primary)]"><h3 className="border-b border-[var(--border-primary)] p-3 font-semibold" style={{color:tone}}>{name} <span className="text-xs">{list.length}/10</span></h3>{list.length ? list.map((r,i)=><button key={r.symbol} onClick={()=>openTab(r.symbol,r.exchange)} className="flex w-full items-center justify-between gap-3 border-b border-[var(--border-primary)] p-3 text-left hover:bg-[var(--surface-card-alt)]" aria-label={`Inspect ${r.symbol}`}><span><span className="mr-2 text-xs text-[var(--text-secondary)]">{i+1}</span><strong>{r.symbol}</strong><span className="mt-1 block text-xs text-[var(--text-secondary)]">{r.oiInterpretation.replaceAll('_',' ')} · RS {formatSignedPercent(r.relativeStrength)} · spread {r.atmSpreadPct?.toFixed(2)}%</span><span className="block text-xs text-[var(--text-secondary)]">Observed {formatIstDateTime(r.timestamp,now)} · setup not evaluated</span></span><span className="text-right tabular-nums"><span className="block">₹{formatNumber(r.price,2)}</span><span className="text-xs" style={{color:tone}}>{formatSignedPercent(r.changePercent)}</span><span className="block text-xs text-[var(--text-secondary)]">Score {formatNumber(r.score,0)} →</span></span></button>) : <p className="p-4 text-sm text-[var(--text-secondary)]">No qualifying candidates in this snapshot.</p>}</div>)}</div>
    <details className="mt-3 text-sm text-[var(--text-secondary)]"><summary className="cursor-pointer">How candidates are ranked</summary><p className="mt-2">Watchlist only: matching scanner bias, relative strength versus NIFTY in that direction, and recorded ATM average spread ≤ {LIQUID_SPREAD_MAX_PCT}%. Ordered by directional scanner score (higher for bullish, lower for bearish), directional relative strength, then symbol. Score is not a win probability. We do not fill ten slots with non-qualifying rows. Entry readiness, distance to trigger, next obstacle and contract-specific costs require stock-level analysis; they are not implied by this ranking. Missing universe limits coverage verification; missing spread excludes a candidate.</p></details>
  </Section>;
}
