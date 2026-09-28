// ============================================================
// VALIDATION REVIEW — one test block per flag
// ============================================================
// Every chain number here is a FABRICATED fixture (see trade-setup-fixtures.ts).
// The checks are the plan's verification list:
//   - structural stop widens, never tightens, refuses instead of squeezing,
//     caps at 45% with stopBeforeStructure;
//   - rich-IV uses 2.0;
//   - flags OFF + every new input present = the golden (pre-review) output;
//   - location gate refuses below 40; room V2 uses the capped target;
//   - closing guard boundaries per exchange (NSE and MCX, 59/60/61 minutes);
//   - concurrency cap refuses at the threshold only when ON;
//   - gate diagnostics carry the new gates, observation only;
//   - trading-flag defaults, the logic stamp, and the protected-constant audit.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildTradeSetup, MIN_RISK_REWARD, RICH_IV_MIN_RISK_REWARD, STRUCTURAL_STOP_BUFFER_ATR } from '@fno/analytics';
import { ATM, LOT, GOLDEN_CASES, strikesWith } from './trade-setup-fixtures.js';
import {
  closingGuardReason,
  concurrencyGateReason,
  concurrentCount,
  evaluateValidationGateDiagnostics,
  locationGateReason,
  minutesToSessionClose,
  roomGateReason,
  roomV2,
  type ValidationGateInputs,
} from '../validation-gates.js';
import { computeExposure, exposureSetupsFrom, type ExposureSetup } from '../exposure-tracker.js';
import { evaluateGateDiagnostics, firstFailingGate, gateForRefusalCode, LIVE_CHAIN_GATES, VALIDATION_GATES } from '../gate-diagnostics.js';
import { stopOvershootPct } from '../stop-overshoot.js';
import { classifyRefusal } from '../research-contract.js';
import {
  LOGIC_VERSION,
  TRADING_FLAG_DEFAULTS,
  TRADING_PARAM_DEFAULTS,
  logicStamp,
  parseFlag,
  readTradingFlags,
  readTradingParams,
} from '../../config/trading-flags.js';
import { auditProtectedConstants, PROTECTED_CONSTANT_COUNT } from '../protected-constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../../../../../');

// A liquid ATM call: entry 100, delta 0.5, VIX 16 widens the 30% base stop to 32%.
const LIQUID = { ltp: 100, bid: 99.5, ask: 100.5, volume: 20000, oi: 300000, delta: 0.5, theta: -5 };
const SPOT = 25000;
const ATR = 30;

function build(move: number, extra: Parameters<typeof buildTradeSetup>[10] = {}) {
  return buildTradeSetup(strikesWith(LIQUID), ATM, 'BULLISH', 80, move, undefined, 16, 2, LOT, ATR, { tickSize: 0.05, expectedHoldHours: 3, ...extra });
}
const ss = (level: number | null) => ({ flags: { structuralStop: true }, spot: SPOT, nearestBehindLevel: level });
const stopWidth = (s: ReturnType<typeof build>) => (s.entry ?? 0) - (s.stopLoss ?? 0);

