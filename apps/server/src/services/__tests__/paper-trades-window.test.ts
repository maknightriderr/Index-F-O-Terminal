// The paper-trades view is a WINDOW of the history. It must say so (recorded / truncated) and must never let an open
// position fall out of view because newer trades pushed it past the limit. Found by the 11 Oct production audit:
// production had 600 trades while the page requested 500 and called the page size the total.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/logger.js', () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../lib/redis.js', () => ({ redis: {}, scanKeys: async () => [] }));
vi.mock('../../lib/db.js', () => ({ sql: Object.assign(async () => [], { json: (v: unknown) => v }) }));
vi.mock('../backtesting.js', () => ({ getTradeSetupHistory: async () => [] }));

const { paperTradesResponse, withOpenBeyondWindow } = await import('../paper-trades.js');

const view = (state: 'OPEN' | 'WIN' | 'LOSS' | 'EXPIRED') => ({ state, status: state === 'OPEN' ? 'OPEN_TRACKED' : 'CLOSED', includedInPerformance: state !== 'OPEN' }) as never;

describe('paperTradesResponse counts', () => {
  it('reports the recorded total and flags a truncated window', () => {
    const r = paperTradesResponse([view('WIN'), view('OPEN')], 600);
    expect(r.counts).toMatchObject({ total: 2, recorded: 600, truncated: true });
  });
  it('is not truncated when every recorded trade is returned', () => {
    expect(paperTradesResponse([view('WIN'), view('LOSS')], 2).counts).toMatchObject({ recorded: 2, truncated: false });
  });
  it('never claims truncation when the total is unknown', () => {
    expect(paperTradesResponse([view('WIN')], null).counts).toMatchObject({ recorded: null, truncated: false });
    expect(paperTradesResponse([view('WIN')]).counts.recorded).toBeNull();
  });
});

describe('withOpenBeyondWindow', () => {
  const rec = (id: string, outcome: string | null) => ({ id, outcome });
  it('adds older open trades and nothing else', () => {
    const window = [rec('n1', 'WIN'), rec('n2', null)];
    const wider = [...window, rec('o1', 'LOSS'), rec('o2', null), rec('o3', 'EXPIRED')];
    expect(withOpenBeyondWindow(window, wider).map((r) => r.id)).toEqual(['n1', 'n2', 'o2']);
  });
  it('does not duplicate a trade already in the window', () => {
    const window = [rec('a', null)];
    expect(withOpenBeyondWindow(window, [rec('a', null)])).toHaveLength(1);
  });
  it('leaves the window unchanged when nothing older is open', () => {
    const window = [rec('a', 'WIN')];
    expect(withOpenBeyondWindow(window, [rec('a', 'WIN'), rec('b', 'LOSS')])).toEqual(window);
  });
});
