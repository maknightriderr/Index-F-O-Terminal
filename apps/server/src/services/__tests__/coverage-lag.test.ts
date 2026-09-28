// ============================================================
// COVERAGE / LAG ROUND — one block per plan item
// ============================================================
// The plan's verification list:
//   1. MCX close times, including the US-DST boundaries (no flag — correctness)
//   2. background evaluator gating: closed market, recent read, in flight
//      + the mint lock: two concurrent mints -> one setup, one Telegram call
//   3. intraday positioning votes from fixture snapshot rows: a short build-up
//      reads bearish; thin or stale rows fall back and record PREV_CLOSE
//   4. 15m ADX fallback and breakout persistence
//   5. every flag OFF -> today's behaviour; defaults; the logic stamp
//
// Every snapshot row here is a FABRICATED fixture. The "incident replay" block
// is SYNTHETIC: production snapshot rows are not reachable read-only, so it
// is a constructed short build-up during a fall shaped like 28 Sep, not the
// captured data.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getSessionCloseTime, getSessionWindow, isMarketOpen, MCX_US_DST_CLOSE, MCX_US_STANDARD_TIME_CLOSE } from '@fno/shared';
import { bollingerBands } from '@fno/analytics';

// The evaluator imports market-bias.ts, which opens Redis and Postgres at
// import time. Its two functions are stubbed; the evaluator's own logic is
// what is under test.
vi.mock('../market-bias.js', () => ({
  buildMarketBias: vi.fn(),
  lastBiasComputedAt: vi.fn(),
}));

import {
  backgroundTargets,
  runBackgroundBiasTick,
  skipReason,
  targetId,
  type BackgroundTarget,
  type EvaluatorDeps,
} from '../background-bias-evaluator.js';
import { mintOnce, mintLockKey, type MintLockStore } from '../setup-mint-lock.js';
import {
  assessWindow,
  evaluateIntradayPositioning,
  intradayBaselineLabel,
  resolvePositioningVotes,
  type FuturesSnapshotPoint,
  type IntradayPositioningConfig,
  type OptionLegSnapshotPoint,
  type PcrSnapshotPoint,
} from '../intraday-positioning.js';
import { applyFastIntradayRegime, classifyRegime, persistedBreakout } from '../regime-classifier.js';
import { bandVote } from '../vote-bands.js';
import { prioritiseCaptureMembers } from '../market-state-capture.js';
import {
  COVERAGE_LAG_FLAG_DEFAULTS,
  COVERAGE_LAG_PARAM_DEFAULTS,
  LOGIC_VERSION,
  TRADING_FLAG_DEFAULTS,
  TRADING_PARAM_DEFAULTS,
  logicStamp,
  parseBackgroundSymbols,
  readCoverageLagFlags,
  readCoverageLagParams,
} from '../../config/trading-flags.js';

vi.mock('../../lib/redis.js', () => ({ redis: {}, scanKeys: vi.fn() }));
vi.mock('../../lib/db.js', () => ({ sql: vi.fn() }));

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../../../../');
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
const MIN = 60_000;

// ---------------- 1. MCX CLOSE TIME ----------------
describe('MCX close time follows US DST the right way round', () => {
  it('constants: 23:30 during US DST, 23:55 otherwise', () => {
    expect(MCX_US_DST_CLOSE).toBe('23:30');
    expect(MCX_US_STANDARD_TIME_CLOSE).toBe('23:55');
  });

  it('24 and 25 Sep 2026 (US DST) close at 23:30 — the real last 15m bar starts 23:15', () => {
    for (const d of ['2026-09-24', '2026-09-25']) {
      expect(getSessionCloseTime('MCX', ist(d, '12:00'))).toBe('23:30');
      expect(getSessionWindow('MCX', d)?.close).toBe(ist(d, '23:30'));
      expect(isMarketOpen('MCX', ist(d, '23:15'))).toBe(true);
    }
  });

  it('isMarketOpen(MCX) at 23:31 on a DST date is false; on a winter date it is still open until 23:55', () => {
    expect(isMarketOpen('MCX', ist('2026-09-24', '23:30'))).toBe(true);
    expect(isMarketOpen('MCX', ist('2026-09-24', '23:31'))).toBe(false);
    expect(isMarketOpen('MCX', ist('2026-09-24', '23:50'))).toBe(false);
    expect(isMarketOpen('MCX', ist('2026-12-09', '23:31'))).toBe(true);
    expect(isMarketOpen('MCX', ist('2026-12-09', '23:55'))).toBe(true);
    expect(isMarketOpen('MCX', ist('2026-12-09', '23:56'))).toBe(false);
  });

  it('the transition Mondays: DST starts Sun 8 Mar 2026, ends Sun 1 Nov 2026', () => {
    expect(getSessionCloseTime('MCX', ist('2026-03-06', '12:00'))).toBe('23:55'); // Fri before: standard time
    expect(getSessionCloseTime('MCX', ist('2026-03-09', '12:00'))).toBe('23:30'); // first DST Monday
    expect(getSessionCloseTime('MCX', ist('2026-10-30', '12:00'))).toBe('23:30'); // last DST Friday
    expect(getSessionCloseTime('MCX', ist('2026-11-02', '12:00'))).toBe('23:55'); // first standard-time Monday
  });

  it('the close is read for the date passed in, not the wall clock (replays use their own DST)', () => {
    expect(getSessionCloseTime('MCX', new Date('2026-01-15T10:00:00Z'))).toBe('23:55');
    expect(getSessionCloseTime('MCX', new Date('2026-07-15T10:00:00Z'))).toBe('23:30');
  });

  it('NSE and BSE are unaffected', () => {
    expect(getSessionCloseTime('NSE', ist('2026-09-24', '12:00'))).toBe('15:30');
    expect(getSessionCloseTime('BSE', ist('2026-12-09', '12:00'))).toBe('15:30');
  });

  it('remainingSessionFraction passes the decision date to getSessionCloseTime', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    const body = src.slice(src.indexOf('function remainingSessionFraction'), src.indexOf('function remainingSessionFraction') + 700);
    expect(body).toContain('const at = decisionDate();');
    expect(body).toContain('getSessionCloseTime(exchange, at)');
  });
});

