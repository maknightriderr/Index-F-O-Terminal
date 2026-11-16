// ============================================================
// LESSONS (owner, 16 Nov): every strategy learns from its own closed paper trades — pure, deterministic
// ============================================================
// A lesson is one SITUATION a trade was entered in. A strategy stops entering in that situation once, over the last
// LESSON_RULES.windowDays days:
//   1. at least LESSON_RULES.minTrades of its closed trades were entered in it,
//   2. their average net R is below zero, and
//   3. they did worse than the same strategy's trades outside it (when there are at least minOtherTrades of those) —
//      so a lesson names a specific mistake, not "this strategy loses in general".
// Situations (read at entry, never from the outcome):
//   COUNTER_TREND        the 5-minute trend (EMA 20 / 50) pointed the other way
//   QUIET_MARKET         5-minute volatility contracted (ATR 12 < 0.75 x ATR 60)
//   LATE_SESSION         entered in the last LESSON_RULES.lateMinutes minutes before the session close
//   EXPIRY_DAY           the option expired that same session (theta)
//   AFTER_LOSING_STREAK  the same strategy had already lost LESSON_RULES.streak times in a row that session, same direction
// The window is rolling: a blocked situation produces no new trades, so its old trades age out and it is retried
// after windowDays. Nothing here reads the outcome to decide an entry except through these counts.
// ============================================================

export const LESSONS_VERSION = 'LESSONS-1.0';
export const LESSON_IDS = ['COUNTER_TREND', 'QUIET_MARKET', 'LATE_SESSION', 'EXPIRY_DAY', 'AFTER_LOSING_STREAK'] as const;
export type LessonId = typeof LESSON_IDS[number];

export const LESSON_RULES = Object.freeze({ minTrades: 10, minOtherTrades: 5, windowDays: 60, lateMinutes: 90, streak: 2, quietRatio: 0.75, fastEma: 20, slowEma: 50 });

export interface LessonFeatures {
  trend: 'WITH_TREND' | 'COUNTER_TREND' | 'NO_TREND' | null;
  quiet: boolean | null;
  minutesToClose: number | null;
  expiryDay: boolean | null;
  /** Consecutive losses of the same strategy and direction closed earlier in the same session. */
  priorLossStreak: number | null;
}
export const NO_FEATURES: LessonFeatures = Object.freeze({ trend: null, quiet: null, minutesToClose: null, expiryDay: null, priorLossStreak: null });

export interface LessonOutcome { strategy: string; at: number; netR: number; features: LessonFeatures }
export interface LessonStat { trades: number; avgNetR: number | null; others: number; othersAvgNetR: number | null; block: boolean }
export interface StrategyLessons { strategy: string; trades: number; lessons: Record<LessonId, LessonStat> }
export interface LearnedLessons { version: string; at: number; byStrategy: Record<string, StrategyLessons> }
export interface LessonRefusal { code: `LEARNED_${LessonId}`; lesson: LessonId; reason: string }

/** Which situations a trade was entered in. Unknown features tag nothing (missing is never counted either way). */
export function lessonTags(f: LessonFeatures): LessonId[] {
  const tags: LessonId[] = [];
  if (f.trend === 'COUNTER_TREND') tags.push('COUNTER_TREND');
  if (f.quiet === true) tags.push('QUIET_MARKET');
  if (f.minutesToClose != null && f.minutesToClose >= 0 && f.minutesToClose <= LESSON_RULES.lateMinutes) tags.push('LATE_SESSION');
  if (f.expiryDay === true) tags.push('EXPIRY_DAY');
  if (f.priorLossStreak != null && f.priorLossStreak >= LESSON_RULES.streak) tags.push('AFTER_LOSING_STREAK');
  return tags;
}
/** Whether a feature was observed at all (a trade with an unknown feature is in neither group for that lesson). */
const known = (f: LessonFeatures, id: LessonId): boolean =>
  id === 'COUNTER_TREND' ? f.trend != null : id === 'QUIET_MARKET' ? f.quiet != null : id === 'LATE_SESSION' ? f.minutesToClose != null : id === 'EXPIRY_DAY' ? f.expiryDay != null : f.priorLossStreak != null;

