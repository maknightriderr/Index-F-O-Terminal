// ============================================================
// DATA-1 (audit 2026-10-18): input freshness is measured on the exchange's clock, not the server's receive time.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAngelExchangeTime, exchangeTimesOf } from '../../providers/angel-one/exchange-time.js';
import { inputTimestampsFrom, signalAgeSeconds, exchangeQuoteAgeSeconds, staleQuoteDiagnostic, parseStaleQuoteMode, STALE_QUOTE_MAX_AGE_S } from '../signal-freshness.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f: string) => readFileSync(path.join(SRC, f), 'utf8');

describe('Angel One exchange time (FULL-mode exchFeedTime / exchTradeTime)', () => {
  it('parses the IST wall-clock text to epoch ms', () => {
    expect(parseAngelExchangeTime('21-Dec-2023 13:47:24')).toBe(Date.UTC(2023, 11, 21, 8, 17, 24));
    expect(parseAngelExchangeTime('16-oct-2026 09:15:00')).toBe(Date.UTC(2026, 9, 16, 3, 45, 0));
    expect(parseAngelExchangeTime(' 1-Jan-2026 00:00:05 ')).toBe(Date.UTC(2025, 11, 31, 18, 30, 5));
  });
  it('anything else is null, never "now"', () => {
    for (const bad of [undefined, null, '', 'now', '2026-10-16T09:15:00Z', '31-Feb-2026 10:00:00', '16-Okt-2026 09:15:00', '16-Oct-2026 25:00:00', '01-Jan-1970 05:30:00', 1792000000000]) {
      expect(parseAngelExchangeTime(bad as unknown)).toBeNull();
    }
  });
  it('a quote item gets the keys only when the broker gave them', () => {
    expect(exchangeTimesOf({ exchFeedTime: '16-Oct-2026 10:00:00', exchTradeTime: '16-Oct-2026 09:59:58' })).toEqual({
      exchangeTimestamp: Date.UTC(2026, 9, 16, 4, 30, 0),
      lastTradeTimestamp: Date.UTC(2026, 9, 16, 4, 29, 58),
    });
    expect(exchangeTimesOf({})).toEqual({});
    expect(exchangeTimesOf(null)).toEqual({});
  });
  it('the provider, the chain leg and the decision record carry them', () => {
    expect(read('providers/angel-one/index.ts')).toMatch(/timestamp: Date\.now\(\),[\s\S]{0,200}\.\.\.exchangeTimesOf\(item\)/);
    expect(read('services/option-chain.ts')).toMatch(/quote\?\.exchangeTimestamp != null \? \{ exchangeTimestamp: quote\.exchangeTimestamp \}/);
    expect(read('services/decision-snapshot.ts')).toMatch(/exchangeTimestamp: ts\.optionExchange, exchangeAgeSeconds: exchangeQuoteAgeSeconds/);
  });
});

describe('ages', () => {
  const DECIDED = Date.UTC(2026, 9, 16, 5, 0, 0);
  const chain = { timestamp: DECIDED - 2_000 };
  const leg = { timestamp: DECIDED - 1_000, exchangeTimestamp: DECIDED - 185_000, lastTradeTimestamp: DECIDED - 400_000 };

  it('the receive-time age is unchanged (rows stay comparable); the exchange age is separate', () => {
    const ts = inputTimestampsFrom(chain, leg);
    expect(ts.optionExchange).toBe(DECIDED - 185_000);
    expect(ts.optionLastTrade).toBe(DECIDED - 400_000);
    expect(signalAgeSeconds(DECIDED, ts)).toBe(2);
    expect(exchangeQuoteAgeSeconds(DECIDED, ts)).toBe(185);
  });
  it('a leg without exchange times adds no keys', () => {
    const ts = inputTimestampsFrom(chain, { timestamp: DECIDED - 1_000 });
    expect('optionExchange' in ts).toBe(false);
    expect(exchangeQuoteAgeSeconds(DECIDED, ts)).toBeNull();
  });
  it('the exchange age is NOT clamped: a negative age is clock skew, and it shows', () => {
    const ts = inputTimestampsFrom(chain, { timestamp: DECIDED, exchangeTimestamp: DECIDED + 8_000 });
    expect(exchangeQuoteAgeSeconds(DECIDED, ts)).toBe(-8);
    expect(staleQuoteDiagnostic(DECIDED, ts).input_values).toMatchObject({ clockSkew: true });
  });
});

describe('STALE_QUOTE (shadow only, pre-registered 120 s)', () => {
  const DECIDED = Date.UTC(2026, 9, 16, 5, 0, 0);
  const ts = (ageS: number | null) => inputTimestampsFrom({ timestamp: DECIDED }, ageS == null ? { timestamp: DECIDED } : { timestamp: DECIDED, exchangeTimestamp: DECIDED - ageS * 1000 });
  it('FAIL beyond the limit, PASS inside it, NOT_EVALUATED without an exchange time; never deciding, never enforced', () => {
    expect(STALE_QUOTE_MAX_AGE_S).toBe(120);
    const fail = staleQuoteDiagnostic(DECIDED, ts(185));
    expect(fail).toMatchObject({ gate: 'STALE_QUOTE', status: 'FAIL', was_deciding_gate: false, threshold: { staleQuoteMaxAgeSeconds: 120 } });
    expect(fail.input_values).toMatchObject({ exchangeAgeSeconds: 185, enforced: false, clockSkew: false });
    expect(fail.reason).toMatch(/NOT changed/);
    expect(staleQuoteDiagnostic(DECIDED, ts(30)).status).toBe('PASS');
    expect(staleQuoteDiagnostic(DECIDED, ts(120)).status).toBe('PASS');
    expect(staleQuoteDiagnostic(DECIDED, ts(null)).status).toBe('NOT_EVALUATED');
  });
  it('mode: SHADOW unless OFF; there is no ENFORCE (a refusal gate needs evidence and approval first)', () => {
    expect(parseStaleQuoteMode(undefined)).toBe('SHADOW');
    expect(parseStaleQuoteMode('off')).toBe('OFF');
    expect(parseStaleQuoteMode('ENFORCE')).toBe('SHADOW');
  });
  it('written on TAKE decisions only, after the snapshot row exists', () => {
    const src = read('services/decision-snapshot.ts');
    expect(src).toMatch(/if \(input\.decision === 'TAKE' && STALE_QUOTE_MODE === 'SHADOW'\) \{\s+await recordGateDiagnostics\(decisionId, \[staleQuoteDiagnostic\(at\.getTime\(\), ts\)\]\);/);
    // No decision path reads it.
    expect(read('services/market-bias.ts')).not.toMatch(/staleQuoteDiagnostic|STALE_QUOTE_MODE/);
  });
});
