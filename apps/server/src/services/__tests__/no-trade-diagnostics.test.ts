// ============================================================
// NO TRADE DIAGNOSTICS — every NO TRADE shows the candidates evaluated, the
// rejection reason of each, the best rejected candidate and the limiting
// factor / missing confirmation.
// ============================================================

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TradeSetup } from '@fno/shared';

vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

const { settleSlot } = await import('../slot-arbitration.js');
const { buildNoTradeDiagnostics, engineSummaries, noTradeStage } = await import('../no-trade-diagnostics.js');

const slot = (source: string, over: Record<string, unknown> = {}) =>
  ({ source, candidateId: `id-${source}`, direction: 'BULLISH', parentId: `P-${source}`, anchorKeys: [`P-${source}`], timingClass: 'ACCEPTABLE', movePotential: 'NORMAL', moveConsumedPct: 0.2, objectiveDistanceAtr: 2, netRR: 1.2, entryQuality: 0.6, evidence: 1, decisionTime: 1000, confirmations: 1, confirmationDetail: { liquiditySweep: true, displacement: false, structureZone: false, optionChain: false }, ...over }) as any;
const built = (sl: any) => ({ kind: 'DEFERRED' as const, setup: { available: true, reason: sl.source } as TradeSetup, slot: sl, commit: async () => ({ setup: { available: true, reason: 'm' } as TradeSetup, minted: true }), decline: async () => undefined });

async function recordsOf(entries: any[], preMint?: any) {
  let records: any[] = [];
  const out = await settleSlot({ underlying: 'NIFTY', exchange: 'NSE', entries, preMint, record: (r) => (records = r) });
  return { out, records };
}

const ENGINES = {
  structure: { enabled: true, lifecycles: [{ stage: 'CONFIRMED', direction: 'BULLISH' }], fillClaimed: false },
  families: { paperCandidates: 3, triggerFailures: 1, evaluated: true },
  indicator: { direction: 'BULLISH', code: 'COST_TOO_HIGH', reason: 'cost 7% of premium' },
};

describe('NO TRADE diagnostics', () => {
  it('lists every candidate evaluated with its rejection reason; names the best rejected and the limiting factor', async () => {
    const { out, records } = await recordsOf(
      [
        built(slot('A2', { timingClass: 'OPTIMAL' })),
        { kind: 'REFUSED', slot: slot('B1'), code: 'WIDE_SPREAD', reason: 'spread 9% of mid', optionBuild: true },
        { kind: 'REFUSED', slot: slot('S1', { timingClass: 'LATE' }), code: 'COST_TOO_HIGH', reason: 'cost 7% of premium', optionBuild: true },
        { kind: 'REFUSED', slot: slot('INDICATOR'), code: 'POST_LOSS_COOLDOWN', reason: 'cooling down', optionBuild: false },
      ],
      () => ({ code: 'STALE_QUOTE', reason: 'chain 200 s old' })
    );
    expect(out).toBeNull();
    const d = buildNoTradeDiagnostics(records, ENGINES);
    expect(d.candidatesEvaluated).toBe(4);
    expect(d.candidates.map((c) => [c.source, c.code])).toEqual(expect.arrayContaining([['A2', 'STALE_QUOTE'], ['B1', 'WIDE_SPREAD'], ['S1', 'COST_TOO_HIGH'], ['INDICATOR', 'POST_LOSS_COOLDOWN']]));
    for (const c of d.candidates) expect(c.reason).toBeTruthy();
    // Best rejected = rank 1 on the pre-build criteria (A2: OPTIMAL timing).
    expect(d.bestRejected).toMatchObject({ source: 'A2', preBuildRank: 1, stage: 'DATA_QUALITY', code: 'STALE_QUOTE' });
    // Limiting factor: the most common failure stage (two option-leg refusals).
    expect(d.limitingFactor).toMatchObject({ stage: 'OPTION_COST_LIQUIDITY' });
    expect(d.limitingFactor.summary).toMatch(/2 of 4 candidate\(s\) failed on the option leg/);
    // Missing: what the best rejected candidate needed, and its unconfirmed evidence.
    expect(d.missingConfirmation).toMatch(/a fresh option quote/);
    expect(d.missingConfirmation).toMatch(/Unconfirmed: a displacement, an FVG \/ zone \/ structure shift, option-chain positioning/);
    expect(d.engines.structure).toMatch(/1 confirmed setup\(s\) waiting/);
    expect(d.engines.families).toMatch(/3 paper-stage candidate\(s\).*1 trigger\(s\) failed/);
  });

  it('with no candidate at all it says what no engine produced, and what was missing', () => {
    const d = buildNoTradeDiagnostics([], {
      structure: { enabled: true, lifecycles: [{ stage: 'WATCH', direction: 'BEARISH' }], fillClaimed: false },
      families: { paperCandidates: 0, triggerFailures: 0, evaluated: true },
      indicator: { direction: 'NEUTRAL', code: 'NEUTRAL_BIAS', reason: 'neutral' },
    });
    expect(d).toMatchObject({ candidatesEvaluated: 0, candidates: [], bestRejected: null, limitingFactor: { code: 'NO_CANDIDATE' } });
    expect(d.missingConfirmation).toMatch(/directional consensus/);
    expect(d.engines).toEqual({
      structure: 'Watching a pool — no sweep yet.',
      families: '0 paper-stage candidate(s) on the newest closed bar.',
      indicator: 'Bias is neutral — no directional consensus (supporting evidence only).',
    });
    expect(buildNoTradeDiagnostics([], ENGINES).missingConfirmation).toMatch(/Price returning to a confirmed zone/);
  });

  it('maps every refusal to a stage', () => {
    expect(noTradeStage('WIDE_SPREAD', null)).toBe('OPTION_COST_LIQUIDITY');
    expect(noTradeStage(null, 'cost')).toBe('OPTION_COST_LIQUIDITY');
    expect(noTradeStage('UNREALISTIC_TARGET', null)).toBe('OPTION_COST_LIQUIDITY');
    expect(noTradeStage('STALE_QUOTE', null)).toBe('DATA_QUALITY');
    // A mint that threw is an engine / persistence failure (it was mislabelled DATA_QUALITY before 2026-10-05's forward-validation round).
    expect(noTradeStage('MINT_FAILED', null)).toBe('ENGINE_ERROR');
    expect(noTradeStage('STRUCTURE_SEQUENCE', null)).toBe('SEQUENCE');
    expect(noTradeStage('POST_LOSS_COOLDOWN', null)).toBe('SAFETY_GATE');
    expect(noTradeStage('PARENT_ALREADY_TRADED', null)).toBe('PARENT_ALREADY_TRADED');
    expect(noTradeStage('ENGINE_ERROR', null)).toBe('ENGINE_ERROR');
    expect(engineSummaries({ structure: null, families: null, indicator: null })).toEqual({
      structure: 'Structure engine off.',
      families: expect.stringMatching(/not evaluated/),
      indicator: 'Indicator engine did not run.',
    });
  });

  it('the signal engine returns its NO TRADE through the diagnostics (both exits)', () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../market-bias.ts'), 'utf8');
    // Both exits return through noTrade(...) (each also records its slot decision first — slot-decisions.ts).
    expect(src).toMatch(/if \(entries\.length === 0\) \{\s*const none = noTrade\(/);
    expect(src).toMatch(/if \(minted\) \{[\s\S]*?return minted;\s*\}\s*const none = noTrade\([\s\S]*?return none;/);
    expect(src).not.toMatch(/return minted \?\? indicatorSetup/);
  });
});
