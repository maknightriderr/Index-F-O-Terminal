// Dhan engine v2, phase 4: a setup SIGNAL becomes a fresh-start paper candidate (options, paper only), its futures
// plan translated to the paper reference by the current basis; everything else is refused with a named code.
import { describe, expect, it } from 'vitest';
import { dhanPaperCandidate, DHAN_PAPER_MAX_PRICE_AGE_MS, type DhanPaperInput } from '../paper.js';
import { FRESH_PACK_VERSION, FRESH_ENTRY_WINDOW_MS } from '../../fresh-start/strategies.js';
import type { SetupResult } from '../setups.js';

const now = Date.parse('2026-11-09T05:00:05Z');
const signal: SetupResult = {
  setup: 'A', strategy: 'DHAN_A_SWEEP_ABSORPTION', side: 'BULLISH', status: 'SIGNAL', failed: null, checks: [], gates: [],
  plan: { entry: 24100, sl: 24040, target: 24250, targetKind: 'PDH', rr: 2.5 }, score: { total: 8, eligibility: 'PREFERRED', lines: [] },
  noTrade: { tradeable: true, reasons: [], notEvaluated: ['OPTION_SPREAD'] }, evidence: { atr: 40 },
};
const input = (x: Partial<DhanPaperInput> = {}): DhanPaperInput => ({
  symbol: 'NIFTY', result: signal, barTime: now - 905_000, decidedAt: now - 5000, atr: 40, futures: { price: 24110, at: now - 1000 },
  reference: { id: 'NFO:123', sourceEpoch: 'ANGEL-SNAP:1:1', price: 24060, at: now - 500, kind: 'SPOT' }, session: '2026-11-09', sessionClose: Date.parse('2026-11-09T10:00:00Z'), now, ...x,
});

describe('DHAN signal -> paper candidate', () => {
  it('translates the futures plan by the current basis (reference - futures = -50) and tags the strategy', () => {
    const out = dhanPaperCandidate(input());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidate).toMatchObject({
      strategy: 'DHAN_A_SWEEP_ABSORPTION', direction: 'BULLISH', instrument: 'NFO:123', version: FRESH_PACK_VERSION, sourceEpoch: 'ANGEL-SNAP:1:1', session: '2026-11-09',
      referenceEntry: 24050, stop: 23990, target: 24200, atr: 40, exitProfile: 'TARGET', at: now - 5000, origin: now - 5000, expiresAt: now + FRESH_ENTRY_WINDOW_MS,
      parentId: `NFO:123:2026-11-09:BULLISH:${now - 5000}`,
      evidence: { dhan: { setup: 'A', score: 8, translation: { method: 'CONSTANT_BASIS', referenceKind: 'SPOT', shift: -50 }, rrBasis: 'GROSS_UNDERLYING' } },
    });
    expect(out.candidate.id).toBe(`${FRESH_PACK_VERSION}:ANGEL-SNAP:1:1:NFO:123:2026-11-09:BULLISH:${now - 5000}:DHAN_A_SWEEP_ABSORPTION:${now - 905_000}`);
  });
  it('refuses anything but a fresh, consistent SIGNAL', () => {
    const code = (x: Partial<DhanPaperInput>) => { const o = dhanPaperCandidate(input(x)); return o.ok ? 'OK' : o.code; };
    expect(code({ result: { ...signal, status: 'NO_TRADE' } })).toBe('DHAN_NOT_A_SIGNAL');
    expect(code({ futures: { price: 24110, at: now - DHAN_PAPER_MAX_PRICE_AGE_MS - 1 } })).toBe('DHAN_PRICE_STALE');
    expect(code({ reference: { ...input().reference, price: 30000 } })).toBe('DHAN_REFERENCE_MISMATCH');
    expect(code({ atr: 0 })).toBe('DHAN_ATR_UNAVAILABLE');
    expect(code({ result: { ...signal, plan: { ...signal.plan!, sl: 24200 } } })).toBe('DHAN_PLAN_INVALID');
    expect(code({ result: { ...signal, side: 'BEARISH', plan: { entry: 24100, sl: 24160, target: 23950, targetKind: 'PDL', rr: 2.5 } } })).toBe('OK');
  });
});