// ---------------- 2a. BACKGROUND EVALUATOR ----------------
describe('background bias evaluator — targets and gating', () => {
  const SYMBOLS = parseBackgroundSymbols(undefined).symbols;

  it('defaults to SENSEX (BSE), CRUDEOIL and GOLD (MCX); junk entries are rejected, not guessed', () => {
    expect(SYMBOLS).toEqual([
      { symbol: 'SENSEX', exchange: 'BSE' },
      { symbol: 'CRUDEOIL', exchange: 'MCX' },
      { symbol: 'GOLD', exchange: 'MCX' },
    ]);
    const parsed = parseBackgroundSymbols('silver:mcx, BANKEX:BSE, NIFTY, FOO:NYSE, SILVER:MCX');
    expect(parsed.symbols).toEqual([
      { symbol: 'SILVER', exchange: 'MCX' },
      { symbol: 'BANKEX', exchange: 'BSE' },
    ]);
    expect(parsed.rejected).toEqual(['NIFTY', 'FOO:NYSE']);
  });

  it('INTRADAY for every symbol; POSITIONAL added for MCX only when MCX_POSITIONAL_BACKGROUND is on', () => {
    expect(backgroundTargets(SYMBOLS, { MCX_POSITIONAL_BACKGROUND: true }).map(targetId)).toEqual([
      'BSE:SENSEX:INTRADAY',
      'MCX:CRUDEOIL:INTRADAY',
      'MCX:CRUDEOIL:POSITIONAL',
      'MCX:GOLD:INTRADAY',
      'MCX:GOLD:POSITIONAL',
    ]);
    expect(backgroundTargets(SYMBOLS, { MCX_POSITIONAL_BACKGROUND: false }).map(targetId)).toEqual([
      'BSE:SENSEX:INTRADAY',
      'MCX:CRUDEOIL:INTRADAY',
      'MCX:GOLD:INTRADAY',
    ]);
  });

  const NOW = ist('2026-09-28', '17:10');
  const baseDeps = (over: Partial<EvaluatorDeps> = {}): EvaluatorDeps => ({
    isMarketOpen: () => true,
    lastComputedAt: () => undefined,
    buildBias: vi.fn(async () => ({
      bias: { direction: 'BEARISH', confidence: 70, regime: 'RANGE_BOUND' },
      tradeSetup: { available: false, reason: 'x', noTradeCode: 'LOW_SETUP_QUALITY' },
    })) as unknown as EvaluatorDeps['buildBias'],
    now: () => NOW,
    recentReadMs: 60_000,
    inFlight: new Set<string>(),
    log: { info: vi.fn(), warn: vi.fn() } as unknown as EvaluatorDeps['log'],
    ...over,
  });
  const crude: BackgroundTarget = { symbol: 'CRUDEOIL', exchange: 'MCX', mode: 'INTRADAY' };

  it('closed market is skipped', () => {
    expect(skipReason(crude, baseDeps({ isMarketOpen: () => false }))).toBe('MARKET_CLOSED');
  });

  it('a read within the last 60s is skipped (a browser is already on it); an older one is not', () => {
    expect(skipReason(crude, baseDeps({ lastComputedAt: () => NOW - 30_000 }))).toBe('RECENT_READ');
    expect(skipReason(crude, baseDeps({ lastComputedAt: () => NOW - 61_000 }))).toBeNull();
  });

  it('a read still in flight is skipped', () => {
    expect(skipReason(crude, baseDeps({ inFlight: new Set([targetId(crude)]) }))).toBe('IN_FLIGHT');
  });

  it('a tick runs the open, stale, idle targets sequentially and records the rest as skipped', async () => {
    const order: string[] = [];
    const deps = baseDeps({
      isMarketOpen: (ex) => ex === 'MCX',
      lastComputedAt: (_ex, sym) => (sym === 'GOLD' ? NOW - 10_000 : undefined),
      buildBias: vi.fn(async (sym: string, ex: string, mode: string) => {
        order.push(`${ex}:${sym}:${mode}`);
        // sequential: nothing else may be in flight while this one runs
        expect(deps.inFlight.size).toBe(1);
        return { bias: { direction: 'BEARISH', confidence: 60, regime: 'RANGE_BOUND' }, tradeSetup: { available: false, reason: 'x' } };
      }) as unknown as EvaluatorDeps['buildBias'],
    });
    const report = await runBackgroundBiasTick(backgroundTargets(SYMBOLS, { MCX_POSITIONAL_BACKGROUND: true }), deps);
    expect(order).toEqual(['MCX:CRUDEOIL:INTRADAY', 'MCX:CRUDEOIL:POSITIONAL']);
    expect(report.evaluated).toEqual(order);
    expect(report.skipped).toEqual({
      'BSE:SENSEX:INTRADAY': 'MARKET_CLOSED',
      'MCX:GOLD:INTRADAY': 'RECENT_READ',
      'MCX:GOLD:POSITIONAL': 'RECENT_READ',
    });
    expect(deps.inFlight.size).toBe(0);
  });

  it('a failing symbol is logged (not swallowed) and the pass moves on', async () => {
    const warn = vi.fn();
    const deps = baseDeps({
      log: { info: vi.fn(), warn } as unknown as EvaluatorDeps['log'],
      buildBias: vi.fn(async (sym: string) => {
        if (sym === 'CRUDEOIL') throw new Error('broker 403');
        return { bias: { direction: 'NEUTRAL', confidence: 50, regime: 'RANGE_BOUND' }, tradeSetup: { available: false, reason: 'x' } };
      }) as unknown as EvaluatorDeps['buildBias'],
    });
    const report = await runBackgroundBiasTick(backgroundTargets(SYMBOLS, { MCX_POSITIONAL_BACKGROUND: false }), deps);
    expect(report.failed).toEqual(['MCX:CRUDEOIL:INTRADAY']);
    expect(report.evaluated).toEqual(['BSE:SENSEX:INTRADAY', 'MCX:GOLD:INTRADAY']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ error: 'broker 403', underlying: 'CRUDEOIL' });
    expect(deps.inFlight.size).toBe(0);
  });

  it('is started from index.ts next to the other background services', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/index.ts'), 'utf-8');
    expect(src).toContain("import { startBackgroundBiasEvaluator } from './services/background-bias-evaluator.js';");
    expect(src).toContain('startBackgroundBiasEvaluator(provider);');
  });
});