// ---------------- FIX 1: STRUCTURAL STOP ----------------
describe('STRUCTURAL_STOP — the stop widens to structure and is never squeezed', () => {
  it('widens the base stop when the level behind needs more room', () => {
    // |delta| × (60 pts behind + 0.25 × 30 ATR) = 0.5 × 67.5 = 33.75 > the 32% base.
    const s = build(140, ss(SPOT - 60));
    expect(s.available).toBe(true);
    expect(stopWidth(s)).toBeCloseTo(33.75, 2);
    expect(s.structuralStop).toMatchObject({ source: 'STRUCTURE', baseStopWidth: 32, structuralStopWidth: 33.75, stopBeforeStructure: false });
    expect(s.stopBeforeStructure).toBe(false);
  });

  it('never tightens: a level right behind the entry leaves the base stop in place', () => {
    const s = build(140, ss(SPOT - 5)); // structural 6.25 < base 32
    expect(s.available).toBe(true);
    expect(stopWidth(s)).toBeCloseTo(32, 2);
    expect(s.structuralStop?.source).toBe('BASE');
  });

  it('never tightens relative to the pre-review stop, across levels and moves', () => {
    for (const move of [100, 120, 140, 200, 300]) {
      for (const behind of [1, 10, 40, 60, 90, 150]) {
        const off = build(move);
        const on = build(move, ss(SPOT - behind));
        if (off.available && on.available) expect(stopWidth(on)).toBeGreaterThanOrEqual(stopWidth(off) - 1e-9);
        if (on.available) expect(stopWidth(on)).toBeGreaterThanOrEqual(32 - 1e-9);
      }
    }
  });

  it('refuses with REWARD_RISK_TOO_LOW instead of squeezing the stop to fit', () => {
    // Pre-review: a 30-point target squeezed the stop to ~15% to reach 1.5.
    const off = build(60);
    expect(off.available).toBe(true);
    expect(stopWidth(off)).toBeLessThan(20);
    const on = build(60, ss(SPOT - 5));
    expect(on.available).toBe(false);
    expect(on.noTradeCode).toBe('REWARD_RISK_TOO_LOW');
    expect(on.reason.startsWith('Reward:risk after costs')).toBe(true); // market-bias.ts's stock note keys off this
    expect(on.reason).toContain('not squeezed');
  });

  it('caps at 45% of premium and records stopBeforeStructure instead of refusing', () => {
    // 0.5 × (150 + 7.5) = 78.75 wanted; cap is 45.
    const s = build(400, ss(SPOT - 150));
    expect(s.available).toBe(true);
    expect(stopWidth(s)).toBeCloseTo(45, 2);
    expect(s.stopBeforeStructure).toBe(true);
    expect(s.structuralStop).toMatchObject({ capWidth: 45, stopBeforeStructure: true, structuralStopWidth: 78.75 });
    expect(s.reason).toContain('fires BEFORE that structure');
  });

  it('with no level behind, the stop is the base stop (no squeeze)', () => {
    const s = build(140, ss(null));
    expect(s.available).toBe(true);
    expect(stopWidth(s)).toBeCloseTo(32, 2);
    expect(s.structuralStop).toMatchObject({ structuralStopWidth: null, source: 'BASE' });
  });

  it('uses the configured buffer, defaulting to the untested 0.25 ATR', () => {
    expect(STRUCTURAL_STOP_BUFFER_ATR).toBe(0.25);
    const s = build(200, { ...ss(SPOT - 60), structuralStopBufferAtr: 1 }); // 0.5 × (60 + 30) = 45
    expect(stopWidth(s)).toBeCloseTo(45, 2);
  });
});

// ---------------- FIX 6: RICH-IV R:R ----------------
describe('RICH_IV_RR — rich IV needs 2.0 after costs', () => {
  it('the constants: 2.0 for rich IV, MIN_RISK_REWARD still 1.5', () => {
    expect(RICH_IV_MIN_RISK_REWARD).toBe(2);
    expect(MIN_RISK_REWARD).toBe(1.5);
  });

  it('refuses a setup that clears 1.5 but not 2.0 when IV is RICH', () => {
    const base = { ...ss(SPOT - 5) };
    expect(build(140, base).available).toBe(true); // 70-pt target vs 32% stop clears 1.5
    const rich = build(140, { ...base, flags: { structuralStop: true, richIvRr: true }, ivVsHv: 'RICH' });
    expect(rich.available).toBe(false);
    expect(rich.noTradeCode).toBe('REWARD_RISK_TOO_LOW');
    expect(rich.reason).toContain('below the 2 minimum');
  });

  it('applies only to RICH readings, and records the bar it applied', () => {
    const fair = build(140, { ...ss(SPOT - 5), flags: { structuralStop: true, richIvRr: true }, ivVsHv: 'FAIR' });
    expect(fair.available).toBe(true);
    expect(fair.requiredRiskReward).toBe(1.5);
    const richWide = build(200, { ...ss(SPOT - 5), flags: { structuralStop: true, richIvRr: true }, ivVsHv: 'RICH' });
    expect(richWide.available).toBe(true);
    expect(richWide.requiredRiskReward).toBe(2);
  });

  it('with the flag off, RICH IV changes nothing', () => {
    expect(JSON.stringify(build(140, { ...ss(SPOT - 5), ivVsHv: 'RICH' }))).toBe(JSON.stringify(build(140, ss(SPOT - 5))));
  });

  it('on the legacy (non-structural) path the bar is 2.0 too', () => {
    const rich = build(60, { flags: { richIvRr: true }, ivVsHv: 'RICH' });
    expect(rich.available).toBe(false);
    expect(rich.reason).toContain('below the 2 minimum even at the tightest tradeable stop');
  });
});

