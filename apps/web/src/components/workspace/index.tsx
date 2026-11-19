'use client';

// ============================================================
// WORKSPACE — linked panels on one screen, driven by the command bar
// ============================================================
// Chart · option chain · top-of-book quote · engine radar · paper account, all on the Workspace's linked symbol
// (useWorkspaceStore). A command ("BANKNIFTY OC"), a radar row, a preset (Alt+1…4) or a chain row changes it.
// Every number comes from the existing endpoints: the chart's candles, /api/option-chain, /api/fresh-start/status
// and /api/alerts. Nothing is invented; missing data renders "—" or an empty state. Colours are theme tokens, so the
// page follows the light / dark / system theme like every other page.
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BiasSnapshot, Exchange, OptionChain, OptionChainLeg } from '@fno/shared';
import { api } from '@/lib/api';
import { formatIstDateTime } from '@/lib/format';
import { InstrumentChart } from '@/components/dashboard/instrument-chart';
import { useChain } from '@/lib/use-chain';
import { useFreshStart } from '@/lib/use-fresh-start';
import { useNow } from '@/lib/use-health';
import { useAlerts } from '@/lib/use-alerts';
import { useFeedSummary } from '@/lib/use-feed-summary';
import { useMarketStore, useWorkspaceStore } from '@/stores';
import { exchangeFor, WORKSPACE_PRESETS, type WorkspaceFocus } from '@/lib/commands';
import { accountView, inr, istTime, pickContract, positionViews, radarReason, setupRadar, signedInr, signedR, STRATEGY_IDS, strategyHeader, type RadarCell, type RadarRow } from '@/lib/command-center';
import { Empty, Pill, type Tone } from '@/components/command-center/panel';
import { DHAN_RADAR_SETUPS, dhanCellText, useDhanRadar } from '@/lib/dhan-radar';

const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const lakh = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : (v / 1e5).toFixed(1));

