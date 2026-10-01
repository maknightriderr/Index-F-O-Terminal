// ============================================================
// EVENT ENGINE — ordering, no look-ahead, triggers, grouping, timing,
// coverage, the major-move diagnostic and the registry
// ============================================================
// Synthetic tests always run. The real-data tests replay NIFTY and CRUDEOIL
// from backtest-data/ and skip when the snapshot is absent (as the
// SWEEP_CLOSE look-ahead test does).
// ============================================================

import { describe, it, expect } from 'vitest';
import {
  prepareMomentumSeries,
  buildSeriesContext,
  runSessionEvents,
  evaluateTriggersAt,
  entryTimingAt,
  groupIntoParents,
  detectMajorMoves,
  diagnoseMajorMove,
  classifySessionCoverage,
  inRecordingGap,
  TRIGGER_REGISTRY,
  RADAR_EVENT_TYPES,
  type MomentumBar,
  type TriggerCandidate,
  type SessionEventLog,
} from '@fno/analytics';
import { BACKTEST_DATA_DIR } from '../../backtest/fetch-history.js';
import { loadSymbol, sessionMasks, type LoadedSymbol } from '../../backtest/harness.js';
import { runMultiPath, gradeTrigger, decisionAllowed } from '../multipath.js';

const M15 = 15 * 60 * 1000;
const ist = (s: string) => Date.parse(`${s}+05:30`);

/** 25 fifteen-minute bars per NSE session (09:15–15:15 opens). */
function sessionBars(date: string, path: Array<[number, number, number, number]>): MomentumBar[] {
  const t0 = ist(`${date}T09:15:00`);
  return path.map(([open, high, low, close], k) => ({ time: t0 + k * M15, open, high, low, close, volume: 0 }));
}

/** A quiet session oscillating around `mid` with ~10-point bars. */
function quiet(date: string, mid: number): MomentumBar[] {
  return sessionBars(
    date,
    Array.from({ length: 25 }, (_, k) => {
      const o = mid + ((k % 4) - 1.5) * 2;
      const c = mid + (((k + 1) % 4) - 1.5) * 2;
      return [o, Math.max(o, c) + 4, Math.min(o, c) - 4, c] as [number, number, number, number];
    })
  );
}

/** 22 quiet sessions before the test day: enough for ATR and the 20-session average range. */
const QUIET_DAYS = Array.from({ length: 22 }, (_, k) => new Date(Date.parse('2026-07-15T12:00:00Z') + k * 86_400_000).toISOString().slice(0, 10));

/**
 * Day 6: price rises into the previous day's high (~107), pokes 5 points
 * above it and closes back below (a bearish sweep), prints a 3-bar swing low,
 * then closes through it (a bearish micro BOS), and falls toward the
 * previous day's low.
 */
function sweepDay(): MomentumBar[] {
  const path: Array<[number, number, number, number]> = [
    [100, 104, 96, 102],
    [102, 106, 99, 104],
    [104, 107, 101, 105],
    [105, 112, 103, 104], // bar 3: sweeps PDH (~107.5) and closes back below
    [104, 105, 100, 101],
    [101, 103, 98, 102], // bar 5: swing low at 98 (bar 5 lower than bars 4 and 6)
    [102, 104, 99, 100],
    [100, 101, 94, 95], // bar 7: closes below 98 → bearish micro BOS
    [95, 96, 90, 91],
    [91, 92, 86, 87],
    ...Array.from({ length: 15 }, (_, k) => [87 - k * 1.5, 89 - k * 1.5, 85 - k * 1.5, 87 - k * 1.5] as [number, number, number, number]),
  ];
  return sessionBars('2026-08-10', path);
}

function syntheticSeries() {
  const bars = [...QUIET_DAYS.flatMap((d) => quiet(d, 100)), ...sweepDay()];
  return prepareMomentumSeries(bars);
}

