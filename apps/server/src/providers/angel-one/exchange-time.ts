// ============================================================
// ANGEL ONE EXCHANGE TIMESTAMPS (audit 2026-10-18, DATA-1)
// ============================================================
// A FULL-mode quote carries the exchange's own times as IST wall-clock text:
//   exchFeedTime  "21-Dec-2023 13:47:24"  when the exchange published this quote
//   exchTradeTime "21-Dec-2023 13:47:23"  when the last trade happened
// Until now every quote was stamped with the server's receive time
// (Date.now()), so a quote the exchange published minutes earlier looked
// fresh. Pure: text in, epoch ms (or null) out.
// ============================================================

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const IST_OFFSET_MS = 5.5 * 3600_000;

/** "21-Dec-2023 13:47:24" (IST) → epoch ms; anything else (missing, malformed, the epoch placeholder) → null. */
export function parseAngelExchangeTime(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month == null) return null;
  const [day, year, h, min, s] = [Number(m[1]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (day < 1 || day > 31 || h > 23 || min > 59 || s > 59 || year < 2000) return null;
  const ms = Date.UTC(year, month, day, h, min, s) - IST_OFFSET_MS;
  // A date that rolled over (31-Feb) is not the text it came from.
  return new Date(ms + IST_OFFSET_MS).getUTCDate() === day ? ms : null;
}

/** A FULL-mode quote item's exchange times, only when present and parseable (the keys are absent otherwise). */
export function exchangeTimesOf(item: { exchFeedTime?: unknown; exchTradeTime?: unknown } | null | undefined): { exchangeTimestamp?: number; lastTradeTimestamp?: number } {
  const feed = parseAngelExchangeTime(item?.exchFeedTime);
  const trade = parseAngelExchangeTime(item?.exchTradeTime);
  return { ...(feed != null ? { exchangeTimestamp: feed } : {}), ...(trade != null ? { lastTradeTimestamp: trade } : {}) };
}