function WsPanel({ id, code, title, meta, focused, children, className = '' }: { id: WorkspaceFocus; code: string; title: React.ReactNode; meta?: React.ReactNode; focused: boolean; children: React.ReactNode; className?: string }) {
  return (
    <section id={`ws-${id}`} aria-labelledby={`ws-${id}-h`} className={`ws-panel ${className}`} data-focused={focused || undefined}>
      <div className="ws-panel-head">
        <span className="ws-link" aria-hidden="true" />
        <h2 id={`ws-${id}-h`} className="ws-code">{code}</h2>
        <span className="ws-title">{title}</span>
        {meta && <span className="ws-meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

type DockTab = 'engine' | 'positions' | 'alerts' | 'radar';
const INDEX_NAMES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX'];

/** The engine's last bias assessment for one symbol (read-only snapshot; never runs the engine). Every minute. */
function useBias(symbol: string, exchange: string): BiasSnapshot | null {
  const [state, setState] = useState<{ key: string; data: BiasSnapshot | null } | null>(null);
  const key = `${exchange}:${symbol}`;
  useEffect(() => {
    let live = true;
    const load = async () => {
      try { const { data } = await api.getBiasSnapshot(symbol, exchange, 'INTRADAY'); if (live) setState({ key, data: data ?? null }); } catch { if (live) setState({ key, data: null }); }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [symbol, exchange, key]);
  return state?.key === key ? state.data : null;
}

export function WorkspacePage() {
  const { symbol, exchange, layout, focus, focusSeq, open, setLayout, tabs, closeTab } = useWorkspaceStore();
  const now = useNow(1000);
  const fresh = useFreshStart();
  const status = fresh.data;
  const { chain, error: chainError } = useChain(symbol, exchange);
  const bias = useBias(symbol, exchange);
  const positions = useMemo(() => positionViews(status), [status]);
  const openPositions = useMemo(() => positions.filter((p) => p.status !== 'CLOSED'), [positions]);
  const account = useMemo(() => accountView(status, positions, now), [status, positions, now]);
  const radar = useMemo(() => setupRadar(status, positions, now), [status, positions, now]);
  const names = useMemo(() => referenceNames(status), [status]);
  const myRow = useMemo(() => radar.find((r) => (names.get(r.instrument)?.name ?? r.instrument) === symbol) ?? null, [radar, names, symbol]);
  const [dock, setDock] = useState<DockTab>('engine');
  // The picked contract belongs to one underlying: switching symbol drops it without an effect.
  const [picked, setPicked] = useState<{ key: string; token: string } | null>(null);
  const pickedToken = picked?.key === `${exchange}:${symbol}` ? picked.token : null;
  const setPickedToken = (token: string) => setPicked({ key: `${exchange}:${symbol}`, token });

  // A command's focus scrolls its panel into view (and the CSS ring marks it for a moment). RADAR and TRADES live in
  // the dock now: the command opens the matching dock tab.
  const lastSeq = useRef(focusSeq);
  useEffect(() => {
    if (focusSeq === lastSeq.current) return;
    lastSeq.current = focusSeq;
    if (focus === 'radar' || focus === 'trades') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a command (an external event) chooses the dock tab
      setDock(focus === 'radar' ? 'radar' : 'positions');
      document.getElementById('ws-dock')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else document.getElementById(`ws-${focus}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focus, focusSeq]);

  // Alt+1…4: layout presets.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const p = WORKSPACE_PRESETS.find((x) => x.key === e.key);
      if (!p) return;
      e.preventDefault();
      setLayout(p.id, p.symbol, p.exchange);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setLayout]);

  // The picker's "quote ≤ 2 s old" rule is judged at the chain's own snapshot time (as the Option Chain page does).
  // Judged against the ticking clock, the pick existed for ~2 s after each 15 s poll and then vanished: QT flickered.
  const pick = useMemo(() => (chain ? pickContract(chain, 'CE', status?.capital ?? null, chain.timestamp, { stockOptions: exchange === 'NSE' && !INDEX_NAMES.includes(symbol) }) : null), [chain, status?.capital, exchange, symbol]);
  // QT shows: the contract clicked in OC, else the engine pick, else the ATM call — never an empty panel while a chain exists.
  const quoteLeg = useMemo(() => {
    const clicked = findLeg(chain, pickedToken);
    if (clicked) return { ...clicked, source: 'CLICKED' as const };
    if (pick?.selected) return { strike: pick.selected.strike, side: 'CE' as const, leg: pick.selected.leg, source: 'ENGINE' as const };
    const atm = chain?.strikes.find((x) => x.strike === chain.atmStrike);
    return atm?.call ? { strike: atm.strike, side: 'CE' as const, leg: atm.call, source: 'ATM' as const } : null;
  }, [chain, pickedToken, pick]);

  const shownTabs = tabs.some((t) => t.symbol === symbol && t.exchange === exchange) ? tabs : [...tabs, { symbol, exchange }];
  const mine = openPositions.filter((p) => p.contract.startsWith(`${symbol} `));
  const dockTabs: Array<{ id: DockTab; label: string }> = [
    { id: 'engine', label: `Engine on ${symbol}` },
    { id: 'positions', label: `Open positions (${openPositions.length})` },
    { id: 'alerts', label: 'Alerts' },
    { id: 'radar', label: `All instruments (${radar.length})` },
  ];

  return (
    <div className="ws-page tr-page" data-layout={layout}>
      {fresh.error && <p role="alert" className="ws-banner">Engine status could not be refreshed ({fresh.error}).</p>}

      <div className="tr-tabs" role="tablist" aria-label="Open symbols">
        {shownTabs.map((t) => {
          const active = t.symbol === symbol && t.exchange === exchange;
          return (
            <div key={`${t.exchange}:${t.symbol}`} className="tr-tab" data-active={active || undefined}>
              <button type="button" role="tab" aria-selected={active} onClick={() => open(t.symbol, t.exchange, 'chart')}>
                {t.symbol} <small>{t.exchange}</small>
              </button>
              {shownTabs.length > 1 && <button type="button" className="tr-tab-x" aria-label={`Close ${t.symbol}`} onClick={() => closeTab(t.symbol, t.exchange)}>×</button>}
            </div>
          );
        })}
        <span className="tr-tabs-hint">Type a symbol in the command bar (/) to open another</span>
      </div>

      <InstrumentStrip symbol={symbol} exchange={exchange} chain={chain} bias={bias} mine={mine.length} />

      <div className="tr-grid">
        <WsPanel id="chart" code="CH" focused={focus === 'chart'} className="tr-area-chart" title={<>{symbol} <small>{exchange}{exchange === 'MCX' ? ' · futures' : ''}</small></>}>
          <div className="ws-chart tr-chart">
            <InstrumentChart key={`${exchange}:${symbol}`} symbol={symbol} exchange={exchange as Exchange} hasSpot={exchange !== 'MCX'} heightClass="h-[340px] md:h-[440px] xl:h-[600px]" />
          </div>
        </WsPanel>

        <WsPanel id="chain" code="OC" focused={focus === 'chain'} className="tr-area-chain" title={<>Option chain · {chain?.expiry ?? '—'}{chain ? ` · ${chain.dte} DTE` : ''}</>} meta={chain ? <span className="cc-num">lot {chain.lotSize ?? '—'}</span> : null}>
          <MiniChain chain={chain} error={chainError} pickedToken={quoteLeg?.leg.token ?? null} engineToken={pick?.selected?.leg.token ?? null} onPick={setPickedToken} />
          <div className="ws-foot">
            {pick?.selected ? (
              <>
                <span className="ws-accent cc-num">ENGINE PICK</span> {pick.selected.strike} CE · Δ {fmt(pick.selected.leg.delta)} · spread {pick.selected.spreadPct != null ? `${(pick.selected.spreadPct * 100).toFixed(2)}%` : '—'}
                {pick.sizing && <> · {pick.sizing.lots} lot{pick.sizing.lots === 1 ? '' : 's'} at 0.5% risk</>}
              </>
            ) : chain ? (
              <>No CE strike passes the engine&apos;s admission checks right now.</>
            ) : (
              <>Indicative: the engine also checks payoff, exposure and account state.</>
            )}
          </div>
        </WsPanel>

        <WsPanel id="quote" code="QT" focused={focus === 'quote'} className="tr-area-quote" title={quoteLeg ? <>{symbol} {quoteLeg.strike} {quoteLeg.side} <small>{quoteLeg.source === 'ENGINE' ? 'engine pick' : quoteLeg.source === 'ATM' ? 'ATM call' : 'your pick'} · click any bid/ask in OC</small></> : 'Best bid/ask'} meta={quoteLeg ? <span className="cc-num">{Math.max(0, (now - (quoteLeg.leg.exchangeTimestamp ?? quoteLeg.leg.timestamp)) / 1000).toFixed(0)} s old</span> : null}>
          <QuoteView q={quoteLeg?.leg ?? null} lot={chain?.lotSize ?? null} />
        </WsPanel>

        <section id="ws-dock" aria-label="Engine, positions and alerts" className="ws-panel tr-area-dock" data-focused={focus === 'radar' || focus === 'trades' || undefined}>
          <div className="tr-dock-head" role="tablist" aria-label="Dock">
            {dockTabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={dock === t.id} className="tr-dock-tab" onClick={() => setDock(t.id)}>{t.label}</button>)}
            <span className="ws-meta">{status ? <Pill tone={status.liveOrdersAllowed ? 'bad' : 'info'}>PAPER ONLY</Pill> : null}</span>
          </div>
          <div className="tr-dock-body">
            {dock === 'engine' && <EngineOn symbol={symbol} row={myRow} age={myRow ? names.get(myRow.instrument)?.age ?? null : null} loading={fresh.loading && !status} />}
            {dock === 'positions' && (
              <>
                <div className="ws-kpis cc-num">
                  <Kpi label="Capital" value={account.capital != null ? `₹${lakh(account.capital)} L` : '—'} />
                  <Kpi label="Today net" value={signedInr(account.todayNet)} tone={account.todayNet > 0 ? 'up' : account.todayNet < 0 ? 'down' : undefined} />
                  <Kpi label="Open risk" value={`${inr(account.openRisk)}`} sub={account.riskPerTrade != null ? `per trade ${inr(account.riskPerTrade)}` : undefined} />
                  <Kpi label="Today trades" value={`${account.todayTrades}`} sub={`${account.todayWins}W · ${account.todayLosses}L`} />
                </div>
                <OpenPositions positions={openPositions} />
              </>
            )}
            {dock === 'alerts' && <AlertsList />}
            {dock === 'radar' && <Radar rows={radar} names={names} onOpen={(name) => open(name, exchangeFor(name), 'chart')} loading={fresh.loading && !status} />}
          </div>
        </section>
      </div>
      <PresetBar active={layout} onPick={(p) => setLayout(p.id, p.symbol, p.exchange)} />
    </div>
  );
}

function InstrumentStrip({ symbol, exchange, chain, bias, mine }: { symbol: string; exchange: string; chain: OptionChain | null; bias: BiasSnapshot | null; mine: number }) {
  const chg = chain?.underlyingChangePercent ?? null;
  const atm = chain?.strikes.find((s) => s.strike === chain.atmStrike);
  const atmIv = atm?.call?.iv ?? atm?.put?.iv ?? null;
  const dir = bias?.direction ?? null;
  const dirTone = dir === 'BULLISH' ? 'td-up' : dir === 'BEARISH' ? 'td-dn' : 'td-mut';
  const cells: Array<[string, React.ReactNode]> = [
    ['Expiry', chain ? `${chain.expiry} · ${chain.dte} DTE` : '—'],
    ['PCR', fmt(chain?.pcr)],
    ['Max pain', fmt(chain?.maxPain, 0)],
    ['ATM IV', atmIv != null ? `${fmt(atmIv, 1)}%` : '—'],
    ['Engine bias', dir ? <span className={dirTone}>{dir === 'BULLISH' ? '▲' : dir === 'BEARISH' ? '▼' : '•'} {dir.toLowerCase()}{bias?.confidence != null ? ` · conf ${Math.round(bias.confidence)}` : ''}</span> : '—'],
    ['Regime', bias?.regime ? <span title={bias.assessedAt ? `assessed ${formatIstDateTime(Date.parse(String(bias.assessedAt)))}` : undefined}>{String(bias.regime).replaceAll('_', ' ').toLowerCase()}</span> : '—'],
    ['Paper open', mine ? `${mine} on ${symbol}` : 'none'],
  ];
  return (
    <section className="tr-strip" aria-label={`${symbol} summary`}>
      <div className="tr-sym">
        <div className="tr-sym-name">{symbol} <small>{exchange}{exchange === 'MCX' ? ' · futures' : ''}</small></div>
        <div className="tr-sym-px cc-num">
          {fmt(chain?.spotPrice)}
          {chg != null && <span className={chg >= 0 ? 'td-up' : 'td-dn'}> {chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%</span>}
        </div>
      </div>
      {cells.map(([k, v]) => <div key={k} className="tr-cell"><div className="td-kl">{k}</div><div className="tr-cv cc-num">{v}</div></div>)}
    </section>
  );
}

/** The engine's decision for each strategy on the open symbol today (the radar row, one card per strategy). */
function EngineOn({ symbol, row, age, loading }: { symbol: string; row: RadarRow | null; age: number | null; loading: boolean }) {
  const dhan = useDhanRadar();
  if (loading) return <Empty>Loading the engine status…</Empty>;
  const d = dhan[symbol];
  if (!row && !d) return <Empty>The engine has not evaluated {symbol} today. It watches the instruments in the &ldquo;All instruments&rdquo; tab.</Empty>;
  return (
    <div>
      <p className="tr-note">{row?.at ? `Last evaluated ${istTime(row.at)}` : 'Not evaluated by the rule engine today'}{age != null ? ` · signal age ${Math.round(age / 1000)} s` : ''}. Read-only: these are the engine&apos;s own decisions; nothing is placed from here.</p>
      <div className="tr-engine">
        {row && STRATEGY_IDS.map((s) => {
          const c = row.cells[s];
          const quiet = c.state === 'NOT_EVALUATED' || c.state === 'NO_SETUP';
          return (
            <div key={s} className="tr-eng" data-quiet={quiet || undefined} title={cellTitle(c)}>
              <div className="tr-eng-name">{strategyHeader(s)}</div>
              {quiet ? <span className="ws-dim">{cellText(c)}</span> : <Pill tone={CELL_TONE[c.state]}>{cellText(c)}</Pill>}
            </div>
          );
        })}
        {d && DHAN_RADAR_SETUPS.map((x) => {
          const t = dhanCellText(d.setups[x.key]);
          return (
            <div key={x.key} className="tr-eng" data-quiet={!t.tone || undefined}>
              <div className="tr-eng-name">{x.header} <small>order flow</small></div>
              {t.tone ? <Pill tone={t.tone}>{t.text}</Pill> : <span className="ws-dim">{t.text}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function findLeg(chain: OptionChain | null, token: string | null): { strike: number; side: 'CE' | 'PE'; leg: OptionChainLeg } | null {
  if (!chain || !token) return null;
  for (const s of chain.strikes) {
    if (s.call?.token === token) return { strike: s.strike, side: 'CE', leg: s.call };
    if (s.put?.token === token) return { strike: s.strike, side: 'PE', leg: s.put };
  }
  return null;
}

function MiniChain({ chain, error, pickedToken, engineToken, onPick }: { chain: OptionChain | null; error: string | null; pickedToken: string | null; engineToken: string | null; onPick: (token: string) => void }) {
  if (!chain) return error ? <Empty>The chain could not be loaded ({error}).</Empty> : <Empty>Loading the chain…</Empty>;
  const i = chain.strikes.findIndex((s) => s.strike === chain.atmStrike);
  const rows = chain.strikes.slice(Math.max(0, i - 6), Math.max(0, i - 6) + 13);
  const cell = (leg: OptionChainLeg | null) => {
    if (!leg) return <td colSpan={1}>—</td>;
    return (
      <td>
        <button type="button" className="ws-leg" aria-pressed={pickedToken === leg.token} data-engine={engineToken === leg.token || undefined} onClick={() => onPick(leg.token)} title="Show in QT">
          {fmt(leg.bid)}/{fmt(leg.ask)}
        </button>
      </td>
    );
  };
  return (
    <div className="cc-scroll">
      <table className="ws-table cc-num">
        <thead>
          <tr>
            <th>OI L</th>
            <th>Δ</th>
            <th>CE bid/ask</th>
            <th className="ws-strike">STRIKE</th>
            <th>PE bid/ask</th>
            <th>Δ</th>
            <th>OI L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.strike} data-atm={s.strike === chain.atmStrike || undefined}>
              <td>{s.call ? lakh(s.call.oi) : '—'}</td>
              <td>{s.call ? fmt(s.call.delta) : '—'}</td>
              {cell(s.call)}
              <td className="ws-strike">{s.strike.toLocaleString('en-IN')}{s.strike === chain.atmStrike ? ' ATM' : ''}</td>
              {cell(s.put)}
              <td>{s.put ? fmt(s.put.delta) : '—'}</td>
              <td>{s.put ? lakh(s.put.oi) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuoteView({ q, lot }: { q: OptionChainLeg | null; lot: number | null }) {
  if (!q) return <Empty>Waiting for the option chain. Click any bid/ask in OC to see it here.</Empty>;
  const mid = (q.bid + q.ask) / 2;
  const spread = q.ask - q.bid;
  const total = (q.bidQty ?? 0) + (q.askQty ?? 0);
  const bidShare = total > 0 ? (q.bidQty ?? 0) / total : 0.5;
  return (
    <div className="ws-quote cc-num">
      <div className="ws-book">
        <div><div className="cc-label">Bid · qty</div><div className="ws-big cc-up">{fmt(q.bid)}</div><div className="cc-note">{q.bidQty != null ? q.bidQty.toLocaleString('en-IN') : '—'}</div></div>
        <div><div className="cc-label">Ask · qty</div><div className="ws-big cc-down">{fmt(q.ask)}</div><div className="cc-note">{q.askQty != null ? q.askQty.toLocaleString('en-IN') : '—'}</div></div>
      </div>
      <div className="ws-imbalance" role="img" aria-label={`Bid share of top-of-book quantity: ${(bidShare * 100).toFixed(0)}%`}>
        <span style={{ width: `${bidShare * 100}%` }} />
      </div>
      <dl className="ws-dl">
        <dt>LTP</dt><dd>{fmt(q.ltp)} <span className={q.changePercent >= 0 ? 'cc-up' : 'cc-down'}>{q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(1)}%</span></dd>
        <dt>Spread</dt><dd>{fmt(spread)} ({mid > 0 ? ((spread / mid) * 100).toFixed(2) : '—'}%)</dd>
        <dt>IV · Δ</dt><dd>{fmt(q.iv, 1)} · {fmt(q.delta)}</dd>
        <dt>Θ / day</dt><dd>{fmt(q.theta)}{lot ? ` (₹${fmt(q.theta * lot, 0)} per lot)` : ''}</dd>
        <dt>OI · ΔOI</dt><dd>{lakh(q.oi)} L · {q.changeOi >= 0 ? '+' : ''}{lakh(q.changeOi)} L</dd>
        <dt>Read</dt><dd>{q.oiInterpretation ? String(q.oiInterpretation).replaceAll('_', ' ').toLowerCase() : '—'}</dd>
      </dl>
      <p className="cc-note">Top of book from the broker quote (the feed carries no deeper levels).</p>
    </div>
  );
}

/** Reference id → instrument name, from the engine's per-reference readiness (radar rows carry ids). */
function referenceNames(status: ReturnType<typeof useFreshStart>['data']): Map<string, { name: string; age: number | null }> {
  const out = new Map<string, { name: string; age: number | null }>();
  for (const r of status?.feedQualification?.referenceBlockers ?? []) out.set(r.id, { name: r.name, age: r.signalAgeMs ?? null });
  return out;
}

const CELL_TONE: Record<RadarCell['state'], Tone> = { IN_TRADE: 'ok', FILLED: 'ok', REFUSED: 'warn', NO_SETUP: 'off', NOT_EVALUATED: 'off' };
const cellText = (c: RadarCell) => (c.state === 'IN_TRADE' ? 'IN TRADE' : c.state === 'FILLED' ? 'FILLED' : c.state === 'NOT_EVALUATED' ? '—' : c.code ? radarReason(c) : c.state.replaceAll('_', ' '));
const cellTitle = (c: RadarCell) => [c.code, c.detail].filter(Boolean).join(' · ') || undefined;

function Radar({ rows, names, onOpen, loading }: { rows: ReturnType<typeof setupRadar>; names: Map<string, { name: string; age: number | null }>; onOpen: (name: string) => void; loading: boolean }) {
  const dhan = useDhanRadar();
  if (loading) return <Empty>Loading the engine status…</Empty>;
  if (!rows.length) return <Empty>No engine evaluation yet today.</Empty>;
  return (
    <div className="cc-scroll">
      <table className="ws-table ws-radar">
        <thead>
          <tr>
            <th>Instrument</th>
            {STRATEGY_IDS.map((s) => <th key={s}>{strategyHeader(s)}</th>)}
            {DHAN_RADAR_SETUPS.map((d) => <th key={d.key} title="Dhan order-flow engine v2 (all futures contracts; sampled order flow)">{d.header}</th>)}
            <th>Last</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ref = names.get(r.instrument);
            const name = ref?.name ?? r.instrument;
            return (
              <tr key={r.instrument}>
                <td>
                  <button type="button" className="ws-row-link" onClick={() => onOpen(name)} title={`Open ${name} in the workspace`}>{name}</button>
                </td>
                {STRATEGY_IDS.map((s) => {
                  const c = r.cells[s];
                  return <td key={s} title={cellTitle(c)}>{c.state === 'NOT_EVALUATED' || c.state === 'NO_SETUP' ? <span className="ws-dim">{cellText(c)}</span> : <Pill tone={CELL_TONE[c.state]}>{cellText(c)}</Pill>}</td>;
                })}
                {DHAN_RADAR_SETUPS.map((d) => {
                  const x = dhanCellText(dhan[name]?.setups[d.key]);
                  return <td key={d.key}>{x.tone ? <Pill tone={x.tone}>{x.text}</Pill> : <span className="ws-dim">{x.text}</span>}</td>;
                })}
                <td className="cc-num ws-dim">{r.at ? istTime(r.at) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div>
      <div className="cc-label">{label}</div>
      <div className={`ws-kpi ${tone === 'up' ? 'cc-up' : tone === 'down' ? 'cc-down' : ''}`}>{value}</div>
      {sub && <div className="cc-note">{sub}</div>}
    </div>
  );
}

function OpenPositions({ positions }: { positions: ReturnType<typeof positionViews> }) {
  const setActiveTab = useMarketStore((s) => s.setActiveTab);
  if (!positions.length) return <p className="ws-sub cc-note">No open paper position.</p>;
  return (
    <ul className="ws-positions">
      {positions.slice(0, 8).map((p) => {
        const live = p.markBid != null && p.units > 0 && p.riskCurrency > 0 ? ((p.markBid - p.entry) * p.units) / p.riskCurrency : null;
        return (
          <li key={p.id}>
            <button type="button" onClick={() => setActiveTab('paper-trades')} className="ws-position cc-num">
              <span className="ws-position-top"><span>{p.contract} ×{p.units}</span><span className={live != null && live < 0 ? 'cc-down' : 'cc-up'}>{signedR(live)}</span></span>
              <span className="cc-note">{p.strategyLabel} · in {fmt(p.entry)} · bid {fmt(p.markBid)} · stop {fmt(p.currentStop)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function AlertsList() {
  const { alerts } = useAlerts(8);
  return (
    <div className="ws-alerts">
      <div className="cc-label">Alerts</div>
      {alerts.length === 0 ? (
        <p className="cc-note">No alerts yet.</p>
      ) : (
        <ul>
          {alerts.slice(0, 8).map((a) => (
            <li key={a.id}>
              <span className="cc-num ws-dim">{istTime(a.triggeredAt ?? a.createdAt)}</span> <span>{a.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PresetBar({ active, onPick }: { active: string; onPick: (p: (typeof WORKSPACE_PRESETS)[number]) => void }) {
  const feed = useFeedSummary();
  return (
    <div className="ws-presets" role="toolbar" aria-label="Layouts">
      {WORKSPACE_PRESETS.map((p) => (
        <button key={p.id} type="button" className="ws-preset" aria-pressed={active === p.id} onClick={() => onPick(p)} title={`Alt+${p.key}`}>
          <span className="cc-num">ALT {p.key}</span> {p.label}
        </button>
      ))}
      <span className="ws-feed cc-num">Quotes: {feed.quotes.label}</span>
    </div>
  );
}
