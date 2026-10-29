// This module writes ONLY the isolated ai_* research tables. All source reads are SELECTs.
import { randomUUID } from 'node:crypto';
import { sql } from '../lib/db.js';
import { isAiConfigured } from '../lib/llm.js';
import type { AutoReviewEvidence, AutoReviewNarrative, AutoReviewReport, AutoReviewResult } from '@fno/shared';
import { AUTO_REVIEW_VERSION, autoReviewEnabled, type ReviewSource } from './ai-trade-review.js';

export const REVIEW_SCOPE = 'Automatically reviews winners, losers and expired closes: initial seven-day backlog plus every subsequent close, including older positional trades. Discovery every minute; two-minute settlement delay. Findings never alter trading rules.';
export interface ReviewClaim { signal_id: string; fingerprint: string; lease_owner: string; attempts: number; closed_at: string }

export async function discoverAutomaticReviews() {
  await sql`INSERT INTO ai_review_versions (version) VALUES (${AUTO_REVIEW_VERSION}) ON CONFLICT DO NOTHING`;
  // Reopened/removed outcomes must not retain a completed interpretation or accept an old worker's answer.
  await sql`UPDATE ai_trade_reviews r SET status = 'PENDING', fingerprint = md5(s.inputs::text), evidence = NULL, review = NULL,
    completed_at = NULL, lease_owner = NULL, lease_until = NULL, last_error = 'Source is no longer closed; waiting automatically',
    next_attempt_at = NOW(), attempts = 0
    FROM signals s WHERE s.id = r.signal_id AND r.version = ${AUTO_REVIEW_VERSION}
      AND COALESCE(s.inputs->>'outcome','OPEN') NOT IN ('WIN','LOSS','EXPIRED') AND r.fingerprint IS DISTINCT FROM md5(s.inputs::text)`;
  // A corrected trade invalidates the old interpretation. In-flight workers cannot overwrite it: completion requires this fingerprint AND lease.
  await sql`
    INSERT INTO ai_trade_reviews (signal_id, version, fingerprint, symbol, strategy, source_version, logic_version, exchange, mode, closed_at, next_attempt_at)
    SELECT s.id, ${AUTO_REVIEW_VERSION}, md5(s.inputs::text), s.symbol,
      COALESCE(s.inputs->>'source','UNRECORDED'), COALESCE(s.inputs->>'sourceVersion','UNRECORDED'), COALESCE(s.inputs->'logic'->>'logicVersion','UNRECORDED'),
      COALESCE(s.inputs->>'exchange','UNRECORDED'), COALESCE(s.inputs->>'mode','UNRECORDED'),
      CASE WHEN s.inputs->>'exitTime' ~ '^[0-9]{12,14}$' THEN to_timestamp((s.inputs->>'exitTime')::double precision / 1000) ELSE s.time END,
      NOW() + interval '2 minutes'
    FROM signals s CROSS JOIN ai_review_versions v
    WHERE v.version = ${AUTO_REVIEW_VERSION} AND s.signal_type = 'TRADE_SETUP' AND s.inputs->>'outcome' IN ('WIN','LOSS','EXPIRED')
      AND (s.time >= v.activated_at - interval '7 days' OR
        CASE WHEN s.inputs->>'exitTime' ~ '^[0-9]{12,14}$' THEN to_timestamp((s.inputs->>'exitTime')::double precision / 1000) ELSE s.time END >= v.activated_at)
    ON CONFLICT (signal_id, version) DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
      symbol = EXCLUDED.symbol, strategy = EXCLUDED.strategy, source_version = EXCLUDED.source_version, logic_version = EXCLUDED.logic_version,
      exchange = EXCLUDED.exchange, mode = EXCLUDED.mode, closed_at = EXCLUDED.closed_at, status = 'PENDING', attempts = 0,
      next_attempt_at = NOW() + interval '2 minutes', lease_owner = NULL, lease_until = NULL, evidence = NULL, review = NULL,
      provider = NULL, model = NULL, last_error = NULL, completed_at = NULL
    WHERE ai_trade_reviews.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint
  `;
}

