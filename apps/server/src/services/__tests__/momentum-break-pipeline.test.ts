// ============================================================
// MOMENTUM-BREAK — live pipeline rules
// ============================================================
//   1. the trigger's chain has the safety gates and TRIGGER_QUALITY, and no
//      LOW_SETUP_QUALITY / location / room / positioning gate;
//   2. a consensus reversal never closes a trigger trade; only stop, target,
//      session end or LEVEL_RECLAIMED do;
//   3. an opposite-direction consensus setup is closed TRIGGER_REVERSAL
//      before the trigger mints; a same-direction one is left alone;
//   4. the post-loss 80 floor applies to the trigger's quality;
//   5. the premium stop reaches buildTradeSetup through slPremiumPct as
//      max(0.15, |Δ|·stop distance / mid);
//   6. the flag, its env override, the allow-list and the logic stamp.
// All inputs are FABRICATED fixtures.
// ============================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { MomentumBreakSignal } from '@fno/analytics';

const redisState = vi.hoisted(() => ({ ttl: new Map<string, number>(), values: new Map<string, string>() }));
vi.mock('../../lib/redis.js', () => ({
  redis: {
    ttl: vi.fn(async (k: string) => redisState.ttl.get(k) ?? -2),
    get: vi.fn(async (k: string) => redisState.values.get(k) ?? null),
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    on: vi.fn(),
  },
  scanKeys: vi.fn(async () => []),
}));
vi.mock('../../lib/db.js', () => ({ sql: vi.fn() }));

import {
  isTriggerTrade,
  safetyRefusal,
  triggerQualityDiagnostic,
  triggerRefusal,
  triggerSlotAction,
  triggerSlPremiumPct,
  mergeCandleHistory,
  toClosedMomentumBars,
  MOMENTUM_BREAK_STRATEGY,
} from '../momentum-break-live.js';
import { losingCloseCooldownReason } from '../market-bias.js';
import {
  LOGIC_VERSION,
  logicStamp,
  momentumBreakEnabledFor,
  MOMENTUM_BREAK_DEFAULT,
  MOMENTUM_BREAK_PARAM_DEFAULTS,
  parseMomentumBreakSymbols,
  readMomentumBreakFlag,
  readMomentumBreakParams,
  TRADING_FLAG_DEFAULTS,
  TRADING_PARAM_DEFAULTS,
  COVERAGE_LAG_FLAG_DEFAULTS,
  COVERAGE_LAG_PARAM_DEFAULTS,
} from '../../config/trading-flags.js';
import { exitReasonFromCloseReason } from '../exit-reason.js';
import { invalidationReasonFromCloseReason } from '../invalidation-reason.js';
import { gateForRefusalCode } from '../gate-diagnostics.js';
import { leg } from './trade-setup-fixtures.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const BAR = 15 * 60 * 1000;
const T0 = Date.parse('2026-09-28T21:45:00+05:30');

function signal(over: Partial<MomentumBreakSignal> = {}): MomentumBreakSignal {
  return {
    direction: 'BEARISH',
    levelKind: 'DAY_LOW',
    levelPrice: 9080,
    entry: 8879,
    stop: 9100,
    target: 8700,
    targetKind: 'PIVOT_S1',
    rUnderlying: 1.6,
    volMult: 5,
    rangeMult: 3,
    closeLocation: 0.1,
    atr: 40,
    quality: 78,
    barTime: T0,
    variantId: 'R1.5-V1.5',
    ...over,
  };
}
const NOW = T0 + BAR + 60_000; // one minute after the trigger bar closed
const SAFE = { riskOff: null, feedBlock: null, session: null, cooldown: null, reliability: null, concurrency: null };