// ---------------- FLAGS OFF = GOLDEN ----------------
describe('all flags OFF with every new input supplied = the pre-review output', () => {
  it('matches the no-input call for every golden case', () => {
    for (const [name, args] of Object.entries(GOLDEN_CASES)) {
      const a = args();
      const plain = buildTradeSetup(...a);
      const withInputs = a.slice() as typeof a;
      withInputs[10] = {
        ...(a[10] ?? {}),
        flags: { structuralStop: false, richIvRr: false },
        spot: 25000,
        nearestBehindLevel: 24900,
        structuralStopBufferAtr: 0.5,
        ivVsHv: 'RICH',
        richIvMinRiskReward: 3,
      };
      expect(JSON.stringify(buildTradeSetup(...withInputs)), name).toBe(JSON.stringify(plain));
      expect(Object.keys(buildTradeSetup(...withInputs)).sort(), name).toEqual(Object.keys(plain).sort());
    }
  });
});

// ---------------- FIX 2: LOCATION GATE + ROOM V2 ----------------
describe('LOCATION_GATE — refuses below 40', () => {
  it('39 refuses, 40 passes, off never refuses, unknown never refuses', () => {
    expect(locationGateReason({ enabled: true, locationScore: 39, minScore: 40 })?.code).toBe('POOR_LOCATION');
    expect(locationGateReason({ enabled: true, locationScore: 40, minScore: 40 })).toBeNull();
    expect(locationGateReason({ enabled: false, locationScore: 5, minScore: 40 })).toBeNull();
    expect(locationGateReason({ enabled: true, locationScore: null, minScore: 40 })).toBeNull();
  });
  it('40 is the existing shadow threshold, not a new number', () => {
    expect(TRADING_PARAM_DEFAULTS.LOCATION_GATE_MIN_SCORE).toBe(40);
  });
});

describe('ROOM V2 — required room is the target actually used', () => {
  it('divides the CAPPED target move by ATR, not the uncapped expected move', () => {
    // Uncapped move 150, capped by a wall to 45; ATR 30.
    const v2 = roomV2({ availableAtr: 2, targetMovePoints: 45, atrPoints: 30 });
    expect(v2.requiredAtrV2).toBeCloseTo(1.5, 6);
    expect(v2.sufficientV2).toBe(true); // 2 >= 1.5 × 1.15
    const v1Required = 150 / 30; // what the old measure would have demanded
    expect(v1Required).toBeGreaterThan(2);
  });
  it('insufficient V2 refuses only when ROOM_GATE is on (default OFF)', () => {
    const v2 = roomV2({ availableAtr: 1, targetMovePoints: 45, atrPoints: 30 });
    expect(v2.sufficientV2).toBe(false);
    expect(roomGateReason({ enabled: false, ...v2, availableAtr: 1 })).toBeNull();
    expect(roomGateReason({ enabled: true, ...v2, availableAtr: 1 })?.code).toBe('INSUFFICIENT_ROOM');
    expect(TRADING_FLAG_DEFAULTS.ROOM_GATE).toBe(false);
  });
  it('unknown room never refuses', () => {
    const v2 = roomV2({ availableAtr: null, targetMovePoints: 45, atrPoints: 30 });
    expect(v2.sufficientV2).toBeNull();
    expect(roomGateReason({ enabled: true, ...v2, availableAtr: null })).toBeNull();
  });
});

