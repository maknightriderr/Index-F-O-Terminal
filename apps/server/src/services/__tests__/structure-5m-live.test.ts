// ============================================================
// STRUCTURE — live integration of the entry timeframe (round 2)
// ============================================================
//   - flag defaults follow the pre-registered backtest decisions;
//   - the lifecycle carries its timeframe, and a switch resets cleanly;
//   - the 5m loader's cache keys and ONE TTL for price and volume;
//   - Part A rule 4's noise ATR (noiseAtrPoints) is read by rule 4 only;
//   - the per-engine closing guard (structure 15 vs consensus 60) at the
//     NSE and MCX 23:30 / 23:55 boundaries, and the exchange-aware reason;
//   - a 5m structure trade exits on 5m closes; the alert names the timeframe.
// Every bar is a FABRICATED fixture.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTradeSetup, evaluateStructureSession, evaluateStructureSessionMTF, prepareMomentumSeries, STRUCTURE_5M_VARIANTS, STRUCTURE_VARIANTS, type MomentumBar } from '@fno/analytics';
import type { OptionChainLeg, OptionChainStrike } from '@fno/shared';
import {
  advanceLiveState,
  lifecycleIdOf,
  lifecycleView,
  RequestRateMeter,
  structure5mCacheKeys,
  structureBlock,
  structureSessionOpts,
  STRUCTURE_5M_PRICE_TTL_SECONDS,
  STRUCTURE_5M_VOLUME_TTL_SECONDS,
  structureSequenceDiagnostic,
  watchlistRows,
} from '../structure-live.js';
import { confirmedMessage } from '../setup-lifecycle.js';
import { closingGuardReason, minutesToSessionClose } from '../validation-gates.js';
import { STRUCTURE_STRATEGY, toClosedMomentumBars, triggerSlotAction } from '../momentum-break-live.js';
import {
  COVERAGE_LAG_FLAG_DEFAULTS,
  COVERAGE_LAG_PARAM_DEFAULTS,
  logicStamp,
  MOMENTUM_BREAK_DEFAULT,
  MOMENTUM_BREAK_PARAM_DEFAULTS,
  parseStructureEntryTimeframe,
  readStructureParams,
  STRUCTURE_5M_LOGIC_VERSION,
  STRUCTURE_ENTRY_TF_DEFAULT,
  STRUCTURE_LOGIC_VERSION,
  STRUCTURE_PARAM_DEFAULTS,
  TRADING_FLAG_DEFAULTS,
  TRADING_PARAM_DEFAULTS,
} from '../../config/trading-flags.js';
import { leg } from './trade-setup-fixtures.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const M5 = 5 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