describe('1. the trigger chain: safety gates + TRIGGER_QUALITY, no consensus-only gates', () => {
  it('a trigger of quality 70 (below the consensus 75 floor) passes — LOW_SETUP_QUALITY is not in its chain', () => {
    expect(triggerRefusal(SAFE, signal({ quality: 70 }), NOW, 8890)).toBeNull();
  });

  it('each safety gate still refuses, in the live chain order', () => {
    const s = signal();
    expect(triggerRefusal({ ...SAFE, riskOff: 'breaker' }, s, NOW, 8890)?.code).toBe('RISK_OFF');
    expect(triggerRefusal({ ...SAFE, feedBlock: 'stale' }, s, NOW, 8890)?.code).toBe('NO_QUOTE');
    expect(triggerRefusal({ ...SAFE, session: { code: 'OPENING_HOUR', reason: 'x' } }, s, NOW, 8890)?.code).toBe('OPENING_HOUR');
    expect(triggerRefusal({ ...SAFE, session: { code: 'CLOSING_HOUR', reason: 'x' } }, s, NOW, 8890)?.code).toBe('CLOSING_HOUR');
    expect(triggerRefusal({ ...SAFE, cooldown: { code: 'POST_LOSS_COOLDOWN', reason: 'x' } }, s, NOW, 8890)?.code).toBe('POST_LOSS_COOLDOWN');
    expect(triggerRefusal({ ...SAFE, reliability: 'ex-date' }, s, NOW, 8890)?.code).toBe('RELIABILITY_FILTER');
    expect(triggerRefusal({ ...SAFE, concurrency: { code: 'CONCURRENT_EXPOSURE', reason: 'x' } }, s, NOW, 8890)?.code).toBe('CONCURRENT_EXPOSURE');
    expect(safetyRefusal({ ...SAFE, riskOff: 'a', feedBlock: 'b' })?.code).toBe('RISK_OFF');
  });

  it('TRIGGER_QUALITY: no trigger, a stale bar, price back through the level, or already at the target', () => {
    expect(triggerRefusal(SAFE, null, NOW, 8890)?.code).toBe('TRIGGER_QUALITY');
    expect(triggerRefusal(SAFE, signal(), T0 + 2 * BAR + 1, 8890)?.code).toBe('TRIGGER_QUALITY');
    expect(triggerRefusal(SAFE, signal(), NOW, 9085)?.code).toBe('TRIGGER_QUALITY');
    expect(triggerRefusal(SAFE, signal(), NOW, 8690)?.code).toBe('TRIGGER_QUALITY');
    expect(gateForRefusalCode('TRIGGER_QUALITY')).toBe('TRIGGER_QUALITY');
  });

  it('the TRIGGER_QUALITY diagnostic row says which gates this family does not enforce', () => {
    const row = triggerQualityDiagnostic(signal(), null, NOW);
    expect(row.gate).toBe('TRIGGER_QUALITY');
    expect(row.status).toBe('PASS');
    expect(row.input_values.notEnforced).toEqual(['LOW_SETUP_QUALITY', 'POOR_LOCATION', 'INSUFFICIENT_ROOM', 'POSITIONING_CONFLICT']);
    expect(triggerQualityDiagnostic(null, { code: 'TRIGGER_QUALITY', reason: 'none' }, NOW)).toMatchObject({ status: 'FAIL', was_deciding_gate: true });
  });

  it('market-bias wires the trigger through this chain and judges the cooldown on quality', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    expect(src).toContain('const cooldown = await losingCloseCooldownReason(underlying, exchange, direction, mode, quality);');
    expect(src).toContain('const refusal = triggerRefusal({ riskOff, feedBlock, session, cooldown, reliability, concurrency }, trigger, at, spot);');
  });
});

describe('2-3. the shared slot', () => {
  const triggerTrade = {
    direction: 'BEARISH',
    strategy: MOMENTUM_BREAK_STRATEGY,
    momentumBreak: { direction: 'BEARISH' as const, levelKind: 'DAY_LOW' as const, levelPrice: 9080, barTime: T0, entry: 8879, stop: 9100, target: 8700, targetKind: 'PIVOT_S1' as const, quality: 78, variantId: 'R1.5-V1.5' },
  };
  const consensusBull = { direction: 'BULLISH', strategy: undefined, momentumBreak: undefined };

  it('a consensus reversal does not close a trigger trade: with no opposing trigger it HOLDs', () => {
    expect(isTriggerTrade(triggerTrade)).toBe(true);
    expect(triggerSlotAction({ stored: triggerTrade, trigger: null, lastClosedBar: { time: T0 + BAR, close: 8950 } })).toEqual({ kind: 'HOLD_TRIGGER' });
  });

  it('a trigger trade closes LEVEL_RECLAIMED on a later closed bar back through its level (not on the trigger bar itself)', () => {
    expect(triggerSlotAction({ stored: triggerTrade, trigger: null, lastClosedBar: { time: T0 + BAR, close: 9081 } })).toEqual({ kind: 'CLOSE', reason: 'LEVEL_RECLAIMED' });
    expect(triggerSlotAction({ stored: triggerTrade, trigger: null, lastClosedBar: { time: T0, close: 9081 } })).toEqual({ kind: 'HOLD_TRIGGER' });
  });

  it('an opposite-direction consensus setup is closed TRIGGER_REVERSAL; a same-direction one is left to the consensus logic', () => {
    expect(triggerSlotAction({ stored: consensusBull, trigger: signal(), lastClosedBar: null })).toEqual({ kind: 'CLOSE', reason: 'TRIGGER_REVERSAL' });
    expect(triggerSlotAction({ stored: consensusBull, trigger: signal({ direction: 'BULLISH' }), lastClosedBar: null })).toEqual({ kind: 'CONSENSUS_FLOW' });
    expect(triggerSlotAction({ stored: consensusBull, trigger: null, lastClosedBar: null })).toEqual({ kind: 'CONSENSUS_FLOW' });
  });

  it('market-bias checks the premium stop/target first, then the slot action, before any BIAS_REVERSED exit', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');
    const hold = src.indexOf("} else if (slotAction.kind === 'HOLD_TRIGGER') {");
    const hit = src.indexOf('    if (hitSL || hitTarget) {\n      const outcome = classifyPriceHitOutcome');
    const reversal = src.indexOf("reason: 'BIAS_REVERSED' });");
    expect(hit).toBeGreaterThan(0);
    expect(hold).toBeGreaterThan(hit);
    expect(reversal).toBeGreaterThan(hold);
  });

  it('the new close reasons are named in the exit and invalidation vocabularies', () => {
    expect(exitReasonFromCloseReason('LEVEL_RECLAIMED')).toBe('INVALIDATED');
    expect(exitReasonFromCloseReason('TRIGGER_REVERSAL')).toBe('INVALIDATED');
    expect(invalidationReasonFromCloseReason('LEVEL_RECLAIMED')).toBe('UNDERLYING_STRUCTURAL_INVALIDATION');
  });
});