describe('capture coverage — background symbols go first', () => {
  it('puts the background underlyings first, nearest expiry first, and keeps the rest in recency order', () => {
    const tracked = ['GOLD|2026-10-31', 'SILVER|2026-11-28', 'CRUDEOIL|2026-11-17', 'NATURALGAS|2026-10-27', 'CRUDEOIL|2026-10-15'];
    expect(prioritiseCaptureMembers(tracked, ['CRUDEOIL', 'GOLD'])).toEqual([
      'CRUDEOIL|2026-10-15',
      'CRUDEOIL|2026-11-17',
      'GOLD|2026-10-31',
      'SILVER|2026-11-28',
      'NATURALGAS|2026-10-27',
    ]);
    expect(prioritiseCaptureMembers(tracked, [])).toEqual(tracked);
  });
});

// ---------------- 2b. MINT LOCK ----------------
describe('setup mint lock — concurrent callers mint once', () => {
  /** An in-memory Redis with an async hop on every call, so interleavings are real. */
  function memoryStore(): MintLockStore & { data: Map<string, string> } {
    const data = new Map<string, string>();
    const hop = () => new Promise<void>((r) => setTimeout(r, 1));
    return {
      data,
      async setNx(k, v) {
        await hop();
        if (data.has(k)) return false;
        data.set(k, v);
        return true;
      },
      async get(k) {
        await hop();
        return data.get(k) ?? null;
      },
      async del(k) {
        await hop();
        return data.delete(k) ? 1 : 0;
      },
    };
  }

  const SLOT = 'trade_setup:MCX:CRUDEOIL:INTRADAY';
  const LOCK = mintLockKey('MCX', 'CRUDEOIL', 'INTRADAY');

  function caller(store: ReturnType<typeof memoryStore>, telegram: ReturnType<typeof vi.fn>, decisionRows: string[], priorDecisionId: string | null, name: string) {
    return mintOnce<{ decisionId: string }, { decisionId: string }>({
      store,
      lockKey: LOCK,
      ttlSeconds: 30,
      waitMs: 2_000,
      pollMs: 5,
      readExisting: async () => {
        const raw = await store.get(SLOT);
        if (!raw) return null;
        const s = JSON.parse(raw) as { decisionId: string };
        return s.decisionId !== priorDecisionId ? s : null;
      },
      mint: async () => {
        // the mint's side effects: a decision row, the slot write, the push
        const decisionId = `take-${name}`;
        decisionRows.push(decisionId);
        await new Promise((r) => setTimeout(r, 20));
        await store.setNx(SLOT, JSON.stringify({ decisionId }), 30);
        telegram(decisionId);
        return { decisionId };
      },
    });
  }

  it('two concurrent mints -> one setup, one decision row, one Telegram call; both return it', async () => {
    const store = memoryStore();
    const telegram = vi.fn();
    const rows: string[] = [];
    const [a, b] = await Promise.all([caller(store, telegram, rows, null, 'browser'), caller(store, telegram, rows, null, 'evaluator')]);
    expect(rows).toHaveLength(1);
    expect(telegram).toHaveBeenCalledTimes(1);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['EXISTING', 'MINTED']);
    const ids = [a, b].map((o) => (o.kind === 'BUSY' ? null : o.value.decisionId));
    expect(ids[0]).toBe(ids[1]);
    expect(store.data.has(LOCK)).toBe(false); // released by its owner
  });

  it('the winner re-checks the slot inside the lock: a setup minted since its first read is returned, not re-minted', async () => {
    const store = memoryStore();
    store.data.set(SLOT, JSON.stringify({ decisionId: 'take-earlier-caller' }));
    const telegram = vi.fn();
    const rows: string[] = [];
    const out = await caller(store, telegram, rows, null, 'late');
    expect(out).toEqual({ kind: 'EXISTING', value: { decisionId: 'take-earlier-caller' } });
    expect(rows).toHaveLength(0);
    expect(telegram).not.toHaveBeenCalled();
  });

  it('the setup this caller just closed does not count as someone else’s mint', async () => {
    const store = memoryStore();
    const old = 'take-closed-by-sl'; // still in the slot: this caller read it, closed it, and is replacing it
    store.data.set(SLOT, JSON.stringify({ decisionId: old }));
    const telegram = vi.fn();
    const rows: string[] = [];
    const out = await mintOnce({
      store,
      lockKey: LOCK,
      ttlSeconds: 30,
      waitMs: 100,
      readExisting: async () => {
        const s = JSON.parse((await store.get(SLOT)) ?? 'null') as { decisionId: string } | null;
        return s && s.decisionId !== old ? s : null;
      },
      mint: async () => {
        rows.push('take-new');
        telegram('take-new');
        return { decisionId: 'take-new' };
      },
    });
    expect(out.kind).toBe('MINTED');
    expect(rows).toEqual(['take-new']);
    expect(telegram).toHaveBeenCalledTimes(1);
  });

  it('a loser that never sees the winner’s setup gives up (BUSY) without minting', async () => {
    const store = memoryStore();
    store.data.set(LOCK, 'someone-else');
    const mint = vi.fn();
    const out = await mintOnce({ store, lockKey: LOCK, ttlSeconds: 30, waitMs: 20, pollMs: 5, readExisting: async () => null, mint });
    expect(out).toEqual({ kind: 'BUSY' });
    expect(mint).not.toHaveBeenCalled();
  });

  it('when Redis cannot take the lock the mint goes ahead unlocked and the error is reported', async () => {
    const onError = vi.fn();
    const out = await mintOnce({
      store: { setNx: async () => { throw new Error('ECONNREFUSED'); }, get: async () => null, del: async () => 0 },
      lockKey: LOCK,
      ttlSeconds: 30,
      waitMs: 0,
      readExisting: async () => null,
      mint: async () => 'minted',
      onError,
    });
    expect(out).toEqual({ kind: 'MINTED', value: 'minted', locked: false });
    expect(onError).toHaveBeenCalledWith('ACQUIRE', expect.any(Error));
  });

  it('market-bias wraps the setup-creating branch in the lock only when BACKGROUND_BIAS is on', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    expect(src).toContain('if (!COVERAGE_LAG_FLAGS.BACKGROUND_BIAS) return mintFresh();');
    expect(src).toContain('lockKey: mintLockKey(exchange, underlying, mode)');
    expect(mintLockKey('MCX', 'CRUDEOIL', 'INTRADAY')).toBe('trade_setup_mint_lock:MCX:CRUDEOIL:INTRADAY');
    // The Telegram push lives only inside the minting function.
    expect(src.match(/notifyTradeSetup\(/g)).toHaveLength(1);
    expect(src.indexOf('notifyTradeSetup(')).toBeGreaterThan(src.indexOf('async function mintTradeSetup('));
  });
});