export async function claimAutomaticReview(): Promise<ReviewClaim | null> {
  const owner = randomUUID();
  const rows = await sql<ReviewClaim[]>`
    WITH due AS (
      SELECT r.signal_id FROM ai_trade_reviews r JOIN signals s ON s.id = r.signal_id
      WHERE r.version = ${AUTO_REVIEW_VERSION} AND r.status <> 'COMPLETE'
        AND r.next_attempt_at <= NOW() AND (r.lease_until IS NULL OR r.lease_until < NOW())
        AND s.inputs->>'outcome' IN ('WIN','LOSS','EXPIRED')
      ORDER BY r.closed_at DESC, r.signal_id FOR UPDATE OF r SKIP LOCKED LIMIT 1
    )
    UPDATE ai_trade_reviews r SET status = 'RUNNING', attempts = attempts + 1,
      lease_owner = ${owner}::uuid, lease_until = NOW() + interval '10 minutes'
    FROM due WHERE r.signal_id = due.signal_id AND r.version = ${AUTO_REVIEW_VERSION}
    RETURNING r.signal_id, r.fingerprint, r.lease_owner, r.attempts, r.closed_at
  `;
  return rows[0] ?? null;
}

export async function automaticReviewSource(claim: ReviewClaim, executionAvailable: boolean): Promise<ReviewSource> {
  const rows = await sql<Array<{ symbol: string; time: Date; inputs: Record<string, any> }>>`
    SELECT symbol, time, inputs FROM signals WHERE id = ${claim.signal_id}::uuid AND md5(inputs::text) = ${claim.fingerprint} AND signal_type = 'TRADE_SETUP'
  `;
  if (!rows[0]) throw new Error('SOURCE_CHANGED');
  const snapshots = await sql<Array<Record<string, any>>>`
    SELECT decision, bias, confidence, regime, spread_pct, delta FROM decision_snapshots WHERE signal_id = ${claim.signal_id}::uuid ORDER BY time LIMIT 1
  `;
  const observations = executionAvailable ? await sql<Array<{ samples: number; high: string | null; low: string | null }>>`
    SELECT COUNT(*)::integer AS samples, MAX(ltp)::text AS high, MIN(ltp)::text AS low FROM paper_execution_observations
    WHERE signal_id = ${claim.signal_id}::uuid AND ltp > 0 AND observed_at >= ${rows[0].time} AND observed_at <= ${new Date(claim.closed_at)}
  ` : [];
  const i = rows[0].inputs;
  const peers = await sql<Array<{ measured: number; profitable: number; losing: number; net_r: number | null }>>`
    SELECT COUNT(*)::integer AS measured, COUNT(*) FILTER (WHERE (evidence->>'netR')::numeric > 0)::integer AS profitable,
      COUNT(*) FILTER (WHERE (evidence->>'netR')::numeric < 0)::integer AS losing, SUM((evidence->>'netR')::numeric)::float8 AS net_r
    FROM ai_trade_reviews WHERE version = ${AUTO_REVIEW_VERSION} AND status = 'COMPLETE' AND evidence->>'netR' IS NOT NULL
      AND signal_id <> ${claim.signal_id}::uuid AND strategy = ${i.source ?? 'UNRECORDED'} AND source_version = ${i.sourceVersion ?? 'UNRECORDED'}
      AND logic_version = ${i.logic?.logicVersion ?? 'UNRECORDED'} AND exchange = ${i.exchange ?? 'UNRECORDED'} AND mode = ${i.mode ?? 'UNRECORDED'}
  `;
  return { ...rows[0], snapshot: snapshots[0] ?? null, observations: observations[0] ?? null, peers: peers[0] };
}