describe('4. the post-loss 80 floor applies to the trigger quality', () => {
  beforeEach(() => {
    redisState.ttl.clear();
    redisState.values.clear();
  });
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  it('after a same-day loss, quality 78 is refused and quality 85 is not', async () => {
    redisState.values.set(`trade_setup_post_loss_day:MCX:INTRADAY:${today()}`, '1');
    expect((await losingCloseCooldownReason('CRUDEOIL', 'MCX', 'BEARISH', 'INTRADAY', 78))?.code).toBe('POST_LOSS_COOLDOWN');
    expect(await losingCloseCooldownReason('CRUDEOIL', 'MCX', 'BEARISH', 'INTRADAY', 85)).toBeNull();
  });

  it('with no loss today quality 78 passes the cooldown', async () => {
    expect(await losingCloseCooldownReason('CRUDEOIL', 'MCX', 'BEARISH', 'INTRADAY', 78)).toBeNull();
  });
});

describe('5. the trigger stop reaches the builder through slPremiumPct', () => {
  const strikes = [{ strike: 8900, distanceFromSpot: 0, call: leg({ ltp: 460, bid: 459, ask: 461, delta: 0.5 }), put: leg({ ltp: 460, bid: 459, ask: 461, delta: -0.5 }) }];
  it('is |Δ|·stop distance / mid when that is above 15%', () => {
    const r = triggerSlPremiumPct(strikes, 8900, 'BEARISH', 221)!;
    expect(r.slPremiumPct).toBeCloseTo((0.5 * 221) / 460, 10);
  });
  it('is floored at 15%', () => {
    expect(triggerSlPremiumPct(strikes, 8900, 'BULLISH', 40)!.slPremiumPct).toBe(0.15);
  });
  it('is null without a usable ATM quote', () => {
    expect(triggerSlPremiumPct(strikes, 9000, 'BULLISH', 40)).toBeNull();
  });
});

describe('6. flag, allow-list and logic stamp', () => {
  it('MOMENTUM_BREAK follows the pre-registered outcome by default and is env-configurable', () => {
    expect(readMomentumBreakFlag({})).toBe(MOMENTUM_BREAK_DEFAULT);
    expect(readMomentumBreakFlag({ MOMENTUM_BREAK: 'true' })).toBe(true);
    expect(readMomentumBreakFlag({ MOMENTUM_BREAK: 'off' })).toBe(false);
    expect(readMomentumBreakParams({ MOMENTUM_BREAK_VOL_MULT: '2' })).toMatchObject({ MOMENTUM_BREAK_VOL_MULT: 2, MOMENTUM_BREAK_RANGE_MULT: MOMENTUM_BREAK_PARAM_DEFAULTS.MOMENTUM_BREAK_RANGE_MULT });
  });

  it('runs only INTRADAY, only on allow-listed symbols, only with the flag on', () => {
    const syms = parseMomentumBreakSymbols('CRUDEOIL:MCX,NIFTY:NSE').symbols;
    expect(momentumBreakEnabledFor('CRUDEOIL', 'MCX', 'INTRADAY', true, syms)).toBe(true);
    expect(momentumBreakEnabledFor('CRUDEOIL', 'MCX', 'POSITIONAL', true, syms)).toBe(false);
    expect(momentumBreakEnabledFor('GOLD', 'MCX', 'INTRADAY', true, syms)).toBe(false);
    expect(momentumBreakEnabledFor('CRUDEOIL', 'MCX', 'INTRADAY', false, syms)).toBe(false);
  });

  it('the momentum-break version is stamped only while the flag is on', () => {
    expect(LOGIC_VERSION).toBe('2026-09-29.coverage-lag.1');
    const off = logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS, COVERAGE_LAG_FLAG_DEFAULTS, COVERAGE_LAG_PARAM_DEFAULTS, [], false, MOMENTUM_BREAK_PARAM_DEFAULTS, []);
    expect(off.logicVersion).toBe('2026-09-29.coverage-lag.1');
    const stamp = logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS, COVERAGE_LAG_FLAG_DEFAULTS, COVERAGE_LAG_PARAM_DEFAULTS, [], true, MOMENTUM_BREAK_PARAM_DEFAULTS, [{ symbol: 'CRUDEOIL', exchange: 'MCX' }]);
    expect(stamp.logicVersion).toBe('2026-09-29.momentum-break.1');
    expect(stamp.momentumBreak).toEqual({ enabled: true, params: MOMENTUM_BREAK_PARAM_DEFAULTS, symbols: [{ symbol: 'CRUDEOIL', exchange: 'MCX' }] });
  });

  it('the daily risk breaker stays disabled', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/risk-circuit-breaker.ts'), 'utf-8');
    expect(src).toContain('export const DAILY_RISK_BREAKER_ENABLED = false;');
  });
});

