// ============================================================
// FRESH-START LEARNING (owner, 16 Nov): every new-engine strategy learns from its own closed paper trades
// ============================================================
// The same lessons (packages/analytics/src/learning/lessons.ts) for every strategy that enters through the fresh-start
// runtime: the 10 NEW_* setups, the Dhan engine, Human TA and premium pressure. Each candidate is read BEFORE it is
// priced: its situation is stamped into its evidence (so the trade carries it), and a candidate that would repeat a
// learned mistake is refused with a LEARNED_* decision code. The expiry-day lesson is read once the contract is known.
// Outcomes are re-read every two minutes. Never throws into the entry path: a failure means "nothing learned yet".
// ============================================================

import { learnLessons, learnedBlocks, lessonLossStreak, lessonMarketRead, lessonRefusal, type FreshCandidate, type FreshContract, type LearnedLessons, type LessonBar, type LessonFeatures, type LessonOutcome, type LessonRefusal } from '@fno/analytics';
import { getSessionWindow, type Exchange } from '@fno/shared';
import { sql } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';

export const FRESH_LEARNING_REFRESH_MS = 2 * 60_000;

export interface FreshClosed { strategy: string; direction: string | null; session: string; openedAt: number; closedAt: number | null; netR: number | null; exchange: Exchange | null; stamped: Partial<LessonFeatures> | null; expiryDay: boolean | null }
export interface FreshLearningDeps {
  /** The reference's 5-minute bars (closed and open), when the worker holds them. */
  bars: (instrument: string) => readonly LessonBar[] | undefined;
  /** The reference's exchange (for the session close). */
  exchange: (instrument: string) => Exchange | null;
  load?: () => Promise<FreshClosed[]>;
}
export interface FreshScreen { candidate: FreshCandidate; refusal: LessonRefusal | null }

const IST = 19_800_000;
const istDay = (t: number) => new Date(t + IST).toISOString().slice(0, 10);
const exchangeOfContract = (id: string | undefined): Exchange | null => (id?.startsWith('MCX') ? 'MCX' : id?.startsWith('BSE') ? 'BSE' : id?.startsWith('NSE') ? 'NSE' : null);
const minutesToClose = (exchange: Exchange | null, at: number): number | null => {
  if (!exchange) return null;
  const s = getSessionWindow(exchange, istDay(at));
  return s && at <= s.close ? Math.round((s.close - at) / 60_000) : null;
};

/** Closed positions -> lesson outcomes. Pure. Situations come from the stamp when present, else from the record. */
export function freshLessonOutcomes(rows: readonly FreshClosed[]): LessonOutcome[] {
  return rows.filter((r) => r.netR != null && Number.isFinite(r.netR) && r.direction != null).map((r) => ({
    strategy: r.strategy, at: r.openedAt, netR: r.netR!,
    features: {
      trend: r.stamped?.trend ?? null, quiet: r.stamped?.quiet ?? null,
      minutesToClose: r.stamped?.minutesToClose ?? minutesToClose(r.exchange, r.openedAt),
      expiryDay: r.expiryDay ?? r.stamped?.expiryDay ?? null,
      priorLossStreak: lessonLossStreak(rows, r.strategy, r.direction!, r.session, r.openedAt),
    },
  }));
}

export async function loadFreshClosed(): Promise<FreshClosed[]> {
  const rows = await sql<any[]>`SELECT strategy, session, state, opened_at, closed_at, net_pnl FROM fresh_paper_positions WHERE status = 'CLOSED' AND opened_at >= now() - interval '60 days' ORDER BY opened_at`;
  return rows.map((p) => {
    const st = typeof p.state === 'string' ? JSON.parse(p.state) : p.state ?? {};
    const risk = Number(st.originalRiskCurrency ?? 0), net = Number(st.netPnl ?? p.net_pnl);
    const sessions = st.contract?.expiryTradableSessions;
    return {
      strategy: p.strategy, direction: st.candidate?.direction ?? null, session: p.session,
      openedAt: new Date(p.opened_at).getTime(), closedAt: p.closed_at ? new Date(p.closed_at).getTime() : Number(st.exitTriggeredAt) || null,
      netR: risk > 0 && Number.isFinite(net) ? net / risk : null, exchange: exchangeOfContract(st.contract?.id),
      stamped: st.candidate?.evidence?.learning ?? null, expiryDay: Number.isSafeInteger(sessions) ? sessions === 0 : null,
    };
  });
}

