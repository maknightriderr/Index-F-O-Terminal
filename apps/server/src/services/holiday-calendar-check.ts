// ============================================================
// HOLIDAY CALENDAR COVERAGE CHECK
// ============================================================
// EXCHANGE_HOLIDAYS (@fno/shared) is a hand-maintained list. When a year
// isn't in it, every weekday holiday of that year silently reads as a
// normal session: setups get minted off frozen quotes, backtests count
// them, and the OI baseline treats the holiday as a session. Nothing
// fails loudly, so this makes the gap loud: a warning in the logs daily,
// and one Telegram reminder a day from 1 December until next year's
// exchange lists (published in December) are added.
// ============================================================

import { HOLIDAY_CALENDAR_YEARS } from '@fno/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { isTelegramConfigured, sendTelegramMessage } from '../lib/telegram.js';

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

let started = false;

export function startHolidayCalendarCheck(): void {
  if (started) return;
  started = true;
  const tick = () => {
    check().catch((err: any) => logger.warn({ error: err.message }, 'Holiday calendar check failed'));
  };
  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, CHECK_INTERVAL_MS);
}

async function check(): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  const missing: number[] = [];
  if (!HOLIDAY_CALENDAR_YEARS.includes(year)) missing.push(year);
  if (month === 12 && !HOLIDAY_CALENDAR_YEARS.includes(year + 1)) missing.push(year + 1);
  if (missing.length === 0) return;

  const message =
    `Exchange holiday calendar is missing ${missing.join(' and ')}. Until NSE/BSE/MCX holidays for ` +
    `${missing.join(' and ')} are added to EXCHANGE_HOLIDAYS in packages/shared/src/constants/index.ts, ` +
    `those holidays are treated as trading days (covered years: ${HOLIDAY_CALENDAR_YEARS.join(', ') || 'none'}).`;
  logger.warn({ missing, covered: HOLIDAY_CALENDAR_YEARS }, message);

  if (!isTelegramConfigured()) return;
  const claimed = await redis.set(`holiday_calendar_reminder:${today}`, '1', 'EX', 2 * 24 * 60 * 60, 'NX');
  if (claimed === 'OK') await sendTelegramMessage(`⚠️ ${message}`);
}
