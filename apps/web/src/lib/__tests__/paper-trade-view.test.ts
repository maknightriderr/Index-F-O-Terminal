import { describe, expect, it } from 'vitest';
import type { PaperTradeView } from '@fno/shared';
import { DEFAULT_FILTERS, contractLabel, countTrades, distinct, filterTrades } from '../paper-trade-view';

const trade = (over: Partial<PaperTradeView>): PaperTradeView =>
  ({
    id: 't',
    symbol: 'NIFTY',
    exchange: 'NSE',
    mode: 'PAPER',
    structureType: 'NAKED_LONG',
    side: 'CE',
    strike: 22500,
    expiry: '2026-10-20',
    direction: 'BULLISH',
    family: 'S1',
    strategyLabel: 'Structure S1',
    logicVersion: 'v1',
    mintedAt: 1,
    state: 'WIN',
    status: 'CLOSED',
    includedInPerformance: true,
    excludedReason: null,
    cohort: 'POST_B',
    measurementReliable: true,
    entry: 100,
    initialStop: 70,
    currentStop: null,
    target: 160,
    plannedRiskReward: 2,
    exitPrice: 160,
    exitAt: 2,
    closeReason: 'target',
    holdMinutes: 30,
    grossR: 2,
    netR: 1.9,
    returnPercent: 60,
    estimatedCost: { pct: 3, basis: 'ESTIMATED_MODEL', costR: 0.1, record: null },
    live: null,
    ...over,
  }) as PaperTradeView;

const set = [
  trade({ id: 'win', state: 'WIN' }),
  trade({ id: 'loss', state: 'LOSS', grossR: -1, netR: -1.1, symbol: 'BANKNIFTY' }),
  trade({ id: 'exp', state: 'EXPIRED', closeReason: 'session ended' }),
  trade({ id: 'void', state: 'LOSS', status: 'VOIDED', includedInPerformance: false, excludedReason: 'VOIDED', measurementReliable: false, cohort: 'PRE' }),
  trade({ id: 'lost', state: 'EXPIRED', status: 'TRACKING_LOST', includedInPerformance: false, excludedReason: 'TRACKING_LOST', family: null, logicVersion: null }),
  trade({ id: 'open', state: 'OPEN', status: 'OPEN_TRACKED', includedInPerformance: false, excludedReason: 'OPEN', exitPrice: null, grossR: null, netR: null }),
  trade({ id: 'open2', state: 'OPEN', status: 'OPEN_UNTRACKED', includedInPerformance: false, excludedReason: 'OPEN', exitPrice: null, grossR: null, netR: null, exchange: 'MCX', symbol: 'GOLD' }),
];
const ids = (r: PaperTradeView[]) => r.map((t) => t.id);

describe('filterTrades', () => {
  it('shows everything by default, including voided and lost trades', () => {
    expect(filterTrades(set, DEFAULT_FILTERS)).toHaveLength(set.length);
  });
  it('filters by state', () => {
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, state: 'OPEN' }))).toEqual(['open', 'open2']);
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, state: 'CLOSED' }))).toEqual(['win', 'loss', 'exp', 'void', 'lost']);
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, state: 'EXPIRED' }))).toEqual(['exp', 'lost']);
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, state: 'WIN' }))).toEqual(['win']);
  });
  it('separates historical from measurement-reliable', () => {
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, period: 'HISTORICAL' }))).toEqual(['void']);
    expect(filterTrades(set, { ...DEFAULT_FILTERS, period: 'RELIABLE' })).toHaveLength(set.length - 1);
  });
  it('filters by symbol (case-insensitive), exchange, family and version, with UNRECORDED for missing', () => {
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, symbol: 'bank' }))).toEqual(['loss']);
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, exchange: 'MCX' }))).toEqual(['open2']);
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, family: 'UNRECORDED' }))).toEqual(['lost']);
    expect(ids(filterTrades(set, { ...DEFAULT_FILTERS, version: 'UNRECORDED' }))).toEqual(['lost']);
  });
  it('can hide closed trades that do not count, keeping open ones', () => {
    const r = ids(filterTrades(set, { ...DEFAULT_FILTERS, includeExcluded: false }));
    expect(r).toEqual(['win', 'loss', 'exp', 'open', 'open2']);
  });
  it('does not mutate or recompute the records', () => {
    const before = JSON.stringify(set);
    filterTrades(set, { ...DEFAULT_FILTERS, state: 'WIN' });
    countTrades(set);
    expect(JSON.stringify(set)).toBe(before);
  });
});

describe('countTrades', () => {
  it('reports denominators and excluded reasons', () => {
    const c = countTrades(set);
    expect(c).toMatchObject({ shown: 7, open: 2, openTracked: 1, openUntracked: 1, win: 1, loss: 2, expired: 2, includedClosed: 3 });
    expect(c.excluded).toEqual({ VOIDED: 1, TRACKING_LOST: 1 });
  });
  it('handles an empty list', () => {
    expect(countTrades([])).toMatchObject({ shown: 0, open: 0, includedClosed: 0 });
  });
});

describe('helpers', () => {
  it('lists distinct values with UNRECORDED for missing', () => {
    expect(distinct(set, (t) => t.family)).toEqual(['S1', 'UNRECORDED']);
  });
  it('labels a contract', () => {
    expect(contractLabel(trade({}))).toBe('NIFTY 22500 CE · 20 Oct');
    expect(contractLabel(trade({ structureType: 'SPREAD' }))).toBe('NIFTY spread');
  });
});