// ---------------- 3. INTRADAY POSITIONING ----------------
describe('intraday positioning window', () => {
  const NOW = ist('2026-09-28', '18:00');
  const cfg: IntradayPositioningConfig = {
    now: NOW,
    windowMin: 60,
    minSnapshots: 3,
    maxAgeMin: 20,
    futuresBand: { enter: 0.1, hold: 0.02 }, // FUTURES_MOVE_ENTER_PCT / HOLD_PCT
    pcrBand: { enter: 0.05, hold: 0.02 },
    optionFlowBand: { enter: 0.15, hold: 0.08 }, // OPTION_OI_FLOW_MIN_SKEW / HOLD_SKEW
    optionPriceNoisePct: 2, // IV_PRESSURE_MIN_PCT
  };
  const at = (minsAgo: number) => NOW - minsAgo * MIN;

  // FABRICATED: price falling, OI rising over the window = short build-up.
  const shortBuildUp: FuturesSnapshotPoint[] = [
    { time: at(55), price: 9200, oi: 20000 },
    { time: at(40), price: 9160, oi: 20600 },
    { time: at(25), price: 9110, oi: 21300 },
    { time: at(10), price: 9070, oi: 21900 },
  ];

  it('a short build-up during a fall votes bearish and records the intraday baseline', () => {
    const read = evaluateIntradayPositioning({ futures: shortBuildUp, pcr: [], legs: [], prev: null }, cfg);
    expect(read.futures.interpretation).toBe('SHORT_BUILDUP');
    expect(read.futures.vote).toBe(-1);
    expect(read.futures.priceChangePct).toBeCloseTo(((9070 - 9200) / 9200) * 100, 6);
    expect(read.futures.oiChangePct).toBeCloseTo(9.5, 6);
    const resolved = resolvePositioningVotes({ futuresOiVote: 1, pcrVote: 1, optionOiFlowVote: 1, futuresChangeOiPct: 2 }, read);
    expect(resolved.futuresOiVote).toBe(-1);
    expect(resolved.futuresChangeOiPct).toBeCloseTo(9.5, 6);
    expect(resolved.baselines).toEqual({ futuresOi: 'INTRADAY_60M', pcr: 'PREV_CLOSE', optionOiFlow: 'PREV_CLOSE', oiShifts: 'INTRADAY_60M' });
    // the empty PCR/flow windows fell back to their day-level (bullish) votes
    expect(resolved.pcrVote).toBe(1);
    expect(resolved.optionOiFlowVote).toBe(1);
  });

  it('fewer than 3 snapshots in the window -> falls back to the day-level vote and records PREV_CLOSE', () => {
    const thin = shortBuildUp.slice(2);
    const read = evaluateIntradayPositioning({ futures: thin, pcr: [], legs: [], prev: null }, cfg);
    expect(read.futures.vote).toBeNull();
    expect(read.futures.sufficiency.reason).toMatch(/2 snapshot\(s\).*3 needed/);
    const resolved = resolvePositioningVotes({ futuresOiVote: 1, pcrVote: 0, optionOiFlowVote: 0, futuresChangeOiPct: 2 }, read);
    expect(resolved.futuresOiVote).toBe(1);
    expect(resolved.futuresChangeOiPct).toBe(2);
    expect(resolved.baselines.futuresOi).toBe('PREV_CLOSE');
    expect(resolved.baselines.oiShifts).toBe('PREV_CLOSE');
  });

  it('newest snapshot older than 20 minutes -> falls back', () => {
    const stale = shortBuildUp.map((p) => ({ ...p, time: p.time - 15 * MIN })).filter((p) => p.time >= NOW - 60 * MIN);
    // 3 points left (70/55/40/25 min ago -> 55/40/25), newest 25 min old
    const w = assessWindow(stale.map((p) => p.time), cfg);
    expect(w.snapshots).toBe(3);
    expect(w.newestAgeMin).toBe(25);
    expect(w.sufficient).toBe(false);
    expect(evaluateIntradayPositioning({ futures: stale, pcr: [], legs: [], prev: null }, cfg).futures.vote).toBeNull();
  });

  it('rows after the decision instant are never read (no look-ahead)', () => {
    const withFuture = [...shortBuildUp, { time: NOW + 5 * MIN, price: 9500, oi: 10000 }];
    const read = evaluateIntradayPositioning({ futures: withFuture, pcr: [], legs: [], prev: null }, cfg);
    expect(read.futures.vote).toBe(-1);
    expect(read.futures.sufficiency.snapshots).toBe(4);
  });

  it('small moves use the same entry/hold hysteresis as the day-level vote', () => {
    const drift: FuturesSnapshotPoint[] = [
      { time: at(50), price: 10000, oi: 1000 },
      { time: at(30), price: 9998, oi: 1010 },
      { time: at(5), price: 9995, oi: 1020 }, // -0.05%: inside the 0.1% entry band
    ];
    expect(evaluateIntradayPositioning({ futures: drift, pcr: [], legs: [], prev: null }, cfg).futures.vote).toBe(0);
    // ... but an already-bearish vote holds through it (hold band 0.02%)
    expect(evaluateIntradayPositioning({ futures: drift, pcr: [], legs: [], prev: { futuresOi: -1 } }, cfg).futures.vote).toBe(-1);
  });

  it('PCR votes on its change over the window, same sign convention as the day vote', () => {
    const pcr: PcrSnapshotPoint[] = [
      { time: at(50), oiPcr: 1.2 },
      { time: at(35), oiPcr: 1.14 },
      { time: at(5), oiPcr: 1.1 },
    ];
    const read = evaluateIntradayPositioning({ futures: [], pcr, legs: [], prev: null }, cfg);
    expect(read.pcr.pcrChange).toBeCloseTo(-0.1, 6);
    expect(read.pcr.vote).toBe(-1); // still above 1.1 on the day (bullish), but falling fast over the hour
  });

  it('option OI flow: put buying and call writing over the window vote bearish', () => {
    const legs: OptionLegSnapshotPoint[] = [];
    for (const [t, putOi, putLtp, callOi, callLtp] of [
      [at(50), 1000, 100, 1000, 120],
      [at(30), 1500, 130, 1400, 95],
      [at(5), 2000, 160, 1800, 70],
    ] as const) {
      legs.push({ time: t, strike: 9100, optionType: 'PE', oi: putOi, ltp: putLtp });
      legs.push({ time: t, strike: 9100, optionType: 'CE', oi: callOi, ltp: callLtp });
    }
    const read = evaluateIntradayPositioning({ futures: [], pcr: [], legs, prev: null }, cfg);
    expect(read.optionFlow.legsCompared).toBe(2);
    expect(read.optionFlow.netSkew).toBe(-1);
    expect(read.optionFlow.vote).toBe(-1);
    expect(['PUT_BUYING', 'CALL_WRITING']).toContain(read.optionFlow.dominant);
  });

  it('flag OFF (or POSITIONAL): no intraday read -> the day-level votes untouched, all PREV_CLOSE', () => {
    const day = { futuresOiVote: 1 as const, pcrVote: -1 as const, optionOiFlowVote: 0 as const, futuresChangeOiPct: 3.2 };
    expect(resolvePositioningVotes(day, null)).toEqual({
      ...day,
      baselines: { futuresOi: 'PREV_CLOSE', pcr: 'PREV_CLOSE', optionOiFlow: 'PREV_CLOSE', oiShifts: 'PREV_CLOSE' },
    });
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    expect(src).toContain('if (COVERAGE_LAG_FLAGS.INTRADAY_POSITIONING && !isPositional) {');
  });

  it('the baseline label follows the window', () => {
    expect(intradayBaselineLabel(60)).toBe('INTRADAY_60M');
    expect(intradayBaselineLabel(45)).toBe('INTRADAY_45M');
  });

  it('bandVote moved to vote-bands.ts unchanged', () => {
    expect(bandVote(0.2, undefined, 0.1, 0.02, -0.1, -0.02)).toBe(1);
    expect(bandVote(0.05, 1, 0.1, 0.02, -0.1, -0.02)).toBe(1);
    expect(bandVote(0.05, undefined, 0.1, 0.02, -0.1, -0.02)).toBe(0);
    expect(bandVote(Number.NaN, 1, 0.1, 0.02, -0.1, -0.02)).toBe(0);
  });
});

