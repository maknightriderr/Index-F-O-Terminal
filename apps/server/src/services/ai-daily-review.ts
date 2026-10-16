// ============================================================
// AI DAILY REVIEW — the session note (2026-10-16)
// ============================================================
// Read-only. Inside the AI assistant import boundary: it receives the paper
// trades as data (the job in daily-review-job.ts reads them) and imports no
// trading module. The numbers are computed here, in code; the model only
// writes 2-4 sentences around them, and the message carries the numbers
// whether or not the model answers.
// ============================================================

import type { PaperTradeView } from '@fno/shared';
import { askAi } from '../lib/llm.js';

export type ReviewGroup = 'NSE_BSE' | 'MCX';

/** Redis list of the latest reviews, newest first (written by daily-review-job.ts, read by the assistant route). */
export const REVIEW_HISTORY_KEY = 'daily-review:history';

export interface ReviewTrade {
  label: string;
  netR: number;
}

export interface SessionReviewStats {
  group: ReviewGroup;
  /** IST date, YYYY-MM-DD. */
  date: string;
  minted: number;
  closed: number;
  wins: number;
  losses: number;
  expired: number;
  /** Sum of net R (after estimated costs) of the trades closed today that count in performance. */
  netR: number | null;
  meanNetR: number | null;
  best: ReviewTrade | null;
  worst: ReviewTrade | null;
  oldIndicator: { closed: number; netR: number | null };
  others: { closed: number; netR: number | null };
  stillOpen: number;
}

export interface DailyReview {
  group: ReviewGroup;
  date: string;
  createdAt: number;
  stats: SessionReviewStats;
  /** The numbers as plain lines (reviewNumberLines), for the assistant panel. */
  lines: string[];
  summary: string | null;
  via: string | null;
  /** The full message as sent (Telegram HTML). */
  message: string;
}

const istDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const inGroup = (t: PaperTradeView, g: ReviewGroup) => (g === 'MCX' ? t.exchange === 'MCX' : t.exchange === 'NSE' || t.exchange === 'BSE');
const isOldIndicator = (t: PaperTradeView) => t.family === 'INDICATOR' || (t.family == null && /^Indicator/.test(t.strategyLabel));
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const contractOf = (t: PaperTradeView) => [t.symbol, t.strike, t.side].filter((x) => x != null).join(' ');

/** Pure: one session's numbers from the paper trades. Closed today = exited today (IST), whenever it was minted. */
export function sessionReviewStats(trades: readonly PaperTradeView[], group: ReviewGroup, date: string): SessionReviewStats {
  const mine = trades.filter((t) => inGroup(t, group));
  const closedToday = mine.filter((t) => t.state !== 'OPEN' && t.exitAt != null && istDate(t.exitAt) === date);
  const counted = closedToday.filter((t) => t.includedInPerformance && t.netR != null);
  const sum = (xs: readonly PaperTradeView[]) => (xs.length ? r4(xs.reduce((a, t) => a + (t.netR as number), 0)) : null);
  const sorted = [...counted].sort((a, b) => (b.netR as number) - (a.netR as number));
  const ind = counted.filter(isOldIndicator);
  const oth = counted.filter((t) => !isOldIndicator(t));
  return {
    group,
    date,
    minted: mine.filter((t) => istDate(t.mintedAt) === date).length,
    closed: closedToday.length,
    wins: closedToday.filter((t) => t.state === 'WIN').length,
    losses: closedToday.filter((t) => t.state === 'LOSS').length,
    expired: closedToday.filter((t) => t.state === 'EXPIRED').length,
    netR: sum(counted),
    meanNetR: counted.length ? r4((sum(counted) as number) / counted.length) : null,
    best: sorted[0] ? { label: contractOf(sorted[0]), netR: sorted[0].netR as number } : null,
    worst: sorted.length > 1 ? { label: contractOf(sorted[sorted.length - 1]), netR: sorted[sorted.length - 1].netR as number } : null,
    oldIndicator: { closed: ind.length, netR: sum(ind) },
    others: { closed: oth.length, netR: sum(oth) },
    stillOpen: mine.filter((t) => t.state === 'OPEN').length,
  };
}

const R = (v: number | null) => (v == null ? 'n/a' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`);
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const GROUP_LABEL: Record<ReviewGroup, string> = { NSE_BSE: 'NSE/BSE', MCX: 'MCX' };
const dayLabel = (date: string) => new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

/** Pure: the numbers as plain lines (also what the model is given). */
export function reviewNumberLines(s: SessionReviewStats): string[] {
  const lines = [
    `Minted today: ${s.minted} · Closed today: ${s.closed} (win ${s.wins} · loss ${s.losses} · expired ${s.expired})`,
    `Net after estimated costs: ${R(s.netR)}${s.meanNetR != null ? ` (${R(s.meanNetR)} a trade)` : ''}`,
  ];
  if (s.best) lines.push(`Best: ${s.best.label} ${R(s.best.netR)}${s.worst ? ` · Worst: ${s.worst.label} ${R(s.worst.netR)}` : ''}`);
  lines.push(`Old Indicator: ${s.oldIndicator.closed} closed, ${R(s.oldIndicator.netR)} · Other strategies: ${s.others.closed} closed, ${R(s.others.netR)}`);
  lines.push(`Still open: ${s.stillOpen}`);
  return lines;
}

/** Pure: the Telegram message (HTML parse mode). */
export function formatReviewMessage(s: SessionReviewStats, summary: string | null, via: string | null): string {
  const head = `📊 <b>${GROUP_LABEL[s.group]} session review · ${escapeHtml(dayLabel(s.date))}</b>\nPaper trades only: no orders were placed.`;
  const body = reviewNumberLines(s).map(escapeHtml).join('\n');
  const ai = summary ? `<i>AI note (via ${escapeHtml(via ?? 'AI')}):</i>\n${escapeHtml(summary)}` : '<i>AI note unavailable for this session; the numbers above are complete.</i>';
  return `${head}\n\n${body}\n\n${ai}`;
}

export const REVIEW_SYSTEM_PROMPT = `You write a short end-of-session note for a trader about their own options paper-trading terminal.

Rules:
- Use only the numbers between <numbers> and </numbers>. Never invent trades, prices, news or reasons.
- 2 to 4 plain sentences, at most 80 words.
- Say plainly whether the session was positive or negative after estimated costs, and what drove it (the best and worst trades, the Old Indicator against the other strategies).
- One session is far too few trades to judge any strategy: never say a strategy works or fails because of it. No advice, no predictions.
- "R" is one unit of a trade's initial risk. Plain text only: no headings, no markdown.`;

/** The model's note around the numbers, or null when no provider answered (the review is sent without it). */
export async function writeReviewSummary(s: SessionReviewStats): Promise<{ text: string; via: string } | null> {
  if (s.closed === 0 && s.minted === 0) return null;
  try {
    const reply = await askAi(REVIEW_SYSTEM_PROMPT, [{ role: 'user', content: `<numbers>\n${GROUP_LABEL[s.group]} session, ${s.date}\n${reviewNumberLines(s).join('\n')}\n</numbers>\nWrite the note.` }]);
    return { text: reply.text, via: reply.label };
  } catch {
    return null;
  }
}
