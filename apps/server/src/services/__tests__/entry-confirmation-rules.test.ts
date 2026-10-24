import { describe, expect, it } from 'vitest';
import { ENTRY_CONFIRMATION_VERSION as version, entryRuleCode, entryCandidateRule, type EntryEvidence } from '../entry-confirmation-rules.js';
import { ARMS, armEntryDecision, armFor, openPosition, onQuote, type ExpCandidate } from '../experiment-arms.js';

const t = Date.parse('2026-10-26T10:00:00+05:30');
const ob = (direction: 'BULLISH' | 'BEARISH', close: number): EntryEvidence => ({ version, source: 'OB1', sourceVersion: 'OB-2.0', decisionTime: t - 900_000, direction, blockTop: 101, blockBottom: 94, close });
const of = (found: string[], direction: 'BULLISH' | 'BEARISH' = 'BULLISH'): EntryEvidence => ({ version, source: 'OF1', sourceVersion: 'OF1-1.2', decisionTime: t - 900_000, direction, found, alignment: 'ALIGNED', flowBasis: 'INFERRED' });
const candidate = (direction: 'BULLISH' | 'BEARISH', entryEvidence: EntryEvidence): ExpCandidate => ({ at: t, candidateId: 'x', symbol: 'NIFTY', exchange: 'NSE', mode: 'INTRADAY', direction, confidence: 80, side: direction === 'BULLISH' ? 'CE' : 'PE', strike: 24000, expiry: '2026-10-27', token: 'token', lotSize: 50, entry: 100, stop: 80, target: 140, costPct: 2, statutoryPct: .2, brokeragePerLotInr: 40, minutesSinceOpen: 45, behindLevel: 94, atr: 10, decisionTime: t - 900_000, triggerId: entryEvidence.source, entryEvidence, quote: { ltp: 100, bid: 99, ask: 101, bidQty: 500, askQty: 500, exchangeAt: t, receivedAt: t, feedState: null, source: 'CHAIN' } });

describe('same-bar OB rejection hypothesis, not a replacement entry', () => {
  it.each([
    ['BULLISH', 100, false], ['BULLISH', 101, false], ['BULLISH', 101.05, true],
    ['BEARISH', 95, false], ['BEARISH', 94, false], ['BEARISH', 93.95, true],
  ] as const)('%s close=%s confirms=%s', (direction, close, pass) => {
    const e = ob(direction, close), before = JSON.stringify(e);
    expect(entryRuleCode('OB1C', e)).toBeNull();
    expect(entryRuleCode('OB1J', e)).toBe(pass ? null : 'OB_REJECTION_NOT_CONFIRMED');
    expect(JSON.stringify(e)).toBe(before);
  });
  it.each([NaN, Infinity, -1, 0])('refuses invalid price %s', (price) => {
    expect(entryRuleCode('OB1J', ob('BULLISH', price))).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
  });
  it('refuses missing, reversed and zero-width block evidence', () => {
    expect(entryRuleCode('OB1J')).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
    expect(entryRuleCode('OB1J', { ...ob('BULLISH', 103), blockBottom: 101 } as EntryEvidence)).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
    expect(entryRuleCode('OB1J', { ...ob('BULLISH', 103), blockBottom: 102 } as EntryEvidence)).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
  });
});
describe('OF evidence diversity (not independence)', () => {
  it.each([
    [['DELTA', 'IMBALANCE'], false], [['ABSORPTION', 'ACCEPTANCE'], false],
    [['DELTA', 'ABSORPTION'], true], [['IMBALANCE', 'ACCEPTANCE'], true], [['DELTA', 'POC_UP'], true],
  ] as Array<[string[], boolean]>)('%j group rule=%s', (found, pass) => {
    expect(entryRuleCode('OF1C', of(found))).toBeNull();
    expect(entryRuleCode('OF1G', of(found))).toBe(pass ? null : 'OF_FLOW_GROUP_MISSING');
  });
  it('mirrors bearish POC and refuses opposite-direction evidence', () => {
    expect(entryRuleCode('OF1G', of(['DELTA', 'POC_DOWN'], 'BEARISH'))).toBeNull();
    expect(entryRuleCode('OF1G', of(['DELTA', 'POC_UP'], 'BEARISH'))).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
  });
  it('does not invent confirmations or upgrade missing/stale-version alignment', () => {
    for (const patch of [{ found: ['DELTA', 'DELTA'] }, { sourceVersion: 'OF1-1.1' }, { alignment: 'UNAVAILABLE' }, { found: ['DELTA', 'UNKNOWN'] }, { decisionTime: NaN }]) {
      expect(entryRuleCode('OF1G', { ...of(['DELTA', 'ACCEPTANCE']), ...patch } as any)).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
    }
  });
});
describe('identical option pricing, exits, costs and sizes when the entry filter passes', () => {
  it.each(['BULLISH', 'BEARISH'] as const)('%s / CE-PE: one lot; independently computed official and simulated net R', (direction) => {
    const c = candidate(direction, ob(direction, direction === 'BULLISH' ? 102 : 93));
    const before = structuredClone(c);
    const ps = ['OB1C', 'OB1J'].map((id) => {
      const arm = ARMS.find((a) => a.id === id)!;
      expect(armEntryDecision(arm, c, false, [], t, '2026-10-26').take).toBe(true);
      return openPosition(arm, c, id, t);
    });
    for (const p of ps) {
      expect(p.quantity).toBe(50);
      onQuote(p, { ...c.quote, ltp: 145, bid: 144, ask: 146, exchangeAt: t + 1000, receivedAt: t + 1000 }, t + 1000);
      // Official: (140 - 100 - 2) / 20 = 1.9R.
      expect(p.official.netR).toBeCloseTo(1.9);
      // Sim target limit 140, ask entry 101, fees 0.2 + 40/50 = 1: (140 - 101 - 1)/20 = 1.9.
      expect(p.sim.netR).toBeCloseTo(1.9);
    }
    expect(ps[0].official).toEqual(ps[1].official);
    expect(ps[0].sim).toEqual(ps[1].sim);
    expect(c).toEqual(before);
  });
  it('keeps every historical arm reader and exit rules; new arms differ only by entry filter', () => {
    expect(armFor('OF1R', 'OF1-R0-1.0')).not.toBeNull();
    expect(armFor('OF1R', 'OF1-R0-1.1')).not.toBeNull();
    for (const id of ['OB1C', 'OB1J', 'OF1C', 'OF1G']) {
      expect(armFor(id, `${id}-ENTRY-1.0`)).toMatchObject({ invalidationExit: false, biasReversalExit: false, structureExit: true, triggerReversalExit: true, exploratory: true });
    }
  });
});

it('refuses future/unclosed, source-mismatched and direction-mismatched candidate evidence', () => {
  const c = candidate('BULLISH', ob('BULLISH', 102));
  for (const patch of [{ at: t - 1 }, { direction: 'BEARISH' }, { triggerId: 'OF1' }, { decisionTime: t }]) expect(entryCandidateRule('OB1J', { ...c, ...patch })).toBe('ENTRY_EVIDENCE_UNAVAILABLE');
});