let latest: { learned: LearnedLessons; blocks: string[] } | null = null;
/** The newest learned state (the API reads it; nothing here is computed by a GET). */
export const freshLessonsSnapshot = () => latest;

export class FreshLearning {
  private learned: LearnedLessons | null = null;
  private closed: FreshClosed[] = [];
  private refreshing: Promise<void> | null = null;
  private loadedAt = 0;
  constructor(private deps: FreshLearningDeps) {}

  /** Re-reads the closed trades in the background when older than the refresh period. Never throws. */
  refresh(now = Date.now()): Promise<void> {
    if (this.refreshing || now - this.loadedAt < FRESH_LEARNING_REFRESH_MS) return this.refreshing ?? Promise.resolve();
    this.refreshing = (this.deps.load ?? loadFreshClosed)()
      .then((rows) => {
        const before = new Set(learnedBlocks(this.learned));
        this.closed = rows; this.loadedAt = now;
        this.learned = learnLessons(freshLessonOutcomes(rows), now);
        const blocks = learnedBlocks(this.learned);
        latest = { learned: this.learned, blocks };
        const changed = blocks.filter((b) => !before.has(b)).concat([...before].filter((b) => !blocks.includes(b)));
        if (changed.length || !before.size) logger.info({ event: 'freshLearning', blocks, changed, closed: rows.length }, 'Fresh-start learning: lessons re-read from closed paper trades');
      })
      .catch((err: any) => logger.warn({ event: 'freshLearning', error: err?.message }, 'Fresh-start learning: closed trades unavailable (the last lessons stay)'))
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** The candidate's situation at entry (the contract's expiry is read later). */
  features(c: FreshCandidate): LessonFeatures {
    const market = lessonMarketRead(this.deps.bars(c.instrument) ?? [], c.direction, c.at);
    return {
      ...market,
      minutesToClose: minutesToClose(this.deps.exchange(c.instrument), c.at),
      expiryDay: null,
      priorLossStreak: lessonLossStreak(this.closed, c.strategy, c.direction, c.session, c.at),
    };
  }

  /** Stamps the situation into the candidate's evidence and returns the learned refusal, if any. */
  screen(c: FreshCandidate): FreshScreen {
    try {
      void this.refresh();
      const f = this.features(c);
      const candidate: FreshCandidate = { ...c, evidence: { ...c.evidence, learning: f } };
      return { candidate, refusal: lessonRefusal(c.strategy, f, this.learned, ['COUNTER_TREND', 'QUIET_MARKET', 'LATE_SESSION', 'AFTER_LOSING_STREAK']) };
    } catch (err: any) {
      logger.warn({ event: 'freshLearning', error: err?.message, candidate: c.id }, 'Fresh-start learning: screen failed (candidate continues unscreened)');
      return { candidate: c, refusal: null };
    }
  }

  /** Once the contract is chosen: stamps expiryDay and applies the expiry-day lesson. */
  screenContract(c: FreshCandidate, contract: FreshContract): LessonRefusal | null {
    try {
      const expiryDay = Number.isSafeInteger(contract.expiryTradableSessions) ? contract.expiryTradableSessions === 0 : null;
      const learning = (c.evidence.learning ?? {}) as Partial<LessonFeatures>;
      c.evidence.learning = { ...learning, expiryDay };
      return lessonRefusal(c.strategy, { trend: null, quiet: null, minutesToClose: null, priorLossStreak: null, expiryDay }, this.learned, ['EXPIRY_DAY']);
    } catch {
      return null;
    }
  }
}
