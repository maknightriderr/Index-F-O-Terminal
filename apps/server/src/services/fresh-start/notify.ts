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
};
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
