// ============================================================
// SHADOW RULES — pre-registered experiments, measurement only (2026-10-08)
// ============================================================
// Candidate changes from the 2026-10-08 trade review, measured on the paper
// trades the live system actually made, WITHOUT changing what it trades.
// Every rule and parameter is fixed here before any result is seen; none is
// tuned on the outcome. A rule is a candidate for the live system only after
// its own forward record clears the 30-trade bar with a material (≥ 0.10R,
// or the equivalent in net %) improvement — a human decision, as for a
// trigger promotion.
//
// Entry filters read only what was known when the trade was minted:
//   COST_EDGE_2X   the target's gain (% of entry premium) is under 2× the
//                  trade's estimated round-trip cost — a win could barely
//                  pay for itself
//   MCX_EVENING    an MCX entry minted at or after 18:00 IST
//   RICH_IV        implied volatility rich against historical (ivVsHv RICH)
// Exit rules replay the option's recorded marks (one per snapshotted 15m bar)
// strictly before the trade's actual exit; when a rule fires first, the
// trade is closed there instead:
//   TIME_STOP_60       the first mark ≥ 60 min after entry is below entry →
//                      exit at that mark
//   BREAKEVEN_AT_HALF  once a mark reaches entry + ½ (target − entry), a
//                      later mark at or below entry exits at entry
// Results are net of each trade's own estimated cost. A skipped trade counts
// as not taken (0). Paper / simulated only.
// ============================================================

export const SHADOW_RULES_VERSION = 'SHADOW-1.0';

export const ENTRY_RULES = ['COST_EDGE_2X', 'MCX_EVENING', 'RICH_IV'] as const;
export type EntryRule = (typeof ENTRY_RULES)[number];
export const EXIT_RULES = ['TIME_STOP_60', 'BREAKEVEN_AT_HALF'] as const;
export type ExitRule = (typeof EXIT_RULES)[number];

export const SHADOW_PARAMS = Object.freeze({
  COST_EDGE_MULTIPLE: 2,
  MCX_EVENING_FROM_HOUR_IST: 18,
  TIME_STOP_MINUTES: 60,
  BREAKEVEN_TRIGGER_FRACTION: 0.5,
});

/** The decision-time fields an entry rule may read. */
export interface EntryFacts {
  exchange: string;
  generatedAt: number;
  entry: number | null;
  target: number | null;
  estimatedCostPct: number | null;
  ivVsHv: string | null;
}

const istHour = (t: number) => Number(new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));

/** Pure: which entry rules would have skipped this trade. Null = the rule could not be evaluated (a missing field). */
export function entryFlags(f: EntryFacts): Record<EntryRule, boolean | null> {
  const gainPct = f.entry != null && f.entry > 0 && f.target != null ? ((f.target - f.entry) / f.entry) * 100 : null;
  return {
    COST_EDGE_2X: gainPct == null || f.estimatedCostPct == null ? null : gainPct < SHADOW_PARAMS.COST_EDGE_MULTIPLE * f.estimatedCostPct,
    MCX_EVENING: f.exchange === 'MCX' ? istHour(f.generatedAt) >= SHADOW_PARAMS.MCX_EVENING_FROM_HOUR_IST : false,
    RICH_IV: f.ivVsHv == null ? null : f.ivVsHv === 'RICH',
  };
}

export interface ExitSimInput {
  entry: number;
  target: number | null;
  costPct: number;
  entryAt: number;
  exitAt: number;
  /** The trade's actual net result (% of entry premium, after cost). */
  actualNetPct: number;
  /** The option's recorded marks, any order; only those strictly inside (entryAt, exitAt) are read. */
  path: ReadonlyArray<{ at: number; premium: number }>;
}

