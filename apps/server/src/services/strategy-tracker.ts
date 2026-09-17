// ============================================================
// STRATEGY SCANNER TRACK RECORD
// ============================================================
// The Strategy Scanner recommends an option-buying structure from the F&O
// scanner's lightweight bias, and until now nothing recorded whether those
// calls worked. This snapshots every recommendation once per NSE session,
// at SNAPSHOT_MINUTES into it (14:45 IST), and grades it at the next
// session's snapshot: did the underlying move the called way, and by how
// much. Same-time-next-session grading costs no extra broker calls — the
// next snapshot's scan already carries every stock's price.
//
// It grades the direction call only. Option P&L depends on strike, IV and
// decay, which this heuristic never sized; a positive average move is
// necessary for any of these structures to pay, not sufficient.
//
// Rows live in `signals` (signal_type='STRATEGY_SCAN'); `fwd_1d_return` holds
// the signed move once graded.
// ============================================================

import { getSessionWindow, minutesSinceSessionOpen, recommendStrategy } from '@fno/shared';
import type { BiasDirection, StrategyTrackBucket, StrategyTrackRecord } from '@fno/shared';
import type { MarketDataProvider } from '../providers/interface.js';
import { sql } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { getFnoScan } from './fno-scanner.js';
import { nextSessionDate } from './next-day-model.js';

const TICK_MS = 5 * 60 * 1000;
const SNAPSHOT_MINUTES = 330; // 09:15 + 5h30 = 14:45 IST, ahead of the closing auction noise
const SIGNAL_TYPE = 'STRATEGY_SCAN';
const CONFIDENCE_BANDS: Array<{ label: string; min: number; max: number }> = [
  { label: '60–69', min: 60, max: 69 },
  { label: '70–79', min: 70, max: 79 },
  { label: '80+', min: 80, max: 100 },
];

let started = false;

export function startStrategyTracker(provider: MarketDataProvider): void {
  if (started) return;
  started = true;
  const tick = () => {
    runTick(provider).catch((err: any) => logger.warn({ error: err.message }, 'Strategy tracker tick failed'));
  };
  setTimeout(tick, 90_000);
  setInterval(tick, TICK_MS);
}

function istDate(at = Date.now()): string {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

async function runTick(provider: MarketDataProvider): Promise<void> {
  if (!provider.isAuthenticated()) return;
  const minutes = minutesSinceSessionOpen('NSE');
  if (minutes == null || minutes < SNAPSHOT_MINUTES) return;

  const today = istDate();
  const existing = await sql<{ n: string }[]>`
    SELECT COUNT(*) AS n FROM signals
    WHERE signal_type = ${SIGNAL_TYPE} AND (time AT TIME ZONE 'Asia/Kolkata')::date = ${today}::date
  `;
  if (Number(existing[0]?.n ?? 0) > 0) return;

  const rows = await getFnoScan(provider, 'NSE');
  if (rows.length === 0) return;
  const priceBySymbol = new Map(rows.map((r) => [r.symbol, r.price]));

  // Grade everything still pending against today's prices.
  const pending = await sql<{ id: string; symbol: string; day: string; direction: BiasDirection; inputs: any }[]>`
    SELECT id, symbol, to_char((time AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, direction, inputs
    FROM signals WHERE signal_type = ${SIGNAL_TYPE} AND fwd_1d_return IS NULL
  `;
  let graded = 0;
  for (const p of pending) {
    const then = Number(p.inputs?.price ?? 0);
    const now = priceBySymbol.get(p.symbol);
    if (!(then > 0) || !(now && now > 0)) continue;
    const move = ((now - then) / then) * 100;
    const signed = p.direction === 'BEARISH' ? -move : move;
    const nextSession = p.inputs?.nextSession ?? nextSessionDate(p.day);
    const inputs = { ...p.inputs, gradedOn: today, gradedPrice: now, underlyingMovePct: Math.round(move * 1000) / 1000, oneSession: nextSession === today };
    await sql`UPDATE signals SET inputs = ${sql.json(inputs)}, fwd_1d_return = ${signed} WHERE id = ${p.id}`;
    graded++;
  }

  // Snapshot today's recommendations.
  const snapshot = rows
    .map((row) => ({ row, rec: recommendStrategy(row) }))
    .filter((x): x is { row: (typeof rows)[number]; rec: NonNullable<ReturnType<typeof recommendStrategy>> } => x.rec != null);
  if (snapshot.length > 0) {
    const nextSession = nextSessionDate(today);
    // Row by row with sql.json, the same JSONB pattern the rest of the app
    // uses — once a day, so the extra round-trips don't matter.
    await sql.begin(async (tx) => {
      for (const { row, rec } of snapshot) {
        await tx`
          INSERT INTO signals (time, symbol, signal_type, direction, confidence, intelligence_score, inputs)
          VALUES (NOW(), ${row.symbol}, ${SIGNAL_TYPE}, ${row.direction}, ${row.confidence}, ${row.score},
            ${sql.json({ strategy: rec.strategy, price: row.price, ivRank: row.ivRank, nextSession })})
        `;
      }
    });
  }
  logger.info({ recorded: snapshot.length, graded }, 'Strategy Scanner recommendations snapshotted and prior ones graded');
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

function bucket(label: string, moves: number[]): StrategyTrackBucket {
  return {
    label,
    graded: moves.length,
    directionHitPercent: pct(moves.filter((m) => m > 0).length, moves.length),
    avgSignedMovePercent: moves.length > 0 ? Math.round((moves.reduce((a, b) => a + b, 0) / moves.length) * 1000) / 1000 : null,
  };
}

export async function getStrategyTrackRecord(): Promise<StrategyTrackRecord> {
  const rows = await sql<{ day: string; confidence: string; inputs: any; fwd: string | null }[]>`
    SELECT to_char((time AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, confidence, inputs, fwd_1d_return AS fwd
    FROM signals WHERE signal_type = ${SIGNAL_TYPE} AND time > NOW() - INTERVAL '120 days'
  `;
  const days = [...new Set(rows.map((r) => r.day))].sort();
  // Headline stats use one-session grades only; a missed snapshot day would otherwise mix in two-session moves.
  const gradedRows = rows.filter((r) => r.fwd != null && r.inputs?.oneSession !== false);
  const moves = gradedRows.map((r) => Number(r.fwd));
  const all = bucket('All', moves);

  const strategies = [...new Set(gradedRows.map((r) => String(r.inputs?.strategy ?? 'Unknown')))].sort();
  const byStrategy = strategies.map((st) => bucket(st, gradedRows.filter((r) => r.inputs?.strategy === st).map((r) => Number(r.fwd))));
  const byConfidence = CONFIDENCE_BANDS.map((b) =>
    bucket(b.label, gradedRows.filter((r) => Number(r.confidence) >= b.min && Number(r.confidence) <= b.max).map((r) => Number(r.fwd)))
  );

  return {
    since: days[0] ?? null,
    lastSnapshotDate: days.at(-1) ?? null,
    snapshots: days.length,
    graded: all.graded,
    pending: rows.filter((r) => r.fwd == null).length,
    directionHitPercent: all.directionHitPercent,
    avgSignedMovePercent: all.avgSignedMovePercent,
    byStrategy,
    byConfidence,
    snapshotTime: '14:45 IST',
  };
}

/** Exposed for the session-window check in tests. */
export function snapshotDue(at: number): boolean {
  const session = getSessionWindow('NSE', istDate(at));
  return !!session && at >= session.open + SNAPSHOT_MINUTES * 60_000 && at < session.close;
}