// ---- fixtures: the canonical bearish PDH sweep, on 15m and on 5m ----
const TODAY = '2026-01-20';
function session(date: string, n: number, barMs: number, a: number, b: number): MomentumBar[] {
  let prev = b;
  return Array.from({ length: n }, (_, k) => {
    const c = k % 2 === 0 ? a : b;
    const x = { time: at(date, '09:15') + k * barMs, open: prev, high: Math.max(prev, c) + 0.2, low: Math.min(prev, c) - 0.2, close: c, volume: 1000 };
    prev = c;
    return x;
  });
}
function bars5(): MomentumBar[] {
  const out: MomentumBar[] = [];
  for (const d of ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16']) out.push(...session(d, 75, M5, 100, 100.5));
  const prev = session('2026-01-19', 75, M5, 100, 100.5);
  prev[10] = { ...prev[10], low: 97.0 };
  prev[50] = { ...prev[50], high: 102.0 };
  out.push(...prev, ...session(TODAY, 18, M5, 101.0, 101.3));
  const t = (k: number) => at(TODAY, '10:45') + k * M5;
  out.push(
    { time: t(0), open: 101.0, high: 102.3, low: 100.9, close: 101.6, volume: 1000 },
    { time: t(1), open: 101.6, high: 101.7, low: 100.1, close: 100.2, volume: 1000 },
    { time: t(2), open: 100.2, high: 100.6, low: 99.9, close: 100.3, volume: 1000 }
  );
  return out;
}
function to15(b5: MomentumBar[]): MomentumBar[] {
  const out: MomentumBar[] = [];
  for (const b of b5) {
    const t = Math.floor(b.time / M15) * M15;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}
const V5 = STRUCTURE_5M_VARIANTS[2]; // 5m-D1.5-C60, the in-sample choice
const eval5 = () => {
  const b = bars5();
  return evaluateStructureSessionMTF(prepareMomentumSeries(to15(b)), prepareMomentumSeries(b), b.length - 1, V5);
};
const eval15 = () => {
  const b = to15(bars5());
  return evaluateStructureSession(prepareMomentumSeries(b), b.length - 1, STRUCTURE_VARIANTS[1]);
};
const base = { exchange: 'NSE' as const, underlying: 'NIFTY', mode: 'INTRADAY' as const, day: TODAY, now: at(TODAY, '11:01'), spot: 100.3 };

describe('flag defaults follow the pre-registered decisions', () => {
  it("STRUCTURE_ENTRY_TF defaults to '15m' (5m lost the head-to-head); only '5m'/'15m' are accepted", () => {
    expect(STRUCTURE_ENTRY_TF_DEFAULT).toBe('15m');
    expect(parseStructureEntryTimeframe(undefined)).toEqual({ value: '15m', rejected: null });
    expect(parseStructureEntryTimeframe(' 5M ')).toEqual({ value: '5m', rejected: null });
    expect(parseStructureEntryTimeframe('1m')).toEqual({ value: '15m', rejected: '1m' });
  });
  it('STRUCTURE_CLOSING_GUARD_MIN defaults to 60 (the 15m in-sample choice); the 5m DISP_MULT is the 5m in-sample choice', () => {
    expect(STRUCTURE_PARAM_DEFAULTS.STRUCTURE_CLOSING_GUARD_MIN).toBe(60);
    expect(STRUCTURE_PARAM_DEFAULTS.STRUCTURE_5M_DISP_MULT).toBe(1.5);
    expect(readStructureParams({ STRUCTURE_CLOSING_GUARD_MIN: '15' }).STRUCTURE_CLOSING_GUARD_MIN).toBe(15);
    // Unchanged: the 15m variant and the momentum family's switch.
    expect(STRUCTURE_PARAM_DEFAULTS).toMatchObject({ STRUCTURE_DISP_MULT: 1, STRUCTURE_OPENING_GUARD: 0 });
    expect(MOMENTUM_BREAK_DEFAULT).toBe(false);
  });
  it("the logic stamp is structure.2 only while the timeframe is '5m'; 15m (or absent) stays structure.1", () => {
    const stamp = (entryTimeframe?: '5m' | '15m') =>
      logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS, COVERAGE_LAG_FLAG_DEFAULTS, COVERAGE_LAG_PARAM_DEFAULTS, [], false, MOMENTUM_BREAK_PARAM_DEFAULTS, [], {
        structure: { enabled: true, consensusSetups: true, params: STRUCTURE_PARAM_DEFAULTS, symbols: { all: true, symbols: [] }, ...(entryTimeframe ? { entryTimeframe } : {}) },
      });
    expect(stamp().logicVersion).toBe(STRUCTURE_LOGIC_VERSION);
    expect(stamp('15m').logicVersion).toBe(STRUCTURE_LOGIC_VERSION);
    expect(stamp('5m').logicVersion).toBe(STRUCTURE_5M_LOGIC_VERSION);
    expect(STRUCTURE_5M_LOGIC_VERSION).toBe('2026-09-29.structure.2');
    expect(stamp('5m').structure?.entryTimeframe).toBe('5m');
    expect(stamp().structure).not.toHaveProperty('entryTimeframe');
  });
});

describe('the lifecycle carries its timeframe', () => {
  it('5m lifecycles and WATCH rows get a 5m id segment and the timeframe field; 15m ids are unchanged', () => {
    expect(lifecycleIdOf('NSE', 'NIFTY', { id: 'BEARISH:1' })).toBe('NSE:NIFTY:BEARISH:1');
    expect(lifecycleIdOf('NSE', 'NIFTY', { id: 'BEARISH:1' }, '5m')).toBe('NSE:NIFTY:5m:BEARISH:1');
    const five = advanceLiveState({ prev: null, evaluation: eval5(), ...base, timeframe: '5m' });
    expect(five.state.timeframe).toBe('5m');
    const bear = five.state.lifecycles.find((l) => l.direction === 'BEARISH')!;
    expect(bear).toMatchObject({ stage: 'CONFIRMED', timeframe: '5m' });
    expect(bear.id).toMatch(/^NSE:NIFTY:5m:BEARISH:/);
    expect(five.events.every((e) => e.lifecycleId.startsWith('NSE:NIFTY:5m:'))).toBe(true);
    const fifteen = advanceLiveState({ prev: null, evaluation: eval15(), ...base });
    expect(fifteen.state.timeframe).toBe('15m');
    expect(fifteen.state.lifecycles.every((l) => !l.id.includes(':5m:'))).toBe(true);
  });

  it('a timeframe switch on the same day starts from empty and says so; the same timeframe carries state', () => {
    const s15 = advanceLiveState({ prev: null, evaluation: eval15(), ...base }).state;
    s15.lifecycles.forEach((l) => (l.live = { outcome: 'REFUSED', code: 'X', reason: null, at: 1 }));
    const switched = advanceLiveState({ prev: s15, evaluation: eval5(), ...base, timeframe: '5m' });
    expect(switched.reset).toEqual({ from: '15m', to: '5m' });
    // Nothing carried over: no live outcome, and every 5m transition is recorded from the start.
    expect(switched.state.lifecycles.every((l) => l.live == null)).toBe(true);
    expect(switched.events.filter((e) => e.toState === 'DEVELOPING' && e.direction === 'BEARISH')).toHaveLength(1);
    expect(switched.events.filter((e) => e.toState === 'CONFIRMED')).toHaveLength(1);
    const again = advanceLiveState({ prev: switched.state, evaluation: eval5(), ...base, timeframe: '5m' });
    expect(again.reset).toBeNull();
    expect(again.events.filter((e) => e.toState !== 'WATCH')).toHaveLength(0);
    // An old state without the field reads as 15m.
    const legacy = { ...s15 } as any;
    delete legacy.timeframe;
    expect(advanceLiveState({ prev: legacy, evaluation: eval15(), ...base }).reset).toBeNull();
  });

  it('views, the block and the watchlist show the timeframe; the 5m WATCH time is a 5m bar close', () => {
    const { state } = advanceLiveState({ prev: null, evaluation: eval5(), ...base, timeframe: '5m' });
    const lc = state.lifecycles.find((l) => l.direction === 'BEARISH')!;
    expect(lifecycleView(state, lc).timeframe).toBe('5m');
    expect(structureBlock(state, { enabled: true, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY' }).timeframe).toBe('5m');
    expect(structureBlock(null, { enabled: true, symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', timeframe: '5m' }).timeframe).toBe('5m');
    expect(watchlistRows(state).every((r) => r.timeframe === '5m')).toBe(true);
    expect(structureSequenceDiagnostic(lc, null, 0).threshold).toMatchObject({ fillWithinBars: 24, timeframe: '5m' });
  });

  it('the CONFIRMED alert names the timeframe and its fill window', () => {
    const s5 = advanceLiveState({ prev: null, evaluation: eval5(), ...base, timeframe: '5m' }).state;
    const m5 = confirmedMessage(s5, s5.lifecycles.find((l) => l.direction === 'BEARISH')!, (s) => s);
    expect(m5).toMatch(/STRUCTURE CONFIRMED — NIFTY BEARISH \(NSE · 5m entry, 15m pools\)/);
    expect(m5).toMatch(/within 24 five-minute bars \(120 min\)/);
    const s15 = advanceLiveState({ prev: null, evaluation: eval15(), ...base }).state;
    const m15 = confirmedMessage(s15, s15.lifecycles.find((l) => l.direction === 'BEARISH')!, (s) => s);
    expect(m15).toMatch(/\(NSE · 15m\)/);
    expect(m15).toMatch(/within 8 bars/);
  });
});

describe('the 5m loader: cache keys and one TTL', () => {
  it('price and index volume are keyed :5m beside the 15m keys and share one 60s TTL', () => {
    expect(structure5mCacheKeys('NSE', '99926000', '68407')).toEqual({ price: 'hist:NSE:99926000:5m', volume: 'hist:NSE:FO:68407:5m' });
    expect(structure5mCacheKeys('MCX', '569900')).toEqual({ price: 'hist:MCX:569900:5m', volume: null });
    expect(STRUCTURE_5M_PRICE_TTL_SECONDS).toBe(60);
    expect(STRUCTURE_5M_VOLUME_TTL_SECONDS).toBe(STRUCTURE_5M_PRICE_TTL_SECONDS);
  });

  it('the loader uses those keys and TTLs, runs only in 5m mode for structure-enabled symbols, and logs its request rate', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf8');
    const loader = src.slice(src.indexOf('export async function loadStructureCandles5m'), src.indexOf('async function computeMarketBias('));
    expect(loader).toContain('structure5mCacheKeys(exchange, token).price, STRUCTURE_5M_PRICE_TTL_SECONDS');
    expect(loader).toContain('STRUCTURE_5M_VOLUME_TTL_SECONDS');
    expect(loader).toContain("interval: 'FIVE_MINUTE'");
    expect(loader).toContain('await sleep(1200)');
    expect(loader).toMatch(/structure5mRequestRate\.record\(/);
    expect(loader).toMatch(/historical request rate/);
    // Called in exactly one place in the bias read, behind both conditions.
    expect(src.split('await loadStructureCandles5m(').length - 1).toBe(1);
    expect(src).toContain("if (structureOn && structureTimeframe === '5m') {");
    const warmer = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/cache-warmer.ts'), 'utf8');
    expect(warmer).toContain("if (STRUCTURE_ENTRY_TF === '5m' && structureEnabledFor(t.symbol, t.exchange, t.mode)) {");
  });

  it('the request-rate meter reports once a minute with the calls in the last minute', () => {
    const m = new RequestRateMeter();
    expect(m.record(0, 2)).toEqual({ perMinute: 2, total: 2 });
    expect(m.record(10_000)).toBeNull();
    expect(m.record(30_000, 2)).toBeNull();
    expect(m.record(65_000)).toEqual({ perMinute: 4, total: 6 });
  });

  it('closed 5m bars drop the forming 5m bar', () => {
    const t0 = at('2026-03-10', '10:00');
    const candles = [0, 1, 2].map((k) => ({ timestamp: new Date(t0 + k * M5).toISOString(), open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    expect(toClosedMomentumBars(candles, 'NSE', t0 + 2 * M5 + 60_000, M5).map((b) => b.time)).toEqual([t0, t0 + M5]);
    // The default is still 15m: the 10:05 and 10:10 bars would not have closed.
    expect(toClosedMomentumBars(candles, 'NSE', t0 + 2 * M5 + 60_000).map((b) => b.time)).toEqual([]);
  });
});

describe('Part A rule 4: noiseAtrPoints is read by rule 4 only', () => {
  const liquid = { volume: 50_000, oi: 500_000, theta: -2 };
  const strikes: OptionChainStrike[] = [{ strike: 25000, distanceFromSpot: 0, call: null, put: leg({ token: 'PE25000', ...liquid, ltp: 100, bid: 99.9, ask: 100.1, delta: -0.5 } as Partial<OptionChainLeg>) }];
  const build = (atrPoints: number, noiseAtrPoints?: number) =>
    buildTradeSetup(strikes, 25000, 'BEARISH', 80, 300, undefined, null, 3, 75, atrPoints, {
      flags: { structuralStop: true },
      fnoValidation: { enabled: true, ...(noiseAtrPoints != null ? { noiseAtrPoints } : {}) },
    });

  it('absent, or equal to atrPoints, the builder is unchanged', () => {
    expect(build(70, 70)).toEqual(build(70));
    expect(build(100, 100)).toEqual(build(100));
  });

  it('a 15m ATR that would put the stop inside noise passes when noise is judged on the 5m ATR', () => {
    expect(build(100).noTradeCode).toBe('STOP_INSIDE_NOISE');
    const five = build(100, 40); // 1 × 40 × 0.5 = 20 premium, inside the 30 base stop
    expect(five.available).toBe(true);
    expect(five.fnoValidation?.stopWidenedForNoise).toBe(false);
    // Everything else still reads atrPoints (the 15m ATR).
    expect(five.stopInAtr).toBeCloseTo((five.entry! - five.stopLoss!) / 0.5 / 100, 2);
  });

  it('when rule 4 does not bind, a different noise ATR changes nothing at all', () => {
    expect(build(30, 10)).toEqual(build(30));
  });
});

describe('per-engine closing guard and the exchange-aware reason', () => {
  const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
  const guard = (exchange: 'NSE' | 'BSE' | 'MCX', t: number, guardMinutes: number) =>
    closingGuardReason({ enabled: true, mode: 'INTRADAY', exchange, minutesToClose: minutesToSessionClose(exchange, t), guardMinutes });
  const STRUCTURE = structureSessionOpts({ STRUCTURE_OPENING_GUARD: 0, STRUCTURE_CLOSING_GUARD_MIN: 15 }).closingGuardMinutes;
  const CONSENSUS = TRADING_PARAM_DEFAULTS.SETUP_CLOSING_GUARD_MINUTES;

  it('structureSessionOpts maps the params; the consensus engine keeps 60', () => {
    expect(structureSessionOpts(STRUCTURE_PARAM_DEFAULTS)).toEqual({ openingGuard: false, closingGuardMinutes: 60 });
    expect(STRUCTURE).toBe(15);
    expect(CONSENSUS).toBe(60);
  });

  it('NSE 15:30: at 14:45 consensus refuses and a 15-minute structure guard does not; at 15:16 both refuse', () => {
    const d = '2026-10-14';
    expect(guard('NSE', ist(d, '14:45'), CONSENSUS)?.code).toBe('CLOSING_HOUR');
    expect(guard('NSE', ist(d, '14:45'), STRUCTURE)).toBeNull();
    expect(guard('NSE', ist(d, '15:15'), STRUCTURE)).toBeNull(); // exactly 15 left
    expect(guard('NSE', ist(d, '15:16'), STRUCTURE)?.code).toBe('CLOSING_HOUR');
  });

  it('MCX 23:30 (US DST) and 23:55 (winter) boundaries for both engines', () => {
    const dst = '2026-10-14';
    expect(guard('MCX', ist(dst, '22:31'), CONSENSUS)?.code).toBe('CLOSING_HOUR');
    expect(guard('MCX', ist(dst, '22:31'), STRUCTURE)).toBeNull();
    expect(guard('MCX', ist(dst, '23:15'), STRUCTURE)).toBeNull();
    expect(guard('MCX', ist(dst, '23:16'), STRUCTURE)?.code).toBe('CLOSING_HOUR');
    const winter = '2026-12-09';
    expect(guard('MCX', ist(winter, '22:56'), CONSENSUS)?.code).toBe('CLOSING_HOUR');
    expect(guard('MCX', ist(winter, '23:16'), STRUCTURE)).toBeNull();
    expect(guard('MCX', ist(winter, '23:40'), STRUCTURE)).toBeNull();
    expect(guard('MCX', ist(winter, '23:41'), STRUCTURE)?.code).toBe('CLOSING_HOUR');
  });

  it('the NSE evidence sentence is cited on NSE/BSE only; MCX gets a plain cutoff reason', () => {
    const d = '2026-10-14';
    expect(guard('NSE', ist(d, '14:45'), 60)?.reason).toMatch(/NSE entries with under two hours left went 0 for 5/);
    expect(guard('BSE', ist(d, '14:45'), 60)?.reason).toMatch(/0 for 5/);
    const mcx = guard('MCX', ist(d, '22:45'), 60)!.reason;
    expect(mcx).toMatch(/^Only 45 minutes left before MCX closes, and new intraday setups stop 60 minutes before the close\./);
    expect(mcx).toMatch(/Past the 60-minute cutoff/);
    expect(mcx).not.toMatch(/NSE|0 for 5/);
  });

  it('the structure fill uses its own guard in the live chain (source)', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf8');
    expect(src).toContain('const session = sessionGateReason(exchange, mode, structureSessionOpts(STRUCTURE_PARAMS));');
    expect(src).toContain('guardMinutes: structureSessionOpts(STRUCTURE_PARAMS).closingGuardMinutes }');
    expect(src).toContain('guardMinutes: opts.closingGuardMinutes ?? TRADING_PARAMS.SETUP_CLOSING_GUARD_MINUTES');
  });
});

describe('a 5m structure trade exits on 5m closes', () => {
  const fillAt = at(TODAY, '11:07');
  const trade = (timeframe?: '5m') => ({ direction: 'BEARISH', strategy: STRUCTURE_STRATEGY, structure: { direction: 'BEARISH' as const, sweepExtreme: 102.3, fillAt, ...(timeframe ? { timeframe } : {}) } });
  it('a 5m close beyond the extreme reclaims a 5m trade before the 15m bar closes', () => {
    const bar15 = { time: at(TODAY, '11:00'), close: 101.0 }; // still inside
    const bar5 = { time: at(TODAY, '11:10'), close: 102.4, barMs: M5 };
    expect(triggerSlotAction({ stored: trade('5m'), trigger: null, lastClosedBar: bar15, structureBar: bar5 })).toEqual({ kind: 'CLOSE', reason: 'SWEEP_RECLAIMED' });
    // A 15m trade ignores the 5m bar (unchanged behaviour).
    expect(triggerSlotAction({ stored: trade(), trigger: null, lastClosedBar: bar15, structureBar: bar5 })).toEqual({ kind: 'HOLD_TRIGGER' });
    // Without a 5m bar at hand the 5m trade falls back to the 15m bar.
    expect(triggerSlotAction({ stored: trade('5m'), trigger: null, lastClosedBar: { time: at(TODAY, '11:00'), close: 102.4 } })).toEqual({ kind: 'CLOSE', reason: 'SWEEP_RECLAIMED' });
  });
});
