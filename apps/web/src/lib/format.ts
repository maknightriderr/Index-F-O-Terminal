// ============================================================
// DISPLAY FORMATTING — one set of rules for every figure
// ============================================================
// - An unknown or missing value is shown as an em dash, NEVER as 0. A real zero is shown as 0.
// - A signed change is formatted once: a sign inside the number, or an arrow with the magnitude,
//   never both (the old `'▲ +' + formatPercent(x)` rendered "▲ ++1.30%").
// - Times are IST, with the zone named, so a timestamp is never ambiguous.
// ============================================================

export const MISSING = '—';

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "+1.30%", "-0.45%", "0.00%"; an em dash when the value is unknown. */
export function formatSignedPercent(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return MISSING;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(decimals)}%`;
}

/** "▲ 1.30%" / "▼ 0.45%" / "● 0.00%": the arrow carries the sign, so the figure has none. */
export function formatArrowPercent(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return MISSING;
  const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '●';
  return `${arrow} ${Math.abs(v).toFixed(decimals)}%`;
}

/** An R multiple: "+0.37R", "-1.03R"; an em dash when unknown (a missing R is not 0R). */
export function formatR(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return MISSING;
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(decimals)}R`;
}

/** "₹1,234.50" with a sign when requested; an em dash when unknown. */
export function formatRupees(v: number | null | undefined, opts: { signed?: boolean; decimals?: number } = {}): string {
  if (!isNum(v)) return MISSING;
  const decimals = opts.decimals ?? 2;
  const body = Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const sign = v < 0 ? '-' : opts.signed && v > 0 ? '+' : '';
  return `${sign}₹${body}`;
}

/** A plain number, em dash when unknown. */
export function formatNumber(v: number | null | undefined, decimals = 2): string {
  if (!isNum(v)) return MISSING;
  return v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "12:05:09 IST" */
export function formatIstTime(ts: number | null | undefined, withSeconds = true): string {
  if (!isNum(ts) || ts <= 0) return MISSING;
  const t = new Date(ts).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
  return `${t} IST`;
}

/** "10 Oct 15:30 IST" (the date is omitted when the instant is today, IST). */
export function formatIstDateTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (!isNum(ts) || ts <= 0) return MISSING;
  const day = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const time = formatIstTime(ts, false);
  if (day(ts) === day(now)) return time;
  const date = new Date(ts).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  return `${date} ${time}`;
}

/** "42 s ago", "3 min ago", "5 h 10 min ago", "2 d ago"; an em dash when unknown. */
export function formatAge(ms: number | null | undefined): string {
  if (!isNum(ms) || ms < 0) return MISSING;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 36) return `${h} h ${m % 60} min ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** "45 min", "2 h 5 min"; an em dash when unknown. */
export function formatHold(minutes: number | null | undefined): string {
  if (!isNum(minutes) || minutes < 0) return MISSING;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${Math.round(minutes % 60)} min`;
}

/** A rate with its denominator: "76.9% (50 of 65)"; an em dash when there is no denominator. */
export function formatRate(numerator: number, denominator: number, decimals = 1): string {
  if (!(denominator > 0)) return MISSING;
  return `${((numerator / denominator) * 100).toFixed(decimals)}% (${numerator} of ${denominator})`;
}