// SYNTHETIC — see the file header. Not the captured 28 Sep rows.
describe('SYNTHETIC incident replay: a short build-up during a CRUDEOIL-shaped fall (16:30-19:30 IST)', () => {
  // 15-minute capture cadence, price 9292 -> 9020 in a straight line, OI
  // rising 0.8% a bar. The DAY-level futures vote (vs yesterday's close, the
  // contract still up on the day at the start of the fall) is bullish.
  const start = ist('2026-09-28', '16:30');
  const bars = 13; // 16:30 ... 19:30
  const series: FuturesSnapshotPoint[] = Array.from({ length: bars }, (_, i) => ({
    time: start + i * 15 * MIN,
    price: 9292 - (272 * i) / (bars - 1),
    oi: Math.round(20000 * (1 + 0.008 * i)),
  }));
  const cfgAt = (now: number): IntradayPositioningConfig => ({
    now,
    windowMin: 60,
    minSnapshots: 3,
    maxAgeMin: 20,
    futuresBand: { enter: 0.1, hold: 0.02 },
    pcrBand: { enter: 0.05, hold: 0.02 },
    optionFlowBand: { enter: 0.15, hold: 0.08 },
    optionPriceNoisePct: 2,
  });

  it('the futures vote turns bearish once 3 snapshots of the fall are in the window, and stays bearish', () => {
    const DAY_LEVEL_VOTE = 1; // "long build-up vs yesterday's close"
    const trail: Array<{ at: string; vote: number; baseline: string }> = [];
    let prev: -1 | 0 | 1 | undefined;
    for (let i = 0; i < bars; i++) {
      const now = start + i * 15 * MIN + 2 * MIN; // a poll two minutes after each capture
      const read = evaluateIntradayPositioning({ futures: series, pcr: [], legs: [], prev: { futuresOi: prev } }, cfgAt(now));
      const resolved = resolvePositioningVotes({ futuresOiVote: DAY_LEVEL_VOTE, pcrVote: 0, optionOiFlowVote: 0, futuresChangeOiPct: 1 }, read);
      prev = resolved.futuresOiVote;
      trail.push({ at: new Date(now).toISOString().slice(11, 16), vote: resolved.futuresOiVote, baseline: resolved.baselines.futuresOi });
    }
    // 16:32 and 16:47: 1-2 snapshots -> day-level bullish vote, PREV_CLOSE
    expect(trail.slice(0, 2).every((t) => t.vote === 1 && t.baseline === 'PREV_CLOSE')).toBe(true);
    // from 17:02 (3 snapshots, -0.49% on +1.6% OI = short build-up) onward: bearish, INTRADAY_60M
    expect(trail.slice(2).every((t) => t.vote === -1 && t.baseline === 'INTRADAY_60M')).toBe(true);
  });
});

