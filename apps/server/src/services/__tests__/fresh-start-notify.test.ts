import { describe, it, expect } from 'vitest';
import type { FreshPaperPosition } from '@fno/analytics';
import { formatFreshTradeNotice } from '../fresh-start/notify.js';

const at = Date.UTC(2026, 10, 2, 4, 5); // 09:35 IST
const position = (o: Partial<FreshPaperPosition> = {}): FreshPaperPosition => ({
  id: 'p1', sessionCutoff: at + 3600000, quantity: 2, entry: 142.35, originalRiskCurrency: 1250, emergencyStop: 106.75, currentStop: 106.75, highBid: 142, openedAt: at, lastEventAt: at,
  state: 'OPEN', exitTriggeredAt: null, exitReason: null, exitPrice: null, netPnl: null, maxUnderlyingFavorable: 0,
  candidate: { id: 'p1', parentId: 'x', version: 'NEW-INTRADAY-1.4', strategy: 'NEW_ORB_RETEST_V1', direction: 'BULLISH', instrument: 'NSE_FO:1', sourceEpoch: 'e', session: '2026-11-02', at, referenceEntry: 24806, stop: 24774, target: 24862, atr: 20, expiresAt: at + 2000, origin: at, evidence: {} },
  contract: { id: 'NSE_FO:2', sourceEpoch: 'e', source: 'ANGEL', lotQuantity: 2, multiplier: 75, expiryTradableSessions: 3, market: 'NSE_INDEX_OPTIONS', delta: .5, metadataVerified: true, modelVerified: true, feesVerified: true, targetPremiumScenarios: [], invalidationPremiumScenarios: [], explicitRoundTripCostPerUnit: 0, evidence: { underlying: 'NIFTY', strike: 24850, side: 'CE', expiry: '2026-11-04' } },
  ...o,
}) as FreshPaperPosition;

describe('fresh-start Telegram trade notice text', () => {
  it('entry names the contract, ask fill, size, 1R and stops, and says no broker order is placed', () => {
    const t = formatFreshTradeNotice({ kind: 'ENTRY', position: position() });
    expect(t).toContain('NEW PAPER TRADE');
    expect(t).toContain('NIFTY 24850 CE · exp 2026-11-04');
    expect(t).toContain('ORB retest · bullish (CE) · NEW-INTRADAY-1.4');
    expect(t).toContain('Entry 142.35 (ask fill) × 2 lot(s) = 150 units at 09:35 IST');
    expect(t).toContain('Initial risk ₹1,250 (1R) · premium stop 106.75');
    expect(t).toContain('no broker order is placed');
  });
  it('exit shows the bid fill, reason and net R with sign; a loss is red', () => {
    const t = formatFreshTradeNotice({ kind: 'EXIT', position: position({ state: 'CLOSED', exitPrice: 120.1, exitReason: 'PREMIUM_STOP+THIN_BOOK_HAIRCUT', netPnl: -1875 }) });
    expect(t).toMatch(/^🔴 <b>PAPER TRADE CLOSED<\/b>/);
    expect(t).toContain('Exit 120.10 (bid fill) · reason PREMIUM_STOP+THIN_BOOK_HAIRCUT');
    expect(t).toContain('Net P&amp;L −₹1,875 (−1.50R)');
    const win = formatFreshTradeNotice({ kind: 'EXIT', position: position({ state: 'CLOSED', exitPrice: 170, exitReason: 'UNDERLYING_TARGET', netPnl: 2500 }) });
    expect(win).toMatch(/^✅/);
    expect(win).toContain('+₹2,500 (+2.00R)');
  });
  it('escapes HTML from stored text', () => {
    const t = formatFreshTradeNotice({ kind: 'EXIT', position: position({ state: 'CLOSED', exitPrice: 1, exitReason: '<b>x</b>', netPnl: 0 }) });
    expect(t).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