describe('live candles → closed bars', () => {
  const c = (iso: string, close: number, volume = 10) => ({ timestamp: iso, open: close, high: close, low: close, close, volume });
  it('drops the forming bar and out-of-session bars, and lets fresh candles win over history', () => {
    const merged = mergeCandleHistory([c('2026-09-28T21:30:00+05:30', 1, 5)], [c('2026-09-28T21:30:00+05:30', 2, 7), c('2026-09-28T21:45:00+05:30', 3)]);
    expect(merged.map((m) => m.close)).toEqual([2, 3]);
    const bars = toClosedMomentumBars([...merged, c('2026-09-28T08:00:00+05:30', 9)], 'MCX', Date.parse('2026-09-28T21:55:00+05:30'));
    expect(bars.map((b) => b.close)).toEqual([2]);
  });
});

describe('reporting: by-strategy split beside the logic-version split', () => {
  it('Backtesting splits MOMENTUM_BREAK from CONSENSUS (legacy strategies count as consensus)', async () => {
    const { strategyBuckets, strategyFamilyOfSetup } = await import('../backtesting.js');
    const rec = (id: string, strategy: string | null, outcome: 'WIN' | 'LOSS', returnPercent: number) =>
      ({ id, symbol: 'CRUDEOIL', strategy, outcome, returnPercent, entry: 100, stopLoss: 70, structureType: 'NAKED_LONG', estimatedCostPct: 0, generatedAt: 1 }) as never;
    expect(strategyFamilyOfSetup({ strategy: 'BULL_CALL_SPREAD' })).toBe('CONSENSUS');
    const buckets = strategyBuckets([rec('a', 'MOMENTUM_BREAK', 'WIN', 60), rec('b', null, 'LOSS', -30), rec('c', 'MOMENTUM_BREAK', 'LOSS', -30)]);
    const by = Object.fromEntries(buckets.map((b) => [b.strategy, b]));
    expect(by.MOMENTUM_BREAK).toMatchObject({ total: 2, wins: 1, losses: 1, totalRMultiple: 1 });
    expect(by.CONSENSUS).toMatchObject({ total: 1, losses: 1, totalRMultiple: -1 });
  });

  it('loss attribution groups decisions by setup family', async () => {
    const { buildAttributionReport, strategyFamilyOf } = await import('../loss-attribution-model.js');
    expect(strategyFamilyOf({ setupFamily: 'MOMENTUM' })).toBe('MOMENTUM_BREAK');
    expect(strategyFamilyOf({ setupFamily: 'BREAKOUT' })).toBe('CONSENSUS');
    const row = (setupFamily: string | null) => ({ decisionId: 'x', time: 1, symbol: 'X', bias: 'BULLISH', regime: null, confidence: 80, strategy: 'S', side: 'CE', strikeDistanceAtr: null, delta: null, dte: null, ivPct: null, sessionBucket: null, signalAgeSeconds: null, spreadPct: null, exitReason: null, mfeAtr: null, maeAtr: null, simR: 1, premiumR: null, eventualExitReason: null, deadAt: null, setupFamily }) as never;
    const report = buildAttributionReport([row('MOMENTUM'), row(null), row('BREAKOUT')]);
    expect(report.byStrategy.map((g) => [g.key, g.n])).toEqual(expect.arrayContaining([['MOMENTUM_BREAK', 1], ['CONSENSUS', 2]]));
  });
});
