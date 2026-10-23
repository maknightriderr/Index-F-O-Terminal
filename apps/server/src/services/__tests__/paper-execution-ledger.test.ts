import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/db.js', () => ({ sql: {} }));
vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: () => false }));

const L = await import('../paper-execution-ledger.js');
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f: string) => readFileSync(path.join(SERVER, f), 'utf8');

const T0 = Date.UTC(2026, 9, 26, 5, 0);
const quote = (o: Partial<import('../paper-execution-ledger.js').QuoteObservation> = {}) => ({
  source: 'CHAIN' as const, token: '43210', ltp: 100, bid: 99.5, ask: 100.5, bidQty: 1500, askQty: 1500, underlying: 24500,
  exchangeAt: T0 - 2_000, lastTradeAt: T0 - 3_000, receivedAt: T0, feedState: null, ...o,
});

describe('paper execution ledger: simulated quote-based prices are estimates, never invented', () => {
  it('entry buys at the ask; a market exit sells at the bid', () => {
    expect(L.simulateFill(quote(), 'ENTRY', 'ENTRY_MARKETABLE', null, 75)).toEqual({ price: 100.5, basis: 'ASK', quality: 'OK' });
    expect(L.simulateFill(quote(), 'EXIT', 'STOP_MARKET', 140, 75)).toEqual({ price: 99.5, basis: 'BID', quality: 'OK' });
    expect(L.simulateFill(quote(), 'EXIT', 'MARKET_EXIT', 140, 75)).toEqual({ price: 99.5, basis: 'BID', quality: 'OK' });
  });

  it('a target fills only when the BID reached it: an LTP touch alone is not executable', () => {
    expect(L.simulateFill(quote({ ltp: 120, bid: 119.4, ask: 120.6 }), 'EXIT', 'LIMIT_TARGET', 120, 75)).toEqual({ price: null, basis: 'NONE', quality: 'LIMIT_NOT_EXECUTABLE' });
    expect(L.simulateFill(quote({ ltp: 121, bid: 120.2, ask: 121 }), 'EXIT', 'LIMIT_TARGET', 120, 75)).toEqual({ price: 120, basis: 'TARGET_LIMIT_BID_REACHED', quality: 'OK' });
  });

  it('missing, one-sided or stale quotes give no price, only their quality', () => {
    expect(L.simulateFill(quote({ bid: null, ask: null }), 'EXIT', 'MARKET_EXIT', null, 75).quality).toBe('NO_QUOTE');
    expect(L.simulateFill(quote({ bid: null }), 'EXIT', 'MARKET_EXIT', null, 75)).toEqual({ price: null, basis: 'NONE', quality: 'ONE_SIDED' });
    expect(L.simulateFill(quote({ exchangeAt: T0 - 120_000 }), 'ENTRY', 'ENTRY_MARKETABLE', null, 75)).toEqual({ price: null, basis: 'NONE', quality: 'STALE' });
    expect(L.simulateFill(quote({ source: 'TICK', feedState: 'DATA_GAP' }), 'EXIT', 'STOP_MARKET', null, 75).quality).toBe('STALE');
  });

  it('size and age that cannot be verified are labelled, not assumed', () => {
    expect(L.simulateFill(quote({ askQty: 50 }), 'ENTRY', 'ENTRY_MARKETABLE', null, 75)).toEqual({ price: 100.5, basis: 'ASK', quality: 'SIZE_INSUFFICIENT' });
    expect(L.simulateFill(quote({ bidQty: null }), 'EXIT', 'STOP_MARKET', null, 75).quality).toBe('SIZE_UNKNOWN');
    expect(L.simulateFill(quote({ exchangeAt: null }), 'EXIT', 'STOP_MARKET', null, null).quality).toBe('AGE_UNKNOWN');
  });

  it('the record keeps the observed quote, the official price and policy, and the estimate apart', () => {
    const trade = { signalId: 'sig-1', symbol: 'TCS', exchange: 'NSE' as const, mode: 'INTRADAY' as const, entry: 100, initialStop: 70, currentStop: 100, target: 120, quantity: 175, lotSize: 175, riskBudgetInr: 5250, capitalInr: 500000 };
    const r = L.ledgerRecord({ event: 'EXIT', trade, quote: quote({ ltp: 121, bid: 119, ask: 121.5 }), closeReason: 'TARGET', assignedFill: 120 });
    expect(r).toMatchObject({
      event: 'EXIT', orderType: 'LIMIT_TARGET', assignedFill: 120, fillPolicy: 'TARGET_LIMIT_MIN_LTP_TARGET', fillPolicyVersion: 'FILL-1.0',
      ltp: 121, bid: 119, ask: 121.5, simFill: null, simQuality: 'LIMIT_NOT_EXECUTABLE', originalStop: 70, currentStop: 100, target: 120,
      paperQuantity: 175, quoteAgeMs: 2000, ledgerVersion: 'LEDGER-1.0',
    });
    expect(L.officialFillPolicy('ENTRY', 'ENTRY_MARKETABLE')).toBe('MID_AT_DECISION');
    expect(L.orderTypeOf('TRAILING_STOP')).toBe('STOP_MARKET');
    expect(L.orderTypeOf('SESSION_ENDED')).toBe('MARKET_EXIT');
  });

  it('a chain leg of another expiry is not this contract: no prices', () => {
    const chain: any = { expiry: '2026-10-27', spotPrice: 24500, strikes: [{ strike: 24500, call: { token: '1', ltp: 100, bid: 99, ask: 101, timestamp: T0 } }] };
    expect(L.observeChainLeg(chain, 24500, 'CE', '2026-10-27', T0)).toMatchObject({ token: '1', bid: 99, ask: 101, underlying: 24500 });
    expect(L.observeChainLeg(chain, 24500, 'CE', '2026-11-24', T0)).toMatchObject({ token: null, bid: null, ask: null, ltp: null });
  });
});