// ---------------- FIX 5: CLOSING GUARD ----------------
describe('CLOSING_GUARD — per-exchange close, 59/60/61 minutes', () => {
  const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
  const guard = (exchange: 'NSE' | 'MCX', at: number, mode: 'INTRADAY' | 'POSITIONAL' = 'INTRADAY', enabled = true) =>
    closingGuardReason({ enabled, mode, exchange, minutesToClose: minutesToSessionClose(exchange, at), guardMinutes: 60 });

  it('NSE closes 15:30: 59 minutes left refuses, 60 and 61 do not', () => {
    const d = '2026-10-14'; // a Wednesday, not a holiday
    expect(minutesToSessionClose('NSE', ist(d, '14:31'))).toBe(59);
    expect(guard('NSE', ist(d, '14:31'))?.code).toBe('CLOSING_HOUR');
    expect(guard('NSE', ist(d, '14:30'))).toBeNull();
    expect(guard('NSE', ist(d, '14:29'))).toBeNull();
  });

  // These two cases were reversed before the coverage-lag round: they
  // asserted the old (wrong) mapping. Real candles on 24-25 Sep 2026 (US DST)
  // end with the 23:15 bar, so the DST close is 23:30 and the winter close 23:55.
  it('MCX closes 23:30 during US DST: 59 refuses, 60 and 61 do not', () => {
    const d = '2026-10-14';
    expect(minutesToSessionClose('MCX', ist(d, '22:31'))).toBe(59);
    expect(guard('MCX', ist(d, '22:31'))?.code).toBe('CLOSING_HOUR');
    expect(guard('MCX', ist(d, '22:30'))).toBeNull();
    expect(guard('MCX', ist(d, '22:29'))).toBeNull();
  });

  it('MCX closes 23:55 outside US DST — the same close times remainingSessionFraction uses', () => {
    const d = '2026-12-09';
    expect(guard('MCX', ist(d, '22:56'))?.code).toBe('CLOSING_HOUR');
    expect(guard('MCX', ist(d, '22:55'))).toBeNull();
    expect(guard('MCX', ist(d, '22:54'))).toBeNull();
    // At 22:31 NSE-style timing MCX still has 84 minutes.
    expect(guard('MCX', ist(d, '22:31'))).toBeNull();
  });

  it('POSITIONAL is never refused, the flag off never refuses, and outside a session nothing is measured', () => {
    const d = '2026-10-14';
    expect(guard('NSE', ist(d, '15:10'), 'POSITIONAL')).toBeNull();
    expect(guard('NSE', ist(d, '15:10'), 'INTRADAY', false)).toBeNull();
    expect(minutesToSessionClose('NSE', ist(d, '16:00'))).toBeNull();
    expect(minutesToSessionClose('NSE', ist('2026-10-17', '14:31'))).toBeNull(); // Saturday
  });
});