describe('event log (synthetic)', () => {
  const series = syntheticSeries();
  const ctx = buildSeriesContext(series);
  const s = series.sessionDates.indexOf('2026-08-10');
  const log = runSessionEvents(ctx, s);
  const start = series.sessionStarts[s];

  it('records the sweep, its reclaim and the micro BOS in chronological order', () => {
    const sweep = log.events.find((e) => e.type === 'SWEEP' && e.direction === 'BEARISH');
    const bos = log.events.find((e) => e.type === 'MICRO_BOS' && e.direction === 'BEARISH');
    expect(sweep?.barIndex).toBe(start + 3);
    expect(log.events.find((e) => e.type === 'RECLAIM' && e.parentId === sweep!.id)?.barIndex).toBe(start + 3);
    expect(bos?.barIndex).toBe(start + 7);
    expect(bos!.availableAt).toBe(series.bars[start + 7].time + M15);
  });

  it('every event is stamped at its bar close and every parent comes first', () => {
    for (let k = 1; k < log.events.length; k++) expect(log.events[k].barIndex).toBeGreaterThanOrEqual(log.events[k - 1].barIndex);
    for (const e of log.events) {
      expect(e.availableAt).toBe(e.time + M15);
      if (e.parentId) expect(log.byId.get(e.parentId)!.barIndex).toBeLessThanOrEqual(e.barIndex);
    }
  });

  it('A2 fires at the micro BOS bar with the sweep as anchor; its stop is beyond the sweep extreme', () => {
    const c = evaluateTriggersAt(ctx, log, start + 7, ['A2']);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ triggerId: 'A2', direction: 'BEARISH', decisionIndex: start + 7, entry: 95 });
    expect(c[0].anchorIndex).toBe(start + 3);
    expect(c[0].stop).toBeGreaterThan(112);
    // T1 is a real untaken pool below the entry (the previous day's low region), never a proxy.
    if (c[0].t1) expect(c[0].t1.price).toBeLessThan(95);
  });

  it('a replay that stops at bar t has exactly the events up to t', () => {
    for (let t = start; t <= start + 12; t++) {
      const partial = runSessionEvents(ctx, s, t);
      expect(partial.events.map((e) => e.id)).toEqual(log.events.filter((e) => e.barIndex <= t).map((e) => e.id));
    }
  });

  it('the radar flags only opportunity events', () => {
    expect(RADAR_EVENT_TYPES.has('LIQUIDITY_NEAR')).toBe(true);
    expect(RADAR_EVENT_TYPES.has('SWEEP')).toBe(false);
  });
});

describe('entry timing', () => {
  const base = { direction: 'BULLISH' as const, anchorIndex: 10, anchorPrice: 100, atr: 10, t1: 140 };
  it('EARLY on the anchor bar, then by share of the move used and R left', () => {
    expect(entryTimingAt({ ...base, decisionIndex: 10, entry: 101, rToT1: 3 }).class).toBe('EARLY');
    expect(entryTimingAt({ ...base, decisionIndex: 12, entry: 108, rToT1: 2.4 }).class).toBe('OPTIMAL');
    expect(entryTimingAt({ ...base, decisionIndex: 12, entry: 118, rToT1: 1.6 }).class).toBe('ACCEPTABLE');
    expect(entryTimingAt({ ...base, decisionIndex: 12, entry: 128, rToT1: 1.2 }).class).toBe('LATE');
    expect(entryTimingAt({ ...base, decisionIndex: 12, entry: 135, rToT1: 1.1 }).class).toBe('CHASING');
    expect(entryTimingAt({ ...base, decisionIndex: 12, entry: 105, rToT1: 0.8 }).class).toBe('CHASING');
    const t = entryTimingAt({ ...base, decisionIndex: 12, entry: 120, rToT1: 1.6 });
    expect(t).toMatchObject({ barsSinceAnchor: 2, travelledAtr: 2, moveConsumedPct: 0.5, currentRAvailable: 1.6 });
  });
});