describe('MARK rows: at most one a minute per open trade', () => {
  beforeEach(() => L.resetLedgerThrottle());
  it('throttles by the quote receipt time', () => {
    const trade = { signalId: 'sig-2', symbol: 'NIFTY', exchange: 'NSE' as const, mode: 'INTRADAY' as const, entry: null, initialStop: null, currentStop: 80, target: 140, quantity: null, lotSize: null, riskBudgetInr: null, capitalInr: null };
    expect(L.recordMark(trade, quote({ receivedAt: T0 }))).toBe(true);
    expect(L.recordMark(trade, quote({ receivedAt: T0 + 30_000 }))).toBe(false);
    expect(L.recordMark(trade, quote({ receivedAt: T0 + 60_000 }))).toBe(true);
  });
});

describe('wiring: the official paper prices are untouched; the ledger only observes', () => {
  const mb = read('src/services/market-bias.ts');
  it('every exit passes its observed quote; the recorded exit value is still the official one', () => {
    expect(mb).toMatch(/recordLedger\(\{ event: 'EXIT', trade: lt, quote: close\.quote, closeReason: close\.reason, assignedFill: exitValue \}\)/);
    expect((mb.match(/quote: storedLegQuote\(/g) ?? []).length).toBe(6);
    expect(mb).toMatch(/quote: observedTick && observedLtp != null && observedTick\.ltp === observedLtp \? observedTick : storedLegQuote\(pricingChain, stored\)/);
    expect(mb).toMatch(/return Math\.min\(currentValue, stored\.target\);/); // FILL-1.0 target policy unchanged
  });
  it('the entry quote is recorded beside the official mid entry', () => {
    expect(mb).toMatch(/recordLedger\(\{ event: 'ENTRY', trade: lt, quote: observeChainLeg\(chain, fresh\.strike/);
  });
  it('the monitor marks from ticks it already receives (no new polling) and passes the firing tick on', () => {
    const mon = read('src/services/trade-setup-monitor.ts');
    expect(mon).toMatch(/recordMark\(/);
    expect(mon).toMatch(/checkLockedSetupPriceLevels\(provider, watch\.exchange, watch\.underlying, watch\.mode, tick\.ltp, observeTick\(tick, state \?\? null\)\)/);
  });
  it('the migration is ensured at boot', () => {
    expect(read('src/services/ensure-capture-schema.ts')).toMatch(/'044_paper_execution_ledger\.sql'/);
    expect(read('../../database/init/044_paper_execution_ledger.sql')).toMatch(/CREATE TABLE IF NOT EXISTS paper_execution_observations/);
  });
  it('an ARBITRATION row keeps its refusal text (the 9 Oct OB1 ENGINE_ERRORs lost theirs)', () => {
    expect(mb).toMatch(/slotArbitration: \{[\s\S]{0,400}reason: r\.reason \?\? null,/);
  });
});