export interface ExitSimResult {
  fired: boolean;
  /** When the rule closed the trade (null = it did not fire before the actual exit). */
  at: number | null;
  netPct: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Pure: the trade's result under each exit rule. A rule that cannot fire before the actual exit leaves it unchanged. */
export function simulateExits(x: ExitSimInput): Record<ExitRule, ExitSimResult> {
  const marks = x.path.filter((p) => p.at > x.entryAt && p.at < x.exitAt).sort((a, b) => a.at - b.at);
  const unchanged: ExitSimResult = { fired: false, at: null, netPct: x.actualNetPct };
  const net = (premium: number) => round2(((premium - x.entry) / x.entry) * 100 - x.costPct);

  let timeStop = unchanged;
  const firstAfter = marks.find((m) => m.at >= x.entryAt + SHADOW_PARAMS.TIME_STOP_MINUTES * 60_000);
  if (firstAfter && firstAfter.premium < x.entry) timeStop = { fired: true, at: firstAfter.at, netPct: net(firstAfter.premium) };

  let breakeven = unchanged;
  if (x.target != null && x.target > x.entry) {
    const trigger = x.entry + SHADOW_PARAMS.BREAKEVEN_TRIGGER_FRACTION * (x.target - x.entry);
    const armedAt = marks.find((m) => m.premium >= trigger)?.at ?? null;
    const hit = armedAt == null ? null : marks.find((m) => m.at > armedAt && m.premium <= x.entry);
    if (hit) breakeven = { fired: true, at: hit.at, netPct: round2(-x.costPct) };
  }
  return { TIME_STOP_60: timeStop, BREAKEVEN_AT_HALF: breakeven };
}

// ---------------- aggregation ----------------

export interface EntryRuleTrade {
  netPct: number;
  flags: Record<EntryRule, boolean | null>;
}

const mean = (xs: readonly number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const sum = (xs: readonly number[]) => round2(xs.reduce((a, b) => a + b, 0));

/** Pure: per entry rule — the trades it would have skipped vs kept, and the total with and without it. */
export function aggregateEntryRules(trades: readonly EntryRuleTrade[]) {
  const baseline = trades.map((t) => t.netPct);
  return {
    trades: trades.length,
    baselineNetPerTrade: mean(baseline),
    baselineTotalNet: sum(baseline),
    rules: Object.fromEntries(
      ENTRY_RULES.map((rule) => {
        const measured = trades.filter((t) => t.flags[rule] != null);
        const skipped = measured.filter((t) => t.flags[rule]).map((t) => t.netPct);
        const kept = measured.filter((t) => !t.flags[rule]).map((t) => t.netPct);
        const notMeasured = trades.filter((t) => t.flags[rule] == null).map((t) => t.netPct);
        return [
          rule,
          {
            measured: measured.length,
            skipped: skipped.length,
            skippedNetPerTrade: mean(skipped),
            keptNetPerTrade: mean(kept),
            // Total with the rule: the kept trades plus the ones it could not judge (they would still be taken).
            totalNetWithRule: sum([...kept, ...notMeasured]),
            improvementTotalNet: round2(-sum(skipped)),
          },
        ];
      })
    ) as Record<EntryRule, { measured: number; skipped: number; skippedNetPerTrade: number | null; keptNetPerTrade: number | null; totalNetWithRule: number; improvementTotalNet: number }>,
  };
}

/** Pure: per exit rule over the trades that had recorded marks. */
export function aggregateExitRules(rows: ReadonlyArray<{ actualNetPct: number; exits: Record<ExitRule, ExitSimResult> }>) {
  return {
    trades: rows.length,
    baselineNetPerTrade: mean(rows.map((r) => r.actualNetPct)),
    rules: Object.fromEntries(
      EXIT_RULES.map((rule) => {
        const fired = rows.filter((r) => r.exits[rule]?.fired);
        return [
          rule,
          {
            fired: fired.length,
            netPerTradeWithRule: mean(rows.map((r) => r.exits[rule]?.netPct ?? r.actualNetPct)),
            // On the trades it changed: what they did vs what the rule would have made.
            firedActualNetPerTrade: mean(fired.map((r) => r.actualNetPct)),
            firedRuleNetPerTrade: mean(fired.map((r) => r.exits[rule].netPct)),
          },
        ];
      })
    ) as Record<ExitRule, { fired: number; netPerTradeWithRule: number | null; firedActualNetPerTrade: number | null; firedRuleNetPerTrade: number | null }>,
  };
}
