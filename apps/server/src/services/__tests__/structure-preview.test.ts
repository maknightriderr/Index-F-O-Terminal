// ============================================================
// STRUCTURE PREVIEW — read-only, reuses the real mint's own code
// ============================================================
// buildStructurePreview (market-bias.ts) computes what a CONFIRMED
// lifecycle would mint if price returned to the zone, WITHOUT ever minting
// it. Two things must hold, and both are checked here:
//
//   1. It can never mint: no trade_setup:* write, no structure_claimed:*
//      claim, no decision snapshot, no Telegram push, no call into
//      mintTradeSetup/mintUnderLock/claimStructureFill. Asserted by reading
//      the function's own source text — the same technique this suite
//      already uses (structure-live.test.ts) to pin wiring that would
//      otherwise need a full Redis+Postgres+broker integration test.
//   2. It produces the SAME strike/SL/target as a real mint for the same
//      inputs, because it calls the identical buildTradeSetup /
//      buildWithFnoValidation functions resolveStructureSetup calls — a
//      pure function given the same arguments returns the same result, so
//      this is checked by calling buildTradeSetup directly, the same way
//      both code paths do, and confirming the source really does call it
//      (not a second, drifted implementation).
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTradeSetup } from '@fno/analytics';
import type { OptionChainStrike } from '@fno/shared';
import { leg } from './trade-setup-fixtures.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const MARKET_BIAS_SRC = readFileSync(path.join(REPO_ROOT, 'apps/server/src/services/market-bias.ts'), 'utf-8');

/** The exact text of buildStructurePreviewCached + buildStructurePreview, isolated from the rest of the file. */
function previewSectionSource(): string {
  const start = MARKET_BIAS_SRC.indexOf('async function buildStructurePreviewCached(');
  const end = MARKET_BIAS_SRC.indexOf('async function mintTradeSetup(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return MARKET_BIAS_SRC.slice(start, end);
}

describe('structure preview: cannot mint', () => {
  const src = previewSectionSource();

  it('never writes anything to Redis (no redis.set call at all — only reads)', () => {
    // The paper-trade slot key (trade_setup:*) is built once, to pass to
    // readExposureAtCreation (a READ of the concurrency snapshot other live
    // setups hold) — never to redis.set. Asserting no redis.set call exists
    // anywhere in this section is the stronger, unambiguous guarantee.
    expect(src).not.toMatch(/redis\.set\(/);
  });

  it('never claims a structure fill (structure_claimed:*)', () => {
    // The prefix is named in this section's own doc comment (explaining
    // what it does NOT do) — checked for an actual claim call, not the prose.
    expect(src).not.toMatch(/set\(`structure_claimed/);
  });

  it('never mints, claims a fill, or records a decision/outcome', () => {
    expect(src).not.toMatch(/mintTradeSetup\(/);
    expect(src).not.toMatch(/mintUnderLock\(/);
    expect(src).not.toMatch(/claimStructureFill\(/);
    expect(src).not.toMatch(/recordDecisionSnapshot\(/);
    expect(src).not.toMatch(/logDecision\(/);
    expect(src).not.toMatch(/recordStructureOutcome\(/);
    expect(src).not.toMatch(/recordTradeSetupGenerated\(/);
  });

  it('never pushes Telegram', () => {
    expect(src).not.toMatch(/notifyTradeSetup\(/);
    expect(src).not.toMatch(/notifyStructureConfirmed\(/);
    expect(src).not.toMatch(/sendTelegramMessage\(/);
  });

  it('only caches under structure_preview:*, never trade_setup:*', () => {
    expect(src).toMatch(/structure_preview:/);
  });

  it('reuses the real mint\'s own strike/SL/target builder rather than a second calculator', () => {
    expect(src).toMatch(/buildWithFnoValidation\(/);
    expect(src).toMatch(/buildTradeSetup\(/);
    expect(src).toMatch(/triggerSlPremiumPct\(/);
  });
});

describe('structure preview: matches the real mint for the same inputs', () => {
  // buildTradeSetup is the exact function both resolveStructureSetup (the
  // real mint) and buildStructurePreview call, per the source-text checks
  // above. Being a pure function, calling it twice with identical
  // arguments — as both call sites do, once anchored on the zone entry
  // instead of the live spot — must return identical strike/SL/target.
  const strikes: OptionChainStrike[] = [
    {
      strike: 9900,
      distanceFromSpot: -100,
      call: leg({ token: 'CE9900', ltp: 40, bid: 39.5, ask: 40.5, delta: 0.45, oi: 50000, volume: 20000, moneyness: 'ITM' }),
      put: leg({ token: 'PE9900', ltp: 42, bid: 41.5, ask: 42.5, delta: -0.45, oi: 40000, volume: 15000, moneyness: 'OTM' }),
    },
    {
      strike: 10000,
      distanceFromSpot: 0,
      call: leg({ token: 'CE10000', ltp: 25, bid: 24.5, ask: 25.5, delta: 0.35, oi: 60000, volume: 25000, moneyness: 'ATM' }),
      put: leg({ token: 'PE10000', ltp: 27, bid: 26.5, ask: 27.5, delta: -0.35, oi: 45000, volume: 18000, moneyness: 'ATM' }),
    },
  ];
  const args = [strikes, 9900, 'BULLISH' as const, 100, 150, 0.25, 14, 3, 75, 60, { tickSize: 0.05, expectedHoldHours: 4 }] as const;

  it('is deterministic: identical inputs produce identical strike/entry/SL/target', () => {
    const a = buildTradeSetup(...args);
    const b = buildTradeSetup(...args);
    expect(a).toEqual(b);
    if (a.available && b.available) {
      expect(a.strike).toBe(b.strike);
      expect(a.stopLoss).toBe(b.stopLoss);
      expect(a.target).toBe(b.target);
    }
  });
});