export async function completeAutomaticReview(claim: ReviewClaim, evidence: AutoReviewEvidence, answer: { review: AutoReviewNarrative; provider: string; model: string }) {
  const rows = await sql<{ signal_id: string }[]>`
    UPDATE ai_trade_reviews SET status = 'COMPLETE', evidence = ${sql.json(evidence as any)}, review = ${sql.json(answer.review as any)},
      provider = ${answer.provider}, model = ${answer.model}, completed_at = NOW(), lease_owner = NULL, lease_until = NULL, last_error = NULL
    WHERE signal_id = ${claim.signal_id}::uuid AND version = ${AUTO_REVIEW_VERSION} AND fingerprint = ${claim.fingerprint} AND lease_owner = ${claim.lease_owner}::uuid
      AND EXISTS (SELECT 1 FROM signals s WHERE s.id = ${claim.signal_id}::uuid AND md5(s.inputs::text) = ${claim.fingerprint} AND s.inputs->>'outcome' IN ('WIN','LOSS','EXPIRED'))
    RETURNING signal_id
  `;
  return rows.length === 1;
}

/** Exponential delays then one-day cooldown; automatic recovery continues without a manual reset. */
export const reviewRetrySeconds = (attempt: number) => Math.min(86400, 60 * 2 ** Math.min(11, Math.max(0, attempt - 1)));
export async function retryAutomaticReview(claim: ReviewClaim) {
  await sql`
    UPDATE ai_trade_reviews SET status = 'RETRY', next_attempt_at = NOW() + ${reviewRetrySeconds(claim.attempts)} * interval '1 second',
      lease_owner = NULL, lease_until = NULL, last_error = 'AI or evidence unavailable; automatic retry scheduled'
    WHERE signal_id = ${claim.signal_id}::uuid AND version = ${AUTO_REVIEW_VERSION} AND fingerprint = ${claim.fingerprint} AND lease_owner = ${claim.lease_owner}::uuid
  `;
}

/** GET only reads saved work; never queues a job, calls AI or changes trades. */
export async function automaticReviewReport(): Promise<AutoReviewReport> {
  const base = { enabled: autoReviewEnabled(), aiConfigured: isAiConfigured(), version: AUTO_REVIEW_VERSION, scope: REVIEW_SCOPE };
  const exists = await sql<{ present: boolean }[]>`SELECT to_regclass('public.ai_trade_reviews') IS NOT NULL AS present`;
  if (!exists[0]?.present) return { ...base, available: false, activatedAt: null, counts: {}, recent: [], repeated: [] };
  const [versions, counts, recent, repeated] = await Promise.all([
    sql<{ activated_at: Date }[]>`SELECT activated_at FROM ai_review_versions WHERE version = ${AUTO_REVIEW_VERSION}`,
    sql<{ status: string; n: number }[]>`SELECT status, COUNT(*)::integer AS n FROM ai_trade_reviews WHERE version = ${AUTO_REVIEW_VERSION} GROUP BY status`,
    sql<AutoReviewResult[]>`SELECT signal_id, symbol, strategy, source_version, logic_version, exchange, mode, status, attempts, next_attempt_at, completed_at,
      evidence, review, provider, model, last_error FROM ai_trade_reviews WHERE version = ${AUTO_REVIEW_VERSION} ORDER BY closed_at DESC, signal_id LIMIT 100`,
    sql<AutoReviewReport['repeated']>`SELECT strategy, source_version, logic_version, exchange, mode, code,
      COUNT(*)::integer AS trades, COUNT(*) FILTER (WHERE evidence->>'netR' IS NOT NULL)::integer AS measured,
      COUNT(*) FILTER (WHERE (evidence->>'netR')::numeric > 0)::integer AS profitable,
      COUNT(*) FILTER (WHERE (evidence->>'netR')::numeric < 0)::integer AS losing,
      SUM((evidence->>'netR')::numeric)::float8 AS net_r
      FROM ai_trade_reviews CROSS JOIN LATERAL jsonb_array_elements_text(evidence->'issueCodes') AS code
      WHERE version = ${AUTO_REVIEW_VERSION} AND status = 'COMPLETE'
      GROUP BY strategy, source_version, logic_version, exchange, mode, code HAVING COUNT(*) >= 2
      ORDER BY COUNT(*) DESC, strategy LIMIT 100`,
  ]);
  return { ...base, available: true, activatedAt: versions[0]?.activated_at.toISOString() ?? null,
    counts: Object.fromEntries(counts.map(r => [r.status, r.n])), recent, repeated };
}
