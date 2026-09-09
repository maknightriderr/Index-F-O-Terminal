// ============================================================
// TELEGRAM NOTIFICATIONS — TRADE SETUPS ONLY
// ============================================================
// Pushes a message the moment a NEW trade setup is locked in, so a setup
// generated while nobody has the terminal open still gets seen.
//
// Deliberately scoped to trade setups and nothing else. This app already
// generates a large volume of alerts (OI/IV extremes, price levels,
// pattern detections) which were digested down precisely because ~100 a
// day was unreadable — pushing those to a phone would recreate that
// problem somewhere it's harder to ignore. A trade setup is rare (it has
// to clear confidence, liquidity, reward:risk and reliability gates) and
// is the only thing here that's directly actionable.
//
// Every failure path is soft. A notification is a side effect of
// generating a setup, never a precondition for it: if Telegram is
// unconfigured, rate-limiting us, or down, the setup must still be
// created, stored and recorded exactly as it would have been.
// ============================================================

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { Exchange, TradeSetup, TradingMode, BiasDirection } from '@fno/shared';

const TELEGRAM_API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 8000;

let warnedUnconfigured = false;

function isConfigured(): boolean {
  const { botToken, chatId } = config.telegram;
  if (botToken && chatId) return true;
  // Warn once, not on every setup — an unconfigured install would
  // otherwise fill the log with the same line all session.
  if (!warnedUnconfigured) {
    warnedUnconfigured = true;
    logger.warn(
      { hasToken: !!botToken, hasChatId: !!chatId },
      'Telegram notifications disabled — TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID not set'
    );
  }
  return false;
}

/** Telegram's MarkdownV2 reserves these; an unescaped one makes the whole send fail. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (ch) => `\\${ch}`);
}

async function send(text: string): Promise<boolean> {
  if (!isConfigured()) return false;
  const { botToken, chatId } = config.telegram;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Telegram puts the real reason in the body (bad chat_id, bot blocked,
      // markdown parse error), and the status alone doesn't say which.
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'Telegram send failed');
      return false;
    }
    return true;
  } catch (err: any) {
    logger.warn({ error: err.message }, 'Telegram send errored');
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fire-and-forget notification for a newly locked-in trade setup.
 *
 * Returns immediately; the caller is on the critical path of generating a
 * setup and must not wait on (or fail because of) a messaging side effect.
 */
export function notifyTradeSetup(params: {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  direction: BiasDirection;
  confidence: number;
  setup: TradeSetup;
}): void {
  if (!isConfigured()) return;
  void sendTradeSetup(params).catch((err: any) =>
    logger.warn({ error: err.message, underlying: params.underlying }, 'Telegram trade-setup notify failed')
  );
}

async function sendTradeSetup({
  underlying,
  exchange,
  mode,
  direction,
  confidence,
  setup,
}: {
  underlying: string;
  exchange: Exchange;
  mode: TradingMode;
  direction: BiasDirection;
  confidence: number;
  setup: TradeSetup;
}): Promise<void> {
  if (!setup.available) return;

  const e = escapeMarkdown;
  const num = (n: number | undefined, dp = 2) => (n != null ? e(n.toFixed(dp)) : '—');
  const arrow = direction === 'BULLISH' ? '🟢' : '🔴';

  const lines: string[] = [];
  lines.push(`${arrow} *${e(underlying)}* ${e(setup.side ?? '')} ${setup.strike != null ? e(String(setup.strike)) : ''}`.trim());
  lines.push(`_${e(mode)} · ${e(exchange)} · ${e(direction)} ${e(String(confidence))}%_`);
  lines.push('');
  lines.push(`Entry  *${num(setup.entry)}*`);
  lines.push(`SL     *${num(setup.stopLoss)}*`);
  lines.push(`Target *${num(setup.target)}*`);
  if (setup.riskReward != null) lines.push(`R:R    *1:${num(setup.riskReward)}*`);

  const ps = setup.positionSize;
  if (ps && ps.lots > 0) {
    lines.push('');
    lines.push(`${e(String(ps.lots))} lot\\(s\\) · ${e(String(ps.quantity))} qty`);
    lines.push(`Risk ₹${e(ps.riskAmount.toFixed(0))} \\(${num(ps.riskPct)}% of capital\\)`);
    lines.push(`Premium ₹${e(ps.premiumOutlay.toFixed(0))} \\(${num(ps.premiumPct)}%\\)`);
  } else if (ps) {
    lines.push('');
    lines.push(`⚠️ No safe lot size at current risk limits`);
  }

  // A counter-index setup must carry the same warning here that the UI
  // shows — a push notification is read with less context than a screen.
  if (setup.counterIndex) {
    lines.push('');
    lines.push(`⚠️ NIFTY is ${e(setup.counterIndex)} — this runs against the broader market`);
  }

  await send(lines.join('\n'));
}
