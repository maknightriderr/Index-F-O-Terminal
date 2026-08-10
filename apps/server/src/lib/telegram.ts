// ============================================================
// TELEGRAM ALERT DELIVERY
// ============================================================
// Thin wrapper around the Telegram Bot API's sendMessage call.
// A no-op (logged once) if TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID
// aren't configured — Telegram is an optional delivery channel,
// alerts still land in the in-app feed either way.
// ============================================================

import axios from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

export function isTelegramConfigured(): boolean {
  return !!config.telegram.botToken && !!config.telegram.chatId;
}

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!isTelegramConfigured()) return;

  try {
    await axios.post(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 10000 }
    );
  } catch (err: any) {
    logger.warn({ error: err.response?.data?.description || err.message }, 'Telegram alert delivery failed');
  }
}