// ---------------- FIX 4: CONCURRENCY CAP ----------------
describe('CONCURRENCY_CAP — refuses at the threshold only when ON', () => {
  const setup = (underlying: string, direction: 'BULLISH' | 'BEARISH', over: Partial<ExposureSetup> = {}): ExposureSetup => ({
    key: `trade_setup:NSE:${underlying}:INTRADAY`,
    exchange: 'NSE',
    underlying,
    mode: 'INTRADAY',
    direction,
    strike: null,
    side: null,
    expiry: null,
    riskAmount: 1000,
    ...over,
  });
  const current = setup('NIFTY', 'BULLISH', { riskAmount: 0 });

  it('counts same-direction peers plus correlated (same index family) ones', () => {
    const exp = computeExposure(current, [setup('BANKNIFTY', 'BULLISH'), setup('FINNIFTY', 'BULLISH'), setup('RELIANCE', 'BEARISH')]);
    expect(exp.sameDirectionExposure).toBe(2);
    expect(exp.correlatedExposure).toBe(2);
    expect(concurrentCount(exp)).toBe(4);
  });

  it('at the threshold refuses when ON, never when OFF', () => {
    const atThree = computeExposure(current, [setup('RELIANCE', 'BULLISH'), setup('TCS', 'BULLISH'), setup('INFY', 'BULLISH')]);
    expect(concurrentCount(atThree)).toBe(3);
    expect(concurrencyGateReason({ enabled: true, exposure: atThree, max: 3 })?.code).toBe('CONCURRENT_EXPOSURE');
    expect(concurrencyGateReason({ enabled: false, exposure: atThree, max: 3 })).toBeNull();
    const belowThree = computeExposure(current, [setup('BANKNIFTY', 'BULLISH')]); // 1 + 1
    expect(concurrentCount(belowThree)).toBe(2);
    expect(concurrencyGateReason({ enabled: true, exposure: belowThree, max: 3 })).toBeNull();
    expect(concurrencyGateReason({ enabled: true, exposure: null, max: 3 })).toBeNull();
    expect(TRADING_FLAG_DEFAULTS.CONCURRENCY_CAP).toBe(false);
    expect(TRADING_PARAM_DEFAULTS.MAX_CONCURRENT_SAME_DIRECTION).toBe(3);
  });

  it('MGET results pair back to their keys; missing or corrupt values are skipped', () => {
    const today = '2026-10-14';
    const stored = (direction: string) => JSON.stringify({ available: true, direction, day: today, entry: 100, stopLoss: 70, positionSize: { quantity: 75 } });
    const keys = ['trade_setup:NSE:BANKNIFTY:INTRADAY', 'trade_setup:NSE:TCS:INTRADAY', 'trade_setup:NSE:INFY:INTRADAY', 'trade_setup:NSE:SBIN:INTRADAY'];
    const out = exposureSetupsFrom(keys, [stored('BULLISH'), null, '{not json', stored('BEARISH')], today);
    expect(out.map((o) => o.underlying)).toEqual(['BANKNIFTY', 'SBIN']);
    expect(out[0].riskAmount).toBe(30 * 75);
  });
});

