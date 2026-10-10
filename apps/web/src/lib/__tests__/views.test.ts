import { describe, expect, it } from 'vitest';
import type { FnoScannerRow } from '@fno/shared';
import { buildChartOverlays, visibleOverlayLines } from '../chart-overlays';
import { DEFAULT_EXPLORER_FILTERS, filterExplorerRows } from '../fno-explorer';
import { displayTally, reliabilityLines, SMALL_SAMPLE_BELOW } from '../measurement-view';
import { MISSING } from '../format';
import type { Tally } from '../use-measurement';

describe('chart overlays', () => {
  it('draws nothing when nothing was recorded, and says why', () => {
    const { lines, groups } = buildChartOverlays({ inputs: {}, structure: null, setupWatch: [] });
    expect(lines).toEqual([]);
    for (const g of groups) {
      expect(g.available).toBe(false);
      expect(g.reason).toMatch(/\S/);
    }
  });
  it('never fabricates order-block or order-flow overlays, whatever the feed status', () => {
    for (const orderFlowStatus of [undefined, 'CONNECTED', 'DATA_PLAN_INACTIVE']) {
      const { lines, groups } = buildChartOverlays({ inputs: { vwap: 100 }, structure: null, setupWatch: [], orderFlowStatus });
      expect(lines.some((l) => l.group === 'ORDER_BLOCK' || l.group === 'ORDER_FLOW')).toBe(false);
      for (const id of ['ORDER_BLOCK', 'ORDER_FLOW']) {
        const g = groups.find((x) => x.group === id)!;
        expect(g.available).toBe(false);
        expect(g.defaultOn).toBe(false);
      }
    }
  });
  it('turns recorded OI walls and VWAP into lines and respects the toggles', () => {
    const { lines, groups } = buildChartOverlays({
      inputs: { vwap: 22500, supportLevels: [{ strike: 22400 }], resistanceLevels: [{ strike: 22600 }, { strike: 'x' }] },
      structure: null,
      setupWatch: [],
    });
    expect(lines.map((l) => l.id).sort()).toEqual(['res0', 'sup0', 'vwap']);
    expect(groups.find((g) => g.group === 'VWAP')!.available).toBe(true);
    expect(visibleOverlayLines(lines, new Set(['VWAP'])).map((l) => l.id)).toEqual(['vwap']);
    expect(visibleOverlayLines(lines, new Set())).toEqual([]);
  });
  it('ignores non-finite and non-positive prices', () => {
    const { lines } = buildChartOverlays({ inputs: { vwap: 0, supportLevels: [{ strike: NaN }] }, structure: null, setupWatch: [] });
    expect(lines).toEqual([]);
  });
});

const row = (over: Partial<FnoScannerRow>): FnoScannerRow => ({ symbol: 'AAA', exchange: 'NSE', direction: 'BULLISH', ivRank: 80, atmSpreadPct: 0.5, oiInterpretation: 'LONG_BUILDUP', ...over }) as FnoScannerRow;

describe('F&O explorer filters', () => {
  const rows = [row({ symbol: 'AAA' }), row({ symbol: 'BBB', direction: 'BEARISH', ivRank: 20, atmSpreadPct: null }), row({ symbol: 'CCC', ivRank: null, atmSpreadPct: 9 })];
  it('applies only the filters each view offers', () => {
    const f = { ...DEFAULT_EXPLORER_FILTERS, liquidOnly: true, ivRank: 'HIGH' as const };
    expect(filterExplorerRows(rows, 'overview', f).map((r) => r.symbol)).toEqual(['AAA']);
    expect(filterExplorerRows(rows, 'iv', f).map((r) => r.symbol)).toEqual(['AAA']);
    expect(filterExplorerRows(rows, 'oi', f)).toHaveLength(3);
  });
  it('missing spread or IV rank is not read as liquid or high', () => {
    expect(filterExplorerRows(rows, 'overview', { ...DEFAULT_EXPLORER_FILTERS, liquidOnly: true }).map((r) => r.symbol)).toEqual(['AAA']);
    expect(filterExplorerRows(rows, 'iv', { ...DEFAULT_EXPLORER_FILTERS, ivRank: 'LOW' }).map((r) => r.symbol)).toEqual(['BBB']);
  });
  it('searches by symbol and bias', () => {
    expect(filterExplorerRows(rows, 'overview', { ...DEFAULT_EXPLORER_FILTERS, query: 'bb' }).map((r) => r.symbol)).toEqual(['BBB']);
    expect(filterExplorerRows(rows, 'overview', { ...DEFAULT_EXPLORER_FILTERS, bias: 'BEARISH' }).map((r) => r.symbol)).toEqual(['BBB']);
  });
});