// ---------------- 4. FAST INTRADAY REGIME ----------------
describe('faster intraday regime', () => {
  it('classifyRegime moved verbatim: ADX bands 25/18, leading regimes first', () => {
    expect(classifyRegime(30, 'UP', 0, null, null, false, false, false, false)).toBe('STRONG_BULL_TREND');
    expect(classifyRegime(20, 'DOWN', 0, null, null, false, false, false, false)).toBe('WEAK_BEAR_TREND');
    expect(classifyRegime(12, 'DOWN', 0, null, null, false, false, false, false)).toBe('RANGE_BOUND');
    expect(classifyRegime(12, 'DOWN', 1.5, null, null, false, false, false, false)).toBe('HIGH_VOLATILITY');
    expect(classifyRegime(40, 'UP', 0, 1, 'LONG_GAMMA', false, false, false, false)).toBe('EXPIRY_GAMMA');
    expect(classifyRegime(40, 'UP', 0, null, null, false, true, false, false)).toBe('BREAKDOWN');
  });

  it('15m ADX fallback: 1H reads no trend, 15m ADX clears the same bands', () => {
    const run = (base: Parameters<typeof applyFastIntradayRegime>[0]['baseRegime'], adx15m: number | null, dir: 'UP' | 'DOWN' = 'DOWN') =>
      applyFastIntradayRegime({ enabled: true, baseRegime: base, adx15m, st15Direction: dir, persisted: null });
    expect(run('RANGE_BOUND', 31)).toEqual({ regime: 'STRONG_BEAR_TREND', source: '15M_FALLBACK' });
    expect(run('RANGE_BOUND', 21, 'UP')).toEqual({ regime: 'WEAK_BULL_TREND', source: '15M_FALLBACK' });
    expect(run('LOW_VOLATILITY', 25)).toEqual({ regime: 'STRONG_BEAR_TREND', source: '15M_FALLBACK' });
    expect(run('RANGE_BOUND', 17.9)).toEqual({ regime: 'RANGE_BOUND', source: '1H' });
    expect(run('RANGE_BOUND', null)).toEqual({ regime: 'RANGE_BOUND', source: '1H' });
    // a 1H trend is never overridden by the 15m read
    expect(run('WEAK_BULL_TREND', 40)).toEqual({ regime: 'WEAK_BULL_TREND', source: '1H' });
  });

  it('breakout persistence holds BREAKDOWN; leading regimes keep priority; flag OFF is the 1H read', () => {
    const persisted = { direction: 'DOWN' as const, barsAgo: 2 };
    expect(applyFastIntradayRegime({ enabled: true, baseRegime: 'RANGE_BOUND', adx15m: 30, st15Direction: 'UP', persisted })).toEqual({
      regime: 'BREAKDOWN',
      source: 'BREAKOUT_PERSIST',
    });
    expect(applyFastIntradayRegime({ enabled: true, baseRegime: 'STRONG_BULL_TREND', adx15m: null, st15Direction: 'UP', persisted })).toEqual({
      regime: 'BREAKDOWN',
      source: 'BREAKOUT_PERSIST',
    });
    expect(applyFastIntradayRegime({ enabled: true, baseRegime: 'EXPIRY_GAMMA', adx15m: 30, st15Direction: 'UP', persisted })).toEqual({
      regime: 'EXPIRY_GAMMA',
      source: '1H',
    });
    expect(applyFastIntradayRegime({ enabled: true, baseRegime: 'BREAKOUT', adx15m: 30, st15Direction: 'UP', persisted })).toEqual({
      regime: 'BREAKOUT',
      source: '1H',
    });
    expect(applyFastIntradayRegime({ enabled: false, baseRegime: 'RANGE_BOUND', adx15m: 40, st15Direction: 'DOWN', persisted })).toEqual({
      regime: 'RANGE_BOUND',
      source: '1H',
    });
  });

  // FABRICATED 15m series: a quiet range, then a volume-confirmed break below
  // the lower band, then closes that stay under the midline.
  const quiet = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 100.5));
  const quietVol = Array.from({ length: 40 }, () => 100);
  const series = (after: number[], breakVolume = 500) => {
    const closes = [...quiet, 98, ...after];
    const volumes = [...quietVol, breakVolume, ...after.map(() => 100)];
    const bb = bollingerBands(closes, 20, 2);
    return { closes, volumes, upper: bb.upper, middle: bb.middle, lower: bb.lower, maxBars: 4, volumeConfirmThreshold: 1.2 };
  };

  it('a confirmed break 2 bars ago, closes still below the midline -> DOWN, barsAgo 2', () => {
    expect(persistedBreakout(series([98.6, 98.9]))).toEqual({ direction: 'DOWN', barsAgo: 2 });
  });

  it('price back above the midline ends the hold', () => {
    expect(persistedBreakout(series([98.6, 100.9]))).toBeNull();
  });

  it('no longer than BREAKOUT_PERSIST_BARS: a break 4 bars ago does not persist with the default 4', () => {
    expect(persistedBreakout(series([98.6, 98.9, 99, 99.1]))).toBeNull();
    expect(persistedBreakout({ ...series([98.6, 98.9, 99, 99.1]), maxBars: 6 })).toEqual({ direction: 'DOWN', barsAgo: 4 });
  });

  it('a break without volume confirmation never became a regime, so it does not persist', () => {
    expect(persistedBreakout(series([98.6, 98.9], 110))).toBeNull();
  });

  it('market-bias only computes it for INTRADAY with the flag on', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    expect(src).toContain('const fastRegimeEnabled = COVERAGE_LAG_FLAGS.FAST_INTRADAY_REGIME && !isPositional;');
  });
});