const r2 = (n: number) => Math.round(n * 100) / 100;
const avg = (xs: number[]) => (xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

export function learnLessons(outcomes: readonly LessonOutcome[], at: number, rules = LESSON_RULES): LearnedLessons {
  const recent = outcomes.filter((o) => Number.isFinite(o.netR) && o.at <= at && at - o.at <= rules.windowDays * 86_400_000);
  const byStrategy: Record<string, StrategyLessons> = {};
  for (const strategy of [...new Set(recent.map((o) => o.strategy))].sort()) {
    const mine = recent.filter((o) => o.strategy === strategy);
    const lessons = {} as Record<LessonId, LessonStat>;
    for (const id of LESSON_IDS) {
      const seen = mine.filter((o) => known(o.features, id));
      const inIt = seen.filter((o) => lessonTags(o.features).includes(id)).map((o) => o.netR), out = seen.filter((o) => !lessonTags(o.features).includes(id)).map((o) => o.netR);
      const a = avg(inIt), b = avg(out);
      const block = inIt.length >= rules.minTrades && a != null && a < 0 && (out.length < rules.minOtherTrades || (b != null && a < b));
      lessons[id] = { trades: inIt.length, avgNetR: a, others: out.length, othersAvgNetR: b, block };
    }
    byStrategy[strategy] = { strategy, trades: mine.length, lessons };
  }
  return { version: LESSONS_VERSION, at, byStrategy };
}

const WHAT: Record<LessonId, string> = {
  COUNTER_TREND: 'against the 5-minute trend',
  QUIET_MARKET: 'in a quiet (contracting-volatility) market',
  LATE_SESSION: `in the last ${LESSON_RULES.lateMinutes} minutes of the session`,
  EXPIRY_DAY: 'on an option expiring the same day',
  AFTER_LOSING_STREAK: `after ${LESSON_RULES.streak} losses in a row in the same direction that session`,
};

/** The first learned lesson this entry would repeat, or null. */
export function lessonRefusal(strategy: string, f: LessonFeatures, learned: LearnedLessons | null, only?: readonly LessonId[]): LessonRefusal | null {
  const s = learned?.byStrategy[strategy];
  if (!s) return null;
  for (const id of lessonTags(f)) {
    if (only && !only.includes(id)) continue;
    const l = s.lessons[id];
    if (!l?.block) continue;
    return { code: `LEARNED_${id}`, lesson: id, reason: `${strategy} has closed ${l.trades} trades entered ${WHAT[id]} at an average ${l.avgNetR}R net (${l.others ? `${l.othersAvgNetR}R over its ${l.others} other trades` : 'no other trades yet'}); it no longer enters ${WHAT[id]}.` };
  }
  return null;
}

/** The learned blocks, for logs and the API. */
export function learnedBlocks(learned: LearnedLessons | null): string[] {
  if (!learned) return [];
  return Object.values(learned.byStrategy).flatMap((s) => LESSON_IDS.filter((id) => s.lessons[id].block).map((id) => `${s.strategy}:${id}`));
}

// ---- Situation readers (shared by both engines) ----

export interface LessonBar { time: number; high: number; low: number; close: number }
function ema(xs: number[], n: number): number { const k = 2 / (n + 1); let e = xs[0]; for (let i = 1; i < xs.length; i++) e = xs[i] * k + e * (1 - k); return e; }
function atr(bars: readonly LessonBar[]): number {
  let s = 0; for (let i = 1; i < bars.length; i++) s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  return bars.length > 1 ? s / (bars.length - 1) : 0;
}
/** Trend alignment and quietness from CLOSED 5-minute bars before `now`; null when there are too few bars. */
export function lessonMarketRead(bars5: readonly LessonBar[], direction: 'BULLISH' | 'BEARISH', now: number): Pick<LessonFeatures, 'trend' | 'quiet'> {
  const closed = bars5.filter((b) => b.time + 300_000 <= now).slice(-120);
  if (closed.length < LESSON_RULES.slowEma + 1) return { trend: null, quiet: null };
  const closes = closed.map((b) => b.close), fast = ema(closes, LESSON_RULES.fastEma), slow = ema(closes, LESSON_RULES.slowEma), last = closes[closes.length - 1];
  const dir = fast > slow && last > slow ? 1 : fast < slow && last < slow ? -1 : 0;
  const want = direction === 'BULLISH' ? 1 : -1;
  const a12 = atr(closed.slice(-13)), a60 = atr(closed.slice(-61));
  return { trend: dir === 0 ? 'NO_TREND' : dir === want ? 'WITH_TREND' : 'COUNTER_TREND', quiet: a60 > 0 ? a12 < LESSON_RULES.quietRatio * a60 : null };
}

/** Consecutive losses of the same strategy and direction in `session` that closed before `at`. */
export function lessonLossStreak(history: ReadonlyArray<{ strategy: string; direction: string | null; session: string; closedAt: number | null; netR: number | null }>, strategy: string, direction: string, session: string, at: number): number {
  const prior = history.filter((h) => h.strategy === strategy && h.direction === direction && h.session === session && h.closedAt != null && h.closedAt <= at && h.netR != null).sort((a, b) => b.closedAt! - a.closedAt!);
  let n = 0; for (const h of prior) { if (h.netR! < 0) n++; else break; }
  return n;
}