const tally = (over: Partial<Tally> = {}): Tally =>
  ({
    n: 10,
    wins: 4,
    losses: 5,
    expired: 1,
    winRateClosedOnly: 44.4,
    winRateAllTrades: 40,
    expiredShare: 10,
    baseline: { grossR: 0.1, netR: -0.05, grossRSameTradesAsNet: 0.08, nNet: 8 },
    conservative: { netR: -0.2, nNet: 8 },
    denominators: { winRateClosedOnly: 9, winRateAllTrades: 10, grossR: 10, netR: 8 },
    excluded: { VOIDED: 2, OFF_SESSION: 0 },
    ...over,
  }) as unknown as Tally;

describe('measurement display', () => {
  it('shows every rate with its denominator and the two win rates apart', () => {
    const d = displayTally(tally());
    expect(d.winRateClosed).toBe('44.4% (4 of 9)');
    expect(d.winRateAll).toBe('40.0% (4 of 10)');
    expect(d.grossR).toContain('n=10');
    expect(d.netR).toContain('n=8');
    expect(d.netPopulationDiffers).toBe(true);
    expect(d.excluded).toBe('2 voided');
  });
  it('flags a small sample and never invents a rate without a denominator', () => {
    expect(displayTally(tally()).smallSample).toBe(10 < SMALL_SAMPLE_BELOW);
    const none = displayTally(tally({ n: 0, wins: 0, losses: 0, expired: 0, denominators: { winRateClosedOnly: 0, winRateAllTrades: 0, grossR: 0, netR: 0 } as never, baseline: { grossR: null, netR: null, grossRSameTradesAsNet: null, nNet: 0 } as never }));
    expect(none.winRateClosed).toBe(MISSING);
    expect(none.winRateAll).toBe(MISSING);
    expect(none.netR).toBe(MISSING);
  });
  it('shows average net win, loss and expired impact with their counts, and an em dash from an older deployment', () => {
    const d = displayTally(tally({ netByOutcome: { WIN: { n: 4, meanNetR: 0.8 }, LOSS: { n: 3, meanNetR: -1.1 }, EXPIRED: { n: 1, meanNetR: -0.2 }, expiredContributionToMeanNetR: -0.025 } } as never));
    expect(d.avgNetWin).toBe('+0.80R (n=4)');
    expect(d.avgNetLoss).toBe('-1.10R (n=3)');
    expect(d.expiredNet).toContain('(n=1)');
    expect(d.expiredNet).toContain('-0.03R of the mean');
    const old = displayTally(tally());
    expect([old.avgNetWin, old.avgNetLoss, old.expiredNet]).toEqual([MISSING, MISSING, MISSING]);
    const none = displayTally(tally({ netByOutcome: { WIN: { n: 0, meanNetR: null }, LOSS: { n: 0, meanNetR: null }, EXPIRED: { n: 0, meanNetR: null }, expiredContributionToMeanNetR: null } } as never));
    expect(none.avgNetWin).toBe(MISSING);
  });
  it('reads the cutoff from the server, with no hardcoded date, and says when coverage is not measurable', () => {
    expect(reliabilityLines(undefined)).toEqual([]);
    const lines = reliabilityLines({ measurementsReliableFrom: '2026-12-01T00:00:00+05:30', tradesSinceReliable: 0, withCostRecord: 0, costRecordCoveragePct: null });
    expect(lines[0][1]).toMatch(/2026/);
    expect(lines[3][1]).toMatch(/not yet measurable/);
    expect(reliabilityLines({})[0][1]).toBe(MISSING);
  });
});