// ---------------- GATE DIAGNOSTICS ----------------
describe('gate diagnostics carry the new gates — observation only', () => {
  const inputs = (over: Partial<ValidationGateInputs> = {}): ValidationGateInputs => ({
    mode: 'INTRADAY',
    exchange: 'NSE',
    liveRefusalCode: null,
    closing: { enforced: true, minutesToClose: 120, guardMinutes: 60 },
    location: { enforced: true, score: 55, minScore: 40 },
    room: { enforced: false, availableAtr: 2, requiredAtrV2: 1.5, sufficientV2: true, requiredAtrV1: 5, sufficientV1: false },
    concurrency: { enforced: false, exposure: null, max: 3 },
    ...over,
  });

  it('one row per validation gate, none of them in LIVE_CHAIN_GATES', () => {
    const rows = evaluateValidationGateDiagnostics(inputs(), 1);
    expect(rows.map((r) => r.gate)).toEqual([...VALIDATION_GATES]);
    for (const g of VALIDATION_GATES) expect(LIVE_CHAIN_GATES).not.toContain(g);
    const status = Object.fromEntries(rows.map((r) => [r.gate, r.status]));
    expect(status).toEqual({ CLOSING_HOUR: 'PASS', POOR_LOCATION: 'PASS', INSUFFICIENT_ROOM: 'PASS', CONCURRENT_EXPOSURE: 'NOT_EVALUATED' });
  });

  it('an unenforced gate still reports whether it WOULD refuse, marked enforced:false', () => {
    const rows = evaluateValidationGateDiagnostics(inputs({ room: { enforced: false, availableAtr: 1, requiredAtrV2: 1.5, sufficientV2: false, requiredAtrV1: 5, sufficientV1: false } }), 1);
    const room = rows.find((r) => r.gate === 'INSUFFICIENT_ROOM')!;
    expect(room.status).toBe('FAIL');
    expect(room.input_values.enforced).toBe(false);
    expect(room.was_deciding_gate).toBe(false);
  });

  it('marks the deciding gate from the live refusal code', () => {
    const rows = evaluateValidationGateDiagnostics(inputs({ liveRefusalCode: 'POOR_LOCATION', location: { enforced: true, score: 20, minScore: 40 } }), 1);
    expect(rows.filter((r) => r.was_deciding_gate).map((r) => r.gate)).toEqual(['POOR_LOCATION']);
    expect(gateForRefusalCode('CLOSING_HOUR')).toBe('CLOSING_HOUR');
    expect(gateForRefusalCode('CONCURRENT_EXPOSURE')).toBe('CONCURRENT_EXPOSURE');
  });

  it('a CLOSING_HOUR session refusal is not reported as an OPENING_HOUR failure', () => {
    const rows = evaluateGateDiagnostics(
      {
        direction: 'BULLISH',
        mode: 'INTRADAY',
        confidence: 82,
        riskOffReason: null,
        feedBlockReason: null,
        sessionRefusal: { code: 'CLOSING_HOUR', reason: 'late' },
        minutesSinceOpen: 330,
        positioningRefusal: null,
        positioningVotes: { futuresOi: 1, pcr: 0, optionOiFlow: 1 },
        losingClose: { settleTtlSeconds: -2, lostToday: false, sameDirectionLossCount: 0, sameSideCooldownTtlSeconds: -2 },
        reliability: { evaluated: true, reason: null },
        liveRefusalCode: 'CLOSING_HOUR',
        thresholds: { minSetupConfidence: 75, openingSettleMinutes: 5, openingGuardMinutes: 60, postLossSettleMinutes: 15, postLossMinConfidence: 80, maxSameDirectionLossesPerDay: 2 },
      },
      1
    );
    expect(rows.find((r) => r.gate === 'OPENING_HOUR')!.status).toBe('PASS');
    expect(rows.some((r) => r.was_deciding_gate)).toBe(false);
    expect(firstFailingGate(rows)).toBeNull();
    const v = evaluateValidationGateDiagnostics(inputs({ liveRefusalCode: 'CLOSING_HOUR', closing: { enforced: true, minutesToClose: 30, guardMinutes: 60 } }), 1);
    expect(v.find((r) => r.gate === 'CLOSING_HOUR')).toMatchObject({ status: 'FAIL', was_deciding_gate: true });
  });

  it('the new codes classify as refusal kinds', () => {
    expect(classifyRefusal('POOR_LOCATION')).toBe('REFUSED');
    expect(classifyRefusal('INSUFFICIENT_ROOM')).toBe('REFUSED');
    expect(classifyRefusal('CLOSING_HOUR')).toBe('BLOCKED_BY_RISK_CONTROL');
    expect(classifyRefusal('CONCURRENT_EXPOSURE')).toBe('BLOCKED_BY_RISK_CONTROL');
  });
});

// ---------------- FIX 3: STOP OVERSHOOT ----------------
describe('stopOvershootPct — measurement only', () => {
  it('is (stopLoss − exit) / entry, as a fraction of entry', () => {
    expect(stopOvershootPct({ entry: 100, stopLoss: 70 }, 64)).toBe(0.06);
    expect(stopOvershootPct({ entry: 100, stopLoss: 70 }, 70)).toBe(0);
    expect(stopOvershootPct({ entry: 100, stopLoss: 70 }, null)).toBeNull();
    expect(stopOvershootPct({ entry: 0, stopLoss: 70 }, 60)).toBeNull();
  });
});

