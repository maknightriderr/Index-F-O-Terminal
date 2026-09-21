// ============================================================
// TRADE SETUP CLOSE NOTIFICATIONS
// ============================================================
// Sent the moment a setup's outcome is recorded — from the same code path
// that writes its Backtesting row, so the message and the row can't
// disagree about what happened.
//
// Replaces alerts.ts's old "Trade Setup closed" check, which diffed the
// Redis sticky keys every 2 minutes. That check only noticed a close once
// the NEXT setup for the same symbol appeared (a CRUDEOIL stop-loss hit at
// 20:36 was reported at 10:01 the next morning), couldn't tell a stop-loss
// from a bias reversal (it called that stop-loss "bias shifted"), and never
// said where the trade exited or what it made or lost.
// ============================================================

import { redis } from '../lib/redis.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { sendTelegramMessage, isTelegramConfigured } from '../lib/telegram.js';
import { formatExpiryDate } from '@fno/shared';
import type { AlertChannel, Exchange, OptionType, TradingMode } from '@fno/shared';

export type TradeCloseReason =
  | 'TARGET'
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'BREAKEVEN_STOP'
  | 'BIAS_REVERSED'
  | 'SESSION_ENDED'
  | 'SETUP_INVALIDATED'
  // Added with the trade-health work: an exit has to say which of these it
  // was, or the next review has to guess (see trade-health.ts).
  | 'TIME_STOP'
  | 'TRADE_DECAY'
  | 'THESIS_INVALIDATED'
  | 'IV_COLLAPSE'
  | 'LIQUIDITY_DETERIORATION'
  | 'MANUAL_EXIT'
  | 'SYSTEM_ERROR'
  | 'UNKNOWN';

const REASON_TEXT: Record<TradeCloseReason, string> = {
  TARGET: 'Target hit',
  STOP_LOSS: 'Stop-loss hit',
  TRAILING_STOP: 'Trailing stop hit — profit locked in',
  BREAKEVEN_STOP: 'Stopped out at breakeven',
  BIAS_REVERSED: 'Closed early — bias reversed before stop-loss or target',
  SESSION_ENDED: 'Closed — the trading session ended before stop-loss or target',
  SETUP_INVALIDATED: 'Closed — setup failed a data sanity check',
  TIME_STOP: 'Closed — the trade ran out of time without making progress',
  TRADE_DECAY: 'Closed — the trade stopped working and was bleeding premium',
  THESIS_INVALIDATED: 'Closed — the reason for the trade no longer held',
  IV_COLLAPSE: 'Closed — implied volatility collapsed and took the premium with it',
  LIQUIDITY_DETERIORATION: 'Closed — the contract stopped quoting a tradeable market',
  MANUAL_EXIT: 'Closed manually',
  SYSTEM_ERROR: 'Closed after a system error',
  UNKNOWN: 'Closed — reason not recorded',
};

export interface TradeCloseNotice {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  outcome: 'WIN' | 'LOSS' | 'EXPIRED';
  reason: TradeCloseReason;
  side: OptionType | null;
  strike: number | null;
  /** Expiry (YYYY-MM-DD) of the contract the setup was priced from. */
  expiry: string | null;
  strategy: string | null;
  entry: number | null;
  exitPrice: number | null;
  returnPercent: number | null;
  rMultiple: number | null;
  generatedAt: number | null;
  /** One notification per setup — the 90s price monitor and an on-demand poll can both close the same setup in the same moment. */
  dedupeId: string;
}

const DEDUPE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Fire-and-forget: closing a setup must never wait on, or fail because of, a notification. */
export function notifyTradeSetupClosed(notice: TradeCloseNotice): void {
  void deliver(notice).catch((err: any) =>
    logger.warn({ error: err.message, underlying: notice.underlying }, 'Trade setup close notification failed')
  );
}

async function deliver(n: TradeCloseNotice): Promise<void> {
  const claimed = await redis.set(`trade_setup_close_notified:${n.dedupeId}`, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') return;

  const channels: AlertChannel[] = isTelegramConfigured() ? ['TERMINAL', 'TELEGRAM'] : ['TERMINAL'];
  const message = buildMessage(n, (s) => s);

  try {
    await sql`
      INSERT INTO alerts (symbol, alert_type, message, severity, channels, condition, triggered, triggered_at)
      VALUES (
        ${n.underlying}, 'TRADE_SETUP_CLOSED', ${message}, ${n.outcome === 'LOSS' ? 'WARNING' : 'INFO'}, ${sql.json(channels)},
        ${sql.json({
          exchange: n.exchange,
          mode: n.mode,
          outcome: n.outcome,
          reason: n.reason,
          side: n.side,
          strike: n.strike,
          expiry: n.expiry,
          entry: n.entry,
          exitPrice: n.exitPrice,
          returnPercent: n.returnPercent,
          rMultiple: n.rMultiple,
        })},
        true, NOW()
      )
    `;
  } catch (err: any) {
    logger.error({ error: err.message, symbol: n.underlying }, 'Failed to persist trade setup close alert');
  }

  logger.info({ symbol: n.underlying, alertType: 'TRADE_SETUP_CLOSED', outcome: n.outcome, reason: n.reason }, message.replace(/\n/g, ' | '));

  if (channels.includes('TELEGRAM')) {
    await sendTelegramMessage(buildMessage(n, escapeHtml));
  }
}

function buildMessage(n: TradeCloseNotice, esc: (s: string) => string): string {
  const icon = n.outcome === 'WIN' ? '✅' : n.outcome === 'LOSS' ? '🛑' : '⏹️';
  const modeLabel = n.mode === 'POSITIONAL' ? 'POS' : 'INTRA';
  const contract = n.side && n.strike != null ? `${n.side} ${n.strike}` : n.strategy ?? 'setup';
  const instrument = n.expiry ? `${contract} · ${formatExpiryDate(n.expiry)} expiry` : contract;

  const lines = [`${icon} ${n.outcome} — ${n.underlying} ${instrument} (${modeLabel} · ${n.exchange})`, REASON_TEXT[n.reason]];
  if (n.entry != null) {
    lines.push(`Entry ₹${n.entry.toFixed(2)} → Exit ${n.exitPrice != null ? `₹${n.exitPrice.toFixed(2)}` : 'price unavailable'}`);
  }
  const perf = [
    n.returnPercent != null ? `${n.returnPercent >= 0 ? '+' : ''}${n.returnPercent.toFixed(2)}%` : null,
    n.rMultiple != null ? `${n.rMultiple >= 0 ? '+' : ''}${n.rMultiple.toFixed(2)}R` : null,
  ].filter((p): p is string => p != null);
  if (perf.length > 0) lines.push(`Return ${perf.join(' · ')}`);
  if (n.generatedAt != null) lines.push(`Held ${formatDuration(Date.now() - n.generatedAt)}`);

  return lines.map(esc).join('\n');
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Telegram's HTML parse mode rejects the whole message on a bare & < > — which is what silently dropped alerts for symbols like GVT&D. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
