import type { FreshPaperPosition } from '@fno/analytics';
import { sendTelegramMessage } from '../../lib/telegram.js';
import { logger } from '../../lib/logger.js';

/** A durable fresh-start paper transition (sent only after its transaction commits). */
export type FreshTradeNotice = { kind: 'ENTRY' | 'EXIT'; position: FreshPaperPosition };
export type FreshTradeNotifier = (notice: FreshTradeNotice) => void;

const STRATEGY: Record<string, string> = {
  NEW_ORB_RETEST_V1: 'ORB retest',
  NEW_VWAP_PULLBACK_V1: 'VWAP pullback',
  NEW_PREVIOUS_SESSION_SWEEP_V1: 'PDH/PDL sweep reversal',
  NEW_FIRST_OPENING_PULLBACK_V1: 'First opening pullback',
  NEW_MOMENTUM_BREAKOUT_V1: 'Momentum breakout',
  NEW_TREND_FLAG_V1: 'Trend flag',
  NEW_EVENT_BREAKOUT_V1: 'Event breakout',
  NEW_RS_STOCK_V1: 'Stock in play (relative strength)',
  NEW_INDEX_BREADTH_V1: 'Index breadth trend',
  NEW_MCX_FLOW_V1: 'MCX order flow',
  DHAN_A_SWEEP_ABSORPTION: 'Dhan A: sweep + absorption',
  DHAN_B_IMBALANCE_BREAKOUT: 'Dhan B: imbalance breakout',
  DHAN_C_FAILED_AUCTION_CVD: 'Dhan C: failed auction + CVD',
  DHAN_D_VWAP_PROFILE_REJECTION: 'Dhan D: VWAP / profile rejection',
  DHAN_E_ORDER_FLOW: 'Dhan E: pure order flow (absorption / distribution)',
  DHAN_EXPIRY_GAMMA: 'Dhan expiry gamma',
};
/** Live account limits a paper entry went past (2.0: paper records them instead of refusing). */
const RISK_FLAG: Record<string, string> = {
  WOULD_PAUSE_3_LOSSES: '3 losses in a row',
  WOULD_PAUSE_DAILY_LOSS: 'daily loss limit (1%) reached',
  WOULD_PAUSE_COHORT: 'cumulative drawdown limit (5%) reached',
  WOULD_BLOCK_MAX_OPEN: 'more than 2 positions open',
  WOULD_BLOCK_OPEN_RISK: 'open-risk / daily budget exceeded',
  WOULD_BLOCK_CORRELATED: 'another position open in the same group',
  WOULD_BLOCK_REENTRY_COOLDOWN: 're-entry within 15 min of the last close',
};
/** Pure: the warning line for an entry past live limits, or null. */
export function freshRiskFlagLine(flags: readonly string[] | undefined): string | null {
  if (!flags?.length) return null;
  return `⚠️ Live account would have skipped this: ${flags.map((f) => RISK_FLAG[f] ?? esc(f)).join('; ')}`;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const px = (n: number) => n.toFixed(2);
const ist = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

/** Pure: the Telegram text for one paper transition. Never claims a broker fill. */
export function formatFreshTradeNotice({ kind, position: p }: FreshTradeNotice): string {
  const ev = (p.contract.evidence ?? {}) as Record<string, unknown>;
  const name = [ev.underlying, ev.strike, ev.side].filter((x) => x != null && x !== '').join(' ') || p.contract.id;
  const contract = `${esc(String(name))}${ev.expiry ? ` · exp ${esc(String(ev.expiry))}` : ''}`;
  const units = p.quantity * p.contract.multiplier;
  const head = `${STRATEGY[p.candidate.strategy] ?? esc(p.candidate.strategy)} · ${p.candidate.direction === 'BULLISH' ? 'bullish (CE)' : 'bearish (PE)'} · ${esc(p.candidate.version)}`;
  if (kind === 'ENTRY') {
    return [
      `🟢 <b>NEW PAPER TRADE</b> — ${contract}`,
      head,
      `Entry ${px(p.entry)} (ask fill) × ${p.quantity} lot(s) = ${units} units at ${ist(p.openedAt)} IST`,
      `Initial risk ${inr(p.originalRiskCurrency)} (1R) · premium stop ${px(p.currentStop)}`,
      `Underlying: invalidation ${px(p.candidate.stop)} · target ${px(p.candidate.target)}`,
      ...[freshRiskFlagLine(p.riskFlags)].filter((x): x is string => x != null),
      `<i>Paper trade — no broker order is placed.</i>`,
    ].join('\n');
  }
  const net = p.netPnl ?? 0, r = p.originalRiskCurrency > 0 ? net / p.originalRiskCurrency : 0;
  return [
    `${net > 0 ? '✅' : net < 0 ? '🔴' : '⚪'} <b>PAPER TRADE CLOSED</b> — ${contract}`,
    head,
    `Exit ${p.exitPrice != null ? px(p.exitPrice) : '—'} (bid fill) · reason ${esc(p.exitReason ?? 'UNKNOWN')}`,
    `Net P&amp;L ${net >= 0 ? '+' : '−'}${inr(Math.abs(net))} (${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}R) after estimated costs · entry ${px(p.entry)}`,
    `<i>Paper trade — no broker order is placed.</i>`,
  ].join('\n');
}

/** Best effort and fire-and-forget: a Telegram failure never touches paper state, exits or entries. */
export const freshTelegramNotifier: FreshTradeNotifier = (notice) => {
  let text: string;
  try { text = formatFreshTradeNotice(notice); } catch (err: any) { logger.warn({ error: err?.message }, 'Fresh-start trade notice could not be formatted'); return; }
  void sendTelegramMessage(text).catch((err: any) => logger.warn({ error: err?.message, kind: notice.kind, id: notice.position.id }, 'Fresh-start trade notice not delivered'));
};
