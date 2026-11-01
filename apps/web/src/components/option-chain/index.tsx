'use client';

// ============================================================
// OPTION CHAIN — strikes, two-sided books and the contract picker
// ============================================================
// The picker runs the fresh-start engine's chain-level admission checks (lib/command-center.ts pickContract) over
// the live chain, so the trader can see WHICH contract a signal would buy right now and WHY the neighbours fail.
// It is indicative: the engine also prices the payoff and checks exposure and the account before any paper fill.
// ============================================================

import React, { useMemo, useState } from 'react';
import type { OptionChainLeg } from '@fno/shared';
import { useChain } from '@/lib/use-chain';
import { useFreshStart } from '@/lib/use-fresh-start';
import { useNow } from '@/lib/use-health';
import { inr, pickContract } from '@/lib/command-center';
import { Empty, Kpi, Panel, Pill } from '@/components/command-center/panel';

const UNDERLYINGS: Array<{ symbol: string; exchange: string }> = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
  { symbol: 'FINNIFTY', exchange: 'NSE' },
  { symbol: 'MIDCPNIFTY', exchange: 'NSE' },
  { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'BANKEX', exchange: 'BSE' },
];

const f2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) || v <= 0 ? '—' : v.toFixed(2));
const lakh = (v: number) => (v / 100_000).toFixed(1);
const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}%`;

export function OptionChainPage() {
  const [u, setU] = useState(UNDERLYINGS[0]);
  const [expiry, setExpiry] = useState<string | undefined>(undefined);
  const [side, setSide] = useState<'CE' | 'PE'>('CE');
  const { chain, error, loading } = useChain(u.symbol, u.exchange, expiry);
  const fresh = useFreshStart();
  const now = useNow(2000);
  const capital = fresh.data?.capital ?? null;
  // Quote age is judged at the chain snapshot (what the engine sees at its own decision instant), not at browser time.
  const pick = useMemo(() => (chain ? pickContract(chain, side, capital, chain.timestamp) : null), [chain, side, capital]);
  const maxOi = chain ? Math.max(1, ...chain.strikes.flatMap((s) => [s.call?.oi ?? 0, s.put?.oi ?? 0])) : 1;
  const callWall = chain?.strikes.reduce<{ k: number; oi: number } | null>((b, s) => (s.call && (!b || s.call.oi > b.oi) ? { k: s.strike, oi: s.call.oi } : b), null);
  const putWall = chain?.strikes.reduce<{ k: number; oi: number } | null>((b, s) => (s.put && (!b || s.put.oi > b.oi) ? { k: s.strike, oi: s.put.oi } : b), null);
  const atm = chain?.strikes.find((s) => s.strike === chain.atmStrike);
  const atmIv = [atm?.call?.iv, atm?.put?.iv].filter((v): v is number => typeof v === 'number' && v > 0);
  const ageS = chain ? Math.max(0, (now - chain.timestamp) / 1000) : null;

  const select = (x: (typeof UNDERLYINGS)[number]) => {
    setU(x);
    setExpiry(undefined);
  };

  return (
    <div className="cc-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Underlying">
          {UNDERLYINGS.map((x) => (
            <button key={x.symbol} type="button" className="cc-chip cc-num" aria-pressed={u.symbol === x.symbol} onClick={() => select(x)}>
              {x.symbol}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Expiry">
          {(chain?.availableExpiries ?? []).slice(0, 5).map((e) => (
            <button key={e} type="button" className="cc-chip cc-num" aria-pressed={(expiry ?? chain?.expiry) === e} onClick={() => setExpiry(e)}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {error && !chain && <p role="alert" className="cc-panel px-4 py-3 text-sm" style={{ color: 'var(--status-warn)' }}>The {u.symbol} chain could not be loaded ({error}).</p>}

      <section aria-label="Chain summary" className="cc-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Kpi label="Spot" value={chain ? chain.spotPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : loading ? '…' : '—'} sub={chain?.underlyingChangePercent != null ? `${chain.underlyingChangePercent >= 0 ? '+' : '−'}${Math.abs(chain.underlyingChangePercent).toFixed(2)}% today` : undefined} valueClass={(chain?.underlyingChangePercent ?? 0) >= 0 ? '' : ''} />
        <Kpi label="ATM IV" value={atmIv.length ? `${(atmIv.reduce((a, b) => a + b, 0) / atmIv.length).toFixed(1)}%` : '—'} sub={chain ? `ATM ${chain.atmStrike.toLocaleString('en-IN')}` : undefined} />
        <Kpi label="PCR (OI)" value={chain ? chain.pcr.toFixed(2) : '—'} sub={chain ? `near-ATM ${chain.pcrDetail.nearAtmPCR.toFixed(2)}` : undefined} />
        <Kpi label="Max pain" value={chain ? chain.maxPain.toLocaleString('en-IN') : '—'} sub={chain ? `${chain.maxPainDistance >= 0 ? '+' : ''}${chain.maxPainDistance.toFixed(0)} pts from spot` : undefined} />
        <Kpi label="Days to expiry" value={chain ? chain.dte.toFixed(1) : '—'} sub={chain ? `Lot ${chain.lotSize}` : undefined} valueClass="cc-accent" />
        <Kpi label="Expected move" value={chain ? `±${chain.expectedMove.points.toFixed(0)}` : '—'} sub={chain ? `${chain.expectedMove.lowerBound.toFixed(0)} – ${chain.expectedMove.upperBound.toFixed(0)}` : undefined} />
        <Kpi label="Chain age" value={ageS != null ? `${ageS.toFixed(1)} s` : '—'} sub="Server snapshot" valueClass={ageS != null && ageS > 15 ? 'cc-down' : ''} />
      </section>

      <div className="cc-main">
        <div className="cc-col-wide">
          <Panel title={<>{u.symbol} chain <small>· {chain?.expiry ?? '—'}</small></>} meta="Shaded = in the money · ringed = picker choice" bodyClassName="cc-scroll">
            {!chain ? (
              <Empty>{loading ? 'Loading the chain…' : 'No chain available.'}</Empty>
            ) : (
              <table className="cc-table cc-chain" style={{ minWidth: 860 }}>
                <thead>
                  <tr>
                    <th>OI (L)</th><th className="r">Δ OI</th><th className="r">IV</th><th className="r">Delta</th><th className="r">Bid</th><th className="r">Ask</th>
                    <th className="strike">Strike</th>
                    <th>Bid</th><th>Ask</th><th>Delta</th><th>IV</th><th>Δ OI</th><th className="r">OI (L)</th>
                  </tr>
                  <tr><th colSpan={6} className="cc-up !pt-0">CALLS (CE)</th><th /><th colSpan={6} className="cc-down r !pt-0">PUTS (PE)</th></tr>
                </thead>
                <tbody>
                  {chain.strikes.map((s) => {
                    const isAtm = s.strike === chain.atmStrike;
                    const pickedCe = side === 'CE' && pick?.selected?.strike === s.strike;
                    const pickedPe = side === 'PE' && pick?.selected?.strike === s.strike;
                    const ceItm = s.strike < chain.spotPrice, peItm = s.strike > chain.spotPrice;
                    return (
                      <tr key={s.strike} className={isAtm ? 'atm' : ''}>
                        <LegCells leg={s.call} itm={ceItm} maxOi={maxOi} picked={pickedCe} mirror={false} />
                        <td className="strike">{s.strike.toLocaleString('en-IN')}</td>
                        <LegCells leg={s.put} itm={peItm} maxOi={maxOi} picked={pickedPe} mirror />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <aside className="cc-col-side" aria-label="Contract picker">
          <Panel title="Contract picker" accent meta={<span className="flex gap-1.5"><button type="button" className="cc-chip" aria-pressed={side === 'CE'} onClick={() => setSide('CE')}>Bullish · CE</button><button type="button" className="cc-chip" aria-pressed={side === 'PE'} onClick={() => setSide('PE')}>Bearish · PE</button></span>}>
            {!pick ? (
              <Empty>Waiting for the chain.</Empty>
            ) : !pick.selected ? (
              <Empty>No {side} strike passes the admission checks right now — a signal on {u.symbol} would be refused.</Empty>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="cc-num text-[17px] font-semibold">{u.symbol} {pick.selected.strike} {side}</span>
                  <span className="cc-num font-semibold cc-accent">ask {f2(pick.selected.leg.ask)}</span>
                </div>
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {pick.selected.checks.map((c) => (
                    <li key={c.rule} className="flex justify-between gap-2 text-[12px]">
                      <span className="flex items-center gap-2"><span className="cc-dot" style={{ color: c.ok ? 'var(--status-ok)' : 'var(--status-bad)' }} aria-hidden="true" />{c.rule}</span>
                      <span className="cc-num text-[var(--text-muted)]">{c.value}</span>
                    </li>
                  ))}
                </ul>
                {pick.sizing ? (
                  <div className="grid grid-cols-2 gap-2.5 border-t border-dashed border-[var(--border-secondary)] pt-3">
                    <div><div className="cc-label">Risk budget</div><div className="cc-num">{inr(pick.sizing.riskBudget)} (0.5%)</div></div>
                    <div><div className="cc-label">Entry (ask + tick)</div><div className="cc-num">{pick.sizing.entry.toFixed(2)}</div></div>
                    <div><div className="cc-label">Emergency stop</div><div className="cc-num">{pick.sizing.emergencyStop.toFixed(2)} (75%)</div></div>
                    <div><div className="cc-label">Size at stop</div><div className={`cc-num ${pick.sizing.lots > 0 ? '' : 'cc-down'}`}>{pick.sizing.lots > 0 ? `${pick.sizing.lots} lot · ${pick.sizing.units}` : '0 lots'}</div></div>
                  </div>
                ) : null}
                {pick.sizing && pick.sizing.lots === 0 && (
                  <p className="cc-panel px-3 py-2 text-[12px]" style={{ color: 'var(--status-warn)', borderColor: 'var(--status-warn)' }}>
                    One lot risks {inr((pick.sizing.entry - (pick.sizing.emergencyStop - 0.05)) * (chain?.lotSize ?? 0))} at the 75% emergency stop, above the {inr(pick.sizing.riskBudget)} budget — the engine would refuse this signal (ZERO PERMITTED LOTS). Cheaper premiums or a larger capital fit.
                  </p>
                )}
                {!pick.sizing && (
                  <p className="cc-note">Sizing needs the fresh-start capital, which the server has not reported.</p>
                )}
                <p className="cc-note">Indicative. The engine also prices the target and invalidation payoff (net ≥ 1.5R), and checks exposure and the account before a paper fill.</p>
              </div>
            )}
          </Panel>

          <Panel title="Rejected near the money" bodyClassName="">
            {!pick || pick.rejected.length === 0 ? (
              <Empty>No nearby strike was rejected.</Empty>
            ) : (
              pick.rejected.map((r) => (
                <div key={r.strike} className="flex justify-between gap-2 border-b border-[var(--border-primary)] px-4 py-2 text-[12px] last:border-b-0">
                  <span className="cc-num">{r.strike} {side}</span>
                  <span className="cc-down">{r.firstFailure} · {r.checks.find((c) => c.rule === r.firstFailure)?.value}</span>
                </div>
              ))
            )}
          </Panel>

          <Panel title="OI walls">
            {chain ? (
              <div className="flex flex-col gap-2 text-[12.5px]">
                <div className="flex justify-between"><span className="text-[var(--text-muted)]">Call wall</span><span className="cc-num">{callWall ? `${callWall.k.toLocaleString('en-IN')} · ${lakh(callWall.oi)} L` : '—'}</span></div>
                <div className="flex justify-between"><span className="text-[var(--text-muted)]">Put wall</span><span className="cc-num">{putWall ? `${putWall.k.toLocaleString('en-IN')} · ${lakh(putWall.oi)} L` : '—'}</span></div>
                <div className="flex justify-between"><span className="text-[var(--text-muted)]">Gamma regime</span><span><Pill tone={chain.gammaExposure.regime === 'SHORT_GAMMA' ? 'warn' : 'info'}>{chain.gammaExposure.regime.replace('_', ' ')}</Pill></span></div>
                <p className="cc-note">Context only — no fresh-start strategy trades on OI.</p>
              </div>
            ) : (
              <Empty>—</Empty>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function LegCells({ leg, itm, maxOi, picked, mirror }: { leg: OptionChainLeg | null; itm: boolean; maxOi: number; picked: boolean; mirror: boolean }) {
  const c = itm ? 'itm' : '';
  if (!leg) return <>{Array.from({ length: 6 }).map((_, i) => <td key={i} className={c}>—</td>)}</>;
  const bar = <span className="cc-oi" style={{ width: `${Math.round((leg.oi / maxOi) * 56)}px`, background: mirror ? 'var(--negative)' : 'var(--positive)' }} />;
  const chg = leg.oi - leg.changeOi > 0 ? (leg.changeOi / (leg.oi - leg.changeOi)) * 100 : 0;
  const chgCls = chg > 0 ? 'cc-up' : chg < 0 ? 'cc-down' : '';
  const cells = [
    <td key="oi" className={`${c} ${mirror ? 'r' : ''}`}>{mirror ? <>{lakh(leg.oi)} {bar}</> : <>{bar} {lakh(leg.oi)}</>}</td>,
    <td key="chg" className={`${c} ${mirror ? '' : 'r'} ${chgCls}`}>{pct(chg)}</td>,
    <td key="iv" className={`${c} ${mirror ? '' : 'r'}`}>{leg.iv > 0 ? leg.iv.toFixed(1) : '—'}</td>,
    <td key="d" className={`${c} ${mirror ? '' : 'r'} text-[var(--text-muted)]`}>{Number.isFinite(leg.delta) ? leg.delta.toFixed(2) : '—'}</td>,
    <td key="bid" className={`${c} ${mirror ? '' : 'r'}`}>{f2(leg.bid)}</td>,
    <td key="ask" className={`${c} ${mirror ? '' : 'r'}`}><span className={picked ? 'pick' : ''}>{f2(leg.ask)}</span></td>,
  ];
  return <>{mirror ? [cells[4], cells[5], cells[3], cells[2], cells[1], cells[0]] : cells}</>;
}
