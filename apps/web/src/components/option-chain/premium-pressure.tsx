'use client';

// ============================================================
// GAMMA EXPOSURE · EXPIRY PREMIUM PRESSURE (GXP) — read-only view of /api/premium-pressure
// ============================================================
// The server's latest read for the index on screen: estimated GEX and gamma flip, CE / PE premium change, writer
// pressure, the decay classification (theta / IV / directional), the multi-strike table and the explanation.
// Everything here is SIMULATED / paper research. Times are IST.
// ============================================================

import React, { useEffect, useState } from 'react';
import type { PpAnalysis, PpSideRead } from '@fno/analytics';
import { api } from '@/lib/api';
import { Empty, Kpi, Panel, Pill, type Tone } from '@/components/command-center/panel';

interface GxpEvent { at: number; symbol: string; classification: string; state: string; score: number; confidence: number; decision: string | null }
interface GxpPayload { version: string; paperEntries: boolean; windowsMin: number[]; reads: PpAnalysis[]; events: GxpEvent[] }

const ist = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const words = (s: string) => s.replace(/_/g, ' ').toLowerCase();
const sign = (v: number | null | undefined, unit = '%') => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}${unit}`);
const cls = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'cc-up' : 'cc-down');
const TONE: Record<string, Tone> = { BULLISH_PREMIUM_PRESSURE: 'ok', BEARISH_PREMIUM_PRESSURE: 'bad', DUAL_SIDE_COMPRESSION: 'info', PREMIUM_TRAP: 'warn', DATA_GAP: 'off', NONE: 'off' };
const ROW_TONE: Record<string, Tone> = { BULLISH: 'ok', BEARISH: 'bad', DUAL_COMPRESSION: 'info', NEUTRAL: 'off', NO_DATA: 'off' };

function Side({ s, windows }: { s: PpSideRead; windows: number[] }) {
  return (
    <div className="flex flex-col gap-1.5 text-[12.5px]">
      <div className="flex justify-between"><span className="text-[var(--text-muted)]">{s.side} premium ({windows.map((w) => `${w}m`).join(' / ')})</span><span className="cc-num">{s.changePct.map((x, i) => <span key={i} className={cls(x)}>{i ? ' / ' : ''}{sign(x)}</span>)}</span></div>
      <div className="flex justify-between"><span className="text-[var(--text-muted)]">Beyond spot move + theta</span><span className={`cc-num ${cls(s.pressurePct)}`}>{sign(s.pressurePct)}</span></div>
      <div className="flex justify-between"><span className="text-[var(--text-muted)]">OI change · IV change</span><span className="cc-num"><span className={cls(s.oiChangePct)}>{sign(s.oiChangePct)}</span> · <span className={cls(s.ivChange)}>{sign(s.ivChange, '')}</span></span></div>
      <div className="flex justify-between"><span className="text-[var(--text-muted)]">Decay</span><span>{words(s.decay)}{s.decompositionReliable ? '' : ' (unreliable)'}</span></div>
      <div className="flex justify-between"><span className="text-[var(--text-muted)]">{s.side} writer pressure</span><span className="cc-num">{s.writerPressure} / 100</span></div>
    </div>
  );
}

export function PremiumPressurePanel({ symbol }: { symbol: string }) {
  const [data, setData] = useState<GxpPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.getPremiumPressure<GxpPayload>().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => { if (live) setError(e instanceof Error ? e.message : 'unavailable'); });
    void load();
    const t = setInterval(load, 20_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const a = data?.reads.find((r) => r.symbol === symbol) ?? null;
  const events = (data?.events ?? []).filter((e) => e.symbol === symbol).slice(0, 6);
  const title = <>Gamma exposure · premium pressure <small>· {symbol} · simulated</small></>;
  if (!a) {
    return (
      <Panel title={title} meta={data ? `Paper entries ${data.paperEntries ? 'on' : 'off'}` : undefined}>
        <Empty>{error ? `Premium-pressure read unavailable (${error}).` : data ? `No read for ${symbol} yet — the server samples NIFTY, BANKNIFTY, FINNIFTY, SENSEX and BANKEX each minute while their market is open.` : 'Loading…'}</Empty>
      </Panel>
    );
  }
  const g = a.gex;
  return (
    <Panel title={title} meta={<>As of {ist(a.at)} IST · {words(a.period)} · paper entries {data?.paperEntries ? 'on' : 'off'}</>}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={TONE[a.classification] ?? 'off'}>{words(a.classification)}</Pill>
          <Pill tone={a.state.includes('BULLISH') ? 'ok' : a.state.includes('BEARISH') ? 'bad' : a.state === 'LOW_CONFIDENCE' ? 'warn' : 'off'}>{words(a.state)}</Pill>
          <Pill tone={a.dataQuality.status === 'OK' ? 'ok' : a.dataQuality.status === 'DEGRADED' ? 'warn' : 'bad'}>data {words(a.dataQuality.status)}</Pill>
          {a.dataQuality.issues.length > 0 && <span className="cc-note">{a.dataQuality.issues.map(words).join(' · ')}</span>}
        </div>
        <section aria-label="Premium pressure summary" className="cc-strip" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
          <Kpi label="Directional bias" value={a.score > 0 ? `+${a.score}` : `${a.score}`} sub="−100 bearish … +100 bullish" valueClass={cls(a.score)} />
          <Kpi label="Confidence" value={`${a.confidence}`} sub="independent evidence available and agreeing" />
          <Kpi label="Net GEX (estimated)" value={g ? g.netGex.toLocaleString('en-IN') : '—'} sub={g ? `${words(g.regime)}${g.netGexChange != null ? ` · ${sign(g.netGexChange, '')}` : ''}` : 'unavailable'} />
          <Kpi label="Gamma flip (estimated)" value={g?.gammaFlip != null ? g.gammaFlip.toLocaleString('en-IN') : '—'} sub={g?.spotVsFlipPct != null ? `spot ${g.spotVsFlipPct >= 0 ? 'above' : 'below'} by ${Math.abs(g.spotVsFlipPct).toFixed(2)}%${g.flipCrossed ? ` · crossed ${g.flipCrossed.toLowerCase()}` : ''}` : 'no crossing in range'} />
          <Kpi label="Largest gamma strike" value={g?.gammaWall != null ? g.gammaWall.toLocaleString('en-IN') : '—'} sub={g ? (g.pinned ? 'spot pinned here' : `ATM share ${g.atmConcentration != null ? Math.round(g.atmConcentration * 100) : '—'}%`) : undefined} />
          <Kpi label="CE / PE writer pressure" value={`${a.ce?.writerPressure ?? '—'} / ${a.pe?.writerPressure ?? '—'}`} sub="0–100 each, probabilistic" />
        </section>
        {a.ce && a.pe && (
          <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            <Side s={a.ce} windows={data?.windowsMin ?? []} />
            <Side s={a.pe} windows={data?.windowsMin ?? []} />
          </div>
        )}
        {a.rows.length > 0 && (
          <div className="cc-scroll">
            <table className="cc-table" style={{ minWidth: 640 }}>
              <thead><tr><th>Strike</th><th className="r">CE premium Δ</th><th className="r">CE OI Δ</th><th className="r">PE premium Δ</th><th className="r">PE OI Δ</th><th>Pressure</th></tr></thead>
              <tbody>
                {a.rows.map((r) => (
                  <tr key={r.strike}>
                    <td className="cc-num">{r.strike.toLocaleString('en-IN')}{r.strike === a.atm ? ' · ATM' : ''}</td>
                    <td className={`r cc-num ${cls(r.ce?.changePct)}`} title={r.ce ? words(r.ce.oiRead) : undefined}>{sign(r.ce?.changePct)}</td>
                    <td className={`r cc-num ${cls(r.ce?.oiChangePct)}`}>{sign(r.ce?.oiChangePct)}</td>
                    <td className={`r cc-num ${cls(r.pe?.changePct)}`} title={r.pe ? words(r.pe.oiRead) : undefined}>{sign(r.pe?.changePct)}</td>
                    <td className={`r cc-num ${cls(r.pe?.oiChangePct)}`}>{sign(r.pe?.oiChangePct)}</td>
                    <td><Pill tone={ROW_TONE[r.pressure] ?? 'off'}>{words(r.pressure)}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex flex-col gap-1 text-[12.5px]">
          {a.explanation.map((line, i) => <p key={i} className={i === 0 ? '' : 'text-[var(--text-muted)]'}>{line}</p>)}
          {a.invalidation.length > 0 && <p className="cc-note">Invalidated if: {a.invalidation.join('; ')}.</p>}
        </div>
        {events.length > 0 && (
          <div className="flex flex-col gap-1 text-[12px]">
            <div className="cc-label">Recent read changes (IST)</div>
            {events.map((e, i) => <div key={i} className="flex justify-between gap-2"><span className="cc-num">{ist(e.at)} · {words(e.classification)} · score {e.score}</span><span className="text-[var(--text-muted)]">{e.decision ? `paper: ${words(e.decision)}` : ''}</span></div>)}
          </div>
        )}
        <p className="cc-note">Estimated GEX assumes dealers are long calls and short puts; OI reads are probabilistic, not participant identification. Paper research only — no order is ever placed.</p>
      </div>
    </Panel>
  );
}