// ---------------- 5. FLAGS, DEFAULTS, STAMP ----------------
describe('coverage/lag flags and the logic stamp', () => {
  it('defaults: all four flags ON; tunables as planned', () => {
    expect(COVERAGE_LAG_FLAG_DEFAULTS).toEqual({
      BACKGROUND_BIAS: true,
      INTRADAY_POSITIONING: true,
      FAST_INTRADAY_REGIME: true,
      MCX_POSITIONAL_BACKGROUND: true,
    });
    expect(COVERAGE_LAG_PARAM_DEFAULTS).toEqual({
      BACKGROUND_BIAS_INTERVAL_MS: 120_000,
      BACKGROUND_BIAS_RECENT_READ_MS: 60_000,
      INTRADAY_POSITIONING_WINDOW_MIN: 60,
      INTRADAY_POSITIONING_MIN_SNAPSHOTS: 3,
      INTRADAY_POSITIONING_MAX_AGE_MIN: 20,
      INTRADAY_PCR_DELTA_ENTER: 0.05,
      INTRADAY_PCR_DELTA_HOLD: 0.02,
      BREAKOUT_PERSIST_BARS: 4,
      SETUP_MINT_LOCK_TTL_SECONDS: 30,
      SETUP_MINT_LOCK_WAIT_MS: 5_000,
    });
  });

  it('every flag and tunable is env-configurable; junk falls back to the default', () => {
    expect(readCoverageLagFlags({ BACKGROUND_BIAS: 'off', INTRADAY_POSITIONING: '0', FAST_INTRADAY_REGIME: 'false', MCX_POSITIONAL_BACKGROUND: 'no' })).toEqual({
      BACKGROUND_BIAS: false,
      INTRADAY_POSITIONING: false,
      FAST_INTRADAY_REGIME: false,
      MCX_POSITIONAL_BACKGROUND: false,
    });
    expect(readCoverageLagFlags({ BACKGROUND_BIAS: 'maybe' }).BACKGROUND_BIAS).toBe(true);
    expect(readCoverageLagParams({ INTRADAY_POSITIONING_WINDOW_MIN: '45', BREAKOUT_PERSIST_BARS: '-1' })).toMatchObject({
      INTRADAY_POSITIONING_WINDOW_MIN: 45,
      BREAKOUT_PERSIST_BARS: 4,
    });
  });

  it('the stamp carries the new version and both flag sets; the review set is unchanged', () => {
    expect(LOGIC_VERSION).toBe('2026-09-29.coverage-lag.1');
    const stamp = logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS, COVERAGE_LAG_FLAG_DEFAULTS, COVERAGE_LAG_PARAM_DEFAULTS, [
      { symbol: 'CRUDEOIL', exchange: 'MCX' },
    ]);
    expect(stamp.flags).toEqual(TRADING_FLAG_DEFAULTS);
    expect(stamp.params).toEqual(TRADING_PARAM_DEFAULTS);
    expect(stamp.coverageLag).toEqual({
      flags: COVERAGE_LAG_FLAG_DEFAULTS,
      params: COVERAGE_LAG_PARAM_DEFAULTS,
      backgroundSymbols: [{ symbol: 'CRUDEOIL', exchange: 'MCX' }],
    });
    const snapshotSrc = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/decision-snapshot.ts'), 'utf-8');
    expect(snapshotSrc).toContain('coverageLag: logic.coverageLag ?? null');
  });

  it('positioningBaseline and regimeSource are recorded in entryContext and the decision snapshot', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    expect(src).toContain('    positioningBaseline,\n    regimeSource,');
    expect(src).toContain('positioningBaseline: entryContext?.positioningBaseline ?? null,');
    expect(src).toContain('regimeSource: entryContext?.regimeSource ?? null,');
  });

  it('the daily risk breaker stays disabled', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/risk-circuit-breaker.ts'), 'utf-8');
    expect(src).toContain('export const DAILY_RISK_BREAKER_ENABLED = false;');
  });
});