// ---------------- FLAGS, STAMP, PROTECTED CONSTANTS ----------------
describe('trading flags and the logic stamp', () => {
  it('defaults are exactly the plan’s', () => {
    expect(TRADING_FLAG_DEFAULTS).toEqual({
      STRUCTURAL_STOP: true,
      LOCATION_GATE: true,
      ROOM_GATE: false,
      CONCURRENCY_CAP: false,
      CLOSING_GUARD: true,
      RICH_IV_RR: true,
    });
    expect(TRADING_PARAM_DEFAULTS).toEqual({
      STRUCTURAL_STOP_BUFFER_ATR: 0.25,
      LOCATION_GATE_MIN_SCORE: 40,
      MAX_CONCURRENT_SAME_DIRECTION: 3,
      SETUP_CLOSING_GUARD_MINUTES: 60,
      RICH_IV_MIN_RISK_REWARD: 2,
    });
    expect(readTradingFlags({})).toEqual(TRADING_FLAG_DEFAULTS);
    expect(readTradingParams({})).toEqual(TRADING_PARAM_DEFAULTS);
  });

  it('every flag and tunable is env-configurable, with junk falling back to the default', () => {
    const flags = readTradingFlags({ STRUCTURAL_STOP: 'false', ROOM_GATE: 'on', CONCURRENCY_CAP: '1', CLOSING_GUARD: 'maybe' });
    expect(flags).toMatchObject({ STRUCTURAL_STOP: false, ROOM_GATE: true, CONCURRENCY_CAP: true, CLOSING_GUARD: true });
    expect(parseFlag(undefined, false)).toBe(false);
    const params = readTradingParams({ STRUCTURAL_STOP_BUFFER_ATR: '0.5', SETUP_CLOSING_GUARD_MINUTES: '45', MAX_CONCURRENT_SAME_DIRECTION: '-2' });
    expect(params).toMatchObject({ STRUCTURAL_STOP_BUFFER_ATR: 0.5, SETUP_CLOSING_GUARD_MINUTES: 45, MAX_CONCURRENT_SAME_DIRECTION: 3 });
  });

  it('the stamp carries the version and a copy of every flag', () => {
    const stamp = logicStamp(TRADING_FLAG_DEFAULTS, TRADING_PARAM_DEFAULTS);
    expect(stamp.logicVersion).toBe(LOGIC_VERSION);
    expect(stamp.flags).toEqual(TRADING_FLAG_DEFAULTS);
    expect(stamp.params).toEqual(TRADING_PARAM_DEFAULTS);
  });

  it('the daily risk breaker stays disabled', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/risk-circuit-breaker.ts'), 'utf-8');
    expect(src).toContain('export const DAILY_RISK_BREAKER_ENABLED = false;');
  });

  it('migration 026 is idempotent and registered for boot', () => {
    const sqlText = readFileSync(path.join(REPO_ROOT, 'database/init/026_logic_version.sql'), 'utf-8');
    const statements = sqlText.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) expect(s).toMatch(/IF NOT EXISTS/);
    const ensure = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/ensure-capture-schema.ts'), 'utf-8');
    expect(ensure).toContain("'026_logic_version.sql'");
  });
});

describe('protected-constant audit', () => {
  it('passes: every protected constant is still byte-identical in source', () => {
    const result = auditProtectedConstants((rel) => readFileSync(path.join(REPO_ROOT, rel), 'utf-8'));
    expect(result.detail).toBe(`all ${PROTECTED_CONSTANT_COUNT} protected constants byte-identical`);
    expect(result.holds).toBe(true);
    expect(result.present).toBe(PROTECTED_CONSTANT_COUNT);
  });
});