describe('parent setups', () => {
  const mk = (over: Partial<TriggerCandidate>): TriggerCandidate =>
    ({ triggerId: 'A2', family: 'LIQUIDITY_REVERSAL', direction: 'BEARISH', session: 'D', decisionIndex: 10, anchorEventId: 'SWEEP:x', anchorIndex: 7, bucket: 'TRADE', ...over }) as TriggerCandidate;
  const logs = new Map<string, SessionEventLog>();

  it('one move, several families → one parent; a separate move → its own parent', () => {
    const cs = [
      mk({ triggerId: 'A2', decisionIndex: 10 }),
      mk({ triggerId: 'A4', decisionIndex: 12 }),
      mk({ triggerId: 'C1', family: 'TREND_CONTINUATION', decisionIndex: 13, anchorEventId: 'PULLBACK:y', anchorIndex: 11 }),
      mk({ triggerId: 'A2', decisionIndex: 40, anchorEventId: 'SWEEP:z', anchorIndex: 38 }),
      mk({ triggerId: 'B3', direction: 'BULLISH', decisionIndex: 11, anchorEventId: 'ORB:w', anchorIndex: 9 }),
    ];
    const parents = groupIntoParents(cs, logs);
    expect(parents).toHaveLength(3);
    const first = parents.find((p) => p.anchorEventId === 'SWEEP:x')!;
    expect(first.triggerIds).toEqual(['A2', 'A4', 'C1']);
    expect(first.families).toEqual(['LIQUIDITY_REVERSAL', 'TREND_CONTINUATION']);
    expect(first.stages.firstAvailable).toBe(10);
    // Every candidate belongs to exactly one parent.
    expect(parents.flatMap((p) => p.candidates).sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('data coverage', () => {
  const open = ist('2026-10-01T09:15:00');
  const close = ist('2026-10-01T15:30:00');
  const full = Array.from({ length: 25 }, (_, k) => ({ time: open + k * M15, open: 100 + k, high: 102 + k, low: 99 + k, close: 101 + k }));

  it('COVERED with every bar and the recorder up from before the open', () => {
    expect(classifySessionCoverage({ sessionOpen: open, sessionClose: close, barMs: M15, bars: full, boots: [open - 3600_000] }).coverage).toBe('COVERED');
  });
  it('PARTIAL with a restart mid-session, and the gap is excluded from misses', () => {
    const boot = ist('2026-10-01T11:00:00');
    const r = classifySessionCoverage({ sessionOpen: open, sessionClose: close, barMs: M15, bars: full, boots: [open - 3600_000, boot] });
    expect(r.coverage).toBe('PARTIAL');
    expect(inRecordingGap(ist('2026-10-01T11:00:00'), r.gaps, M15)).toBe(true);
    expect(inRecordingGap(ist('2026-10-01T13:00:00'), r.gaps, M15)).toBe(false);
  });
  it('UNCOVERED before the recorder ever started; DATA_GAP with a quarter of bars missing', () => {
    expect(classifySessionCoverage({ sessionOpen: open, sessionClose: close, barMs: M15, bars: full, boots: [close + 60_000] }).coverage).toBe('UNCOVERED');
    expect(classifySessionCoverage({ sessionOpen: open, sessionClose: close, barMs: M15, bars: full.slice(0, 15), boots: null }).coverage).toBe('DATA_GAP');
    expect(classifySessionCoverage({ sessionOpen: open, sessionClose: close, barMs: M15, bars: full.slice(0, 23), boots: null }).coverage).toBe('PARTIAL');
  });
  it('stale bars (identical OHLC) count against coverage', () => {
    const stale = full.map((b, k) => (k > 0 && k < 10 ? { ...full[0], time: b.time } : b));
    expect(classifySessionCoverage({ sessionOpen: open, sessionClose: close, barMs: M15, bars: stale, boots: null }).coverage).toBe('DATA_GAP');
  });
});

describe('major-move diagnostic', () => {
  const series = syntheticSeries();
  const ctx = buildSeriesContext(series);
  const s = series.sessionDates.indexOf('2026-08-10');
  const end = ctx.sessionEnd(s);
  const moves = detectMajorMoves(series, s, end, ctx.adrAt(s));
  const log = runSessionEvents(ctx, s);

  it('finds the session leg from its extreme', () => {
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ direction: 'BEARISH', startIndex: series.sessionStarts[s] + 3 });
  });
  it('a data problem is never a miss; no setup is CORRECTLY_UNTRADEABLE; an actionable setup is a miss of its family', () => {
    const cand = { triggerId: 'A2', family: 'LIQUIDITY_REVERSAL', direction: 'BEARISH', decisionIndex: series.sessionStarts[s] + 7, entry: 95, bucket: 'TRADE' } as TriggerCandidate;
    expect(diagnoseMajorMove({ move: moves[0], coverage: 'PARTIAL', events: log.events, candidates: [cand], traded: null }).classification).toBe('DATA_GAP');
    expect(diagnoseMajorMove({ move: moves[0], coverage: 'COVERED', events: log.events, candidates: [], traded: null }).classification).toBe('CORRECTLY_UNTRADEABLE');
    expect(diagnoseMajorMove({ move: moves[0], coverage: 'COVERED', events: log.events, candidates: [{ ...cand, bucket: 'LOW_RR' }], traded: null }).classification).toBe('RISK_REJECTED');
    expect(diagnoseMajorMove({ move: moves[0], coverage: 'COVERED', events: log.events, candidates: [cand], traded: true }).classification).toBe('TRADED');
    const d = diagnoseMajorMove({ move: moves[0], coverage: 'COVERED', events: log.events, candidates: [cand], traded: null });
    expect(d.classification).toBe('MISSED_LIQUIDITY');
    expect(d.firstActionable?.remainingMovePct).toBeGreaterThan(0.5);
    expect(d.firstEvent?.type).toBe('SWEEP');
    expect(diagnoseMajorMove({ move: moves[0], coverage: 'COVERED', events: log.events, candidates: [cand], traded: null, optionRefused: () => true }).classification).toBe('OPTION_REJECTED');
    const late = { ...cand, decisionIndex: series.sessionStarts[s] + 10, entry: 86 };
    expect(diagnoseMajorMove({ move: moves[0], coverage: 'COVERED', events: log.events, candidates: [late], traded: null }).classification).toBe('LATE_ENTRY');
  });
});

describe('trigger registry', () => {
  it('every trigger carries the full research definition and a known status', () => {
    const ids = new Set<string>();
    for (const t of TRIGGER_REGISTRY) {
      expect(ids.has(t.triggerId)).toBe(false);
      ids.add(t.triggerId);
      for (const f of ['exactRule', 'decisionBar', 'entryRule', 'stopRule', 'targetRule', 'allowedDataAtDecision', 'noLookAheadDefinition'] as const) expect(t[f].length).toBeGreaterThan(10);
      expect(['RESEARCH', 'SHADOW', 'PAPER', 'ACTIVE', 'RETIRED']).toContain(t.status);
    }
  });
  it('nothing is ACTIVE or PAPER, and the SWEEP_CLOSE restatements are RETIRED with their evidence', () => {
    expect(TRIGGER_REGISTRY.filter((t) => t.status === 'ACTIVE' || t.status === 'PAPER')).toEqual([]);
    for (const id of ['A1', 'F4']) {
      const t = TRIGGER_REGISTRY.find((x) => x.triggerId === id)!;
      expect(t.status).toBe('RETIRED');
      expect(t.priorEvidence).toMatch(/SWEEP_CLOSE/);
    }
  });
  it('covers all six families', () => {
    expect(new Set(TRIGGER_REGISTRY.map((t) => t.family)).size).toBe(6);
  });
});

describe('isolation from live trading', () => {
  it('no live decision module reads the event engine or the research triggers', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const engineNames = /\b(TRIGGER_REGISTRY|evaluateTriggersAt|runSessionEvents|buildSeriesContext|diagnoseMajorMove|groupIntoParents|multipath)\b/;
    for (const f of ['market-bias.ts', 'structure-live.ts', 'setup-lifecycle.ts', 'validation-gates.ts', 'setup-events.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../../services/${f}`, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(engineNames);
    }
  });
});

describe('session guards', () => {
  it('no decision in the first 5 minutes or the last 60', () => {
    expect(decisionAllowed('NSE', '2026-10-01', ist('2026-10-01T09:15:00'))).toBe(false);
    expect(decisionAllowed('NSE', '2026-10-01', ist('2026-10-01T09:30:00'))).toBe(true);
    expect(decisionAllowed('NSE', '2026-10-01', ist('2026-10-01T14:15:00'))).toBe(true);
    expect(decisionAllowed('NSE', '2026-10-01', ist('2026-10-01T14:30:00'))).toBe(false);
  });
});

// ---------------- real data ----------------

function truncate(loaded: LoadedSymbol, uptoInclusive: number): LoadedSymbol {
  const series = prepareMomentumSeries(loaded.series.bars.slice(0, uptoInclusive + 1));
  return { ...loaded, series, ...sessionMasks(series, loaded.spec.futuresPrice) };
}

const SYMBOLS = [
  { symbol: 'NIFTY', exchange: 'NSE' as const, priceFile: 'NIFTY_INDEX', volumeFile: 'NIFTY_FUT', futuresPrice: false },
  { symbol: 'CRUDEOIL', exchange: 'MCX' as const, priceFile: 'CRUDEOIL', futuresPrice: true },
];

for (const spec of SYMBOLS) {
  const full = loadSymbol(BACKTEST_DATA_DIR, spec);
  describe(`${spec.symbol} on stored bars (skips without the snapshot)`, () => {
    if (!full || full.series.bars.length < 1000) {
      it.skip('snapshot not present', () => {});
      return;
    }
    const run = runMultiPath(spec.symbol, full, spec.exchange);

    it('no look-ahead: events and candidates at bar t are identical when the series ends at t', () => {
      const n = full.series.bars.length;
      const stride = Math.max(1, Math.floor(n / 60));
      let checked = 0;
      for (let t = 400; t < n - 30; t += stride) {
        const session = full.series.sessionDates[full.series.sessionIdx[t]];
        const fullLog = run.logs.get(session);
        if (!fullLog) continue;
        const trunc = truncate(full, t);
        const ctxT = buildSeriesContext(trunc.series);
        const sT = trunc.series.sessionDates.indexOf(session);
        const logT = runSessionEvents(ctxT, sT);
        const strip = (es: typeof fullLog.events) => es.map((e) => ({ id: e.id, price: e.price, measures: e.measures, parentId: e.parentId }));
        expect(strip(logT.events)).toEqual(strip(fullLog.events.filter((e) => e.barIndex <= t)));
        // Masked sessions (thin data, contract rolls) take no candidates in the full run, by the harness's own rule.
        if (!full.masked.has(session) && decisionAllowed(spec.exchange, session, full.series.bars[t].time)) {
          const a = evaluateTriggersAt(ctxT, logT, t);
          const b = run.candidates.filter((c) => c.decisionIndex === t);
          const key = (c: TriggerCandidate) => `${c.triggerId}:${c.direction}:${c.entry}:${c.stop}:${c.t1?.price ?? '-'}:${c.bucket}:${c.anchorEventId}`;
          expect(a.map(key).sort()).toEqual(b.map(key).sort());
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(20);
    }, 120_000);

    it('every candidate decides at a bar after or on its anchor, with a stop on the losing side of its entry', () => {
      for (const c of run.candidates) {
        expect(c.decisionIndex).toBeGreaterThanOrEqual(c.anchorIndex);
        if (c.bucket !== 'INVALID_STOP') expect(c.direction === 'BULLISH' ? c.stop < c.entry : c.stop > c.entry).toBe(true);
        if (c.bucket === 'TRADE') expect(c.rToT1!).toBeGreaterThanOrEqual(1.5);
      }
    });

    it('a trigger holds one trade at a time per symbol, and a rejected bucket never occupies it', () => {
      for (const t of TRIGGER_REGISTRY) {
        const { trades } = gradeTrigger(run, t.triggerId);
        for (let k = 1; k < trades.length; k++) {
          const prev = trades[k - 1];
          expect(trades[k].candidate.decisionIndex).toBeGreaterThan(prev.candidate.decisionIndex + prev.barsHeld - 0);
        }
      }
    });

    it('every candidate sits in exactly one parent setup', () => {
      const all = run.parents.flatMap((p) => p.candidates).sort((a, b) => a - b);
      expect(all).toEqual(run.candidates.map((_, i) => i));
    });

    it('no major move on an uncovered session is called a miss', () => {
      for (const m of run.majorMoves) if (m.coverage !== 'COVERED') expect(m.classification).toBe('DATA_GAP');
    });
  });
}
