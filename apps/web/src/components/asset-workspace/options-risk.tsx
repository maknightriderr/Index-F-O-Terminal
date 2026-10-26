'use client';
import { useNow } from '@/lib/use-health';
import { useState } from 'react';
import type { OptionChain } from '@fno/shared';
import { Section } from '@/components/ui/card';
import { formatNumber, formatIstDateTime } from '@/lib/format';

/** Contract-specific sensitivity, not a forecast. Vega is rupees/share per IV percentage point. */
export function OptionsRisk({ chain }: { chain: OptionChain }) {
  const now = useNow(5000);
  const [strike, setStrike] = useState(chain.atmStrike);
  const [side, setSide] = useState<'call'|'put'>('call');
  const [drop, setDrop] = useState(2);
  const row = chain.strikes.find(r=>r.strike===strike);
  const leg = row?.[side];
  const valid = leg && Number.isFinite(leg.iv) && leg.iv > 0 && Number.isFinite(leg.vega) && leg.vega > 0 && Number.isFinite(leg.ltp) && leg.ltp > 0;
  const spread = leg && leg.bid > 0 && leg.ask >= leg.bid ? 100*(leg.ask-leg.bid)/((leg.ask+leg.bid)/2) : null;
  const loss = valid && drop < leg.iv ? Math.min(leg.ltp,leg.vega*drop) : null;
  return <Section title="IV & option risk" subtitle={`${chain.symbol} · expiry ${chain.expiry} · ${chain.dte} days to expiry · per-share values`}>
    <div className="mb-4 flex flex-wrap gap-4 text-sm"><label>Strike <select aria-label="Risk strike" className="rounded border border-[var(--border-primary)] bg-[var(--surface-card)] p-2" value={strike} onChange={e=>setStrike(Number(e.target.value))}>{chain.strikes.map(r=><option key={r.strike} value={r.strike}>{r.strike}</option>)}</select></label><label>Side <select aria-label="Risk option side" className="rounded border border-[var(--border-primary)] bg-[var(--surface-card)] p-2" value={side} onChange={e=>setSide(e.target.value as 'call'|'put')}><option value="call">CE</option><option value="put">PE</option></select></label><label>Hypothetical IV drop <select aria-label="IV drop scenario" className="rounded border border-[var(--border-primary)] bg-[var(--surface-card)] p-2" value={drop} onChange={e=>setDrop(Number(e.target.value))}>{[1,2,5].map(v=><option key={v} value={v}>{v} percentage points</option>)}</select></label></div>
    {leg ? <><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{[
      ['Premium',leg.ltp > 0 ? `₹${formatNumber(leg.ltp,2)}` : '—'],['IV',valid ? `${formatNumber(leg.iv,2)}%` : '—'],['Bid–ask spread',spread == null ? '—' : `${formatNumber(spread,2)}%`],['IV-drop premium impact',loss == null ? 'Unavailable' : `−₹${formatNumber(loss,2)}`],
      ['Delta',valid ? formatNumber(leg.delta,3) : '—'],['Gamma',valid ? formatNumber(leg.gamma,4) : '—'],['Theta / day',valid ? formatNumber(leg.theta,2) : '—'],['Vega / IV point',valid ? formatNumber(leg.vega,2) : '—'],['Volume',formatNumber(leg.volume,0)],['Open interest',formatNumber(leg.oi,0)],['Bid',leg.bid > 0 ? formatNumber(leg.bid,2) : '—'],['Ask',leg.ask > 0 ? formatNumber(leg.ask,2) : '—'],
    ].map(([label,value])=><div key={label} className="rounded-lg bg-[var(--surface-card-alt)] p-3"><p className="text-xs text-[var(--text-secondary)]">{label}</p><p className="mt-1 font-semibold tabular-nums">{value}</p></div>)}</div><p className="mt-3 text-xs text-[var(--text-secondary)]">Greeks: {leg.greeksSource}. Quote fetched: {formatIstDateTime(leg.timestamp,now)}. Exchange observation: {leg.exchangeTimestamp ? formatIstDateTime(leg.exchangeTimestamp,now) : 'unavailable; freshness not confirmed'}. Check timestamps before interpreting risk.</p></> : <p>Selected contract unavailable in the current chain.</p>}
    <p className="mt-3 text-sm text-[var(--text-secondary)]">IV-drop impact is a first-order vega estimate at unchanged spot and time, capped at premium. It excludes spreads, slippage, charges and changing Greeks; it is not an IV-crush prediction or an executable price. Select expiry in the option-chain panel below. Verified earnings timing and contract IV history are unavailable here; no event-risk or IV-percentile claim is made.</p>
  </Section>;
}
