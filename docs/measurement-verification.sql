-- ============================================================
-- Measurement pipeline verification — READ ONLY (2026-10-09)
-- ============================================================
-- Run against production after genuine paper trades have minted / closed:
--   railway ssh --service Postgres -- 'psql -U $POSTGRES_USER -d $POSTGRES_DB -At -F" | " -f -' < docs/measurement-verification.sql
-- Each line is  <check> | <result> | PASS-criterion. Nothing here writes.
-- Trades are measured from :since (the release's first full session).
-- ============================================================
SET default_transaction_read_only = on;
\set since '2026-10-12 00:00:00+05:30'

-- 1. Cost records: one per newly minted single-leg trade, components populated.
SELECT '1a minted trades since' k, count(*)::text v FROM signals
 WHERE signal_type='TRADE_SETUP' AND time >= :'since' AND coalesce(inputs->>'structureType','NAKED_LONG')='NAKED_LONG';
SELECT '1b of those with a cost record (want = 1a)' k, count(*)::text v FROM signals s JOIN trade_cost_records c ON c.signal_id = s.id
 WHERE s.signal_type='TRADE_SETUP' AND s.time >= :'since';
SELECT '1c duplicate cost records (want 0)' k, count(*)::text v FROM (SELECT signal_id FROM trade_cost_records GROUP BY 1 HAVING count(*)>1) x;
SELECT '1d records missing a component (want 0)' k, count(*)::text v FROM trade_cost_records
 WHERE cost->'spread'->>'perUnit' IS NULL OR cost->'slippage'->>'perUnit' IS NULL OR cost->'statutory'->>'perUnit' IS NULL
    OR cost->'brokerage'->>'perUnit' IS NULL OR cost->'gstOnBrokerage'->>'perUnit' IS NULL OR cost->'total'->>'perUnit' IS NULL
    OR cost->>'costR' IS NULL OR cost->>'costPctOfPlannedGrossProfit' IS NULL OR basis <> 'ESTIMATED_MODEL' OR cost->'actual' <> 'null'::jsonb;
SELECT '1e parts that do not add to the total (want 0)' k, count(*)::text v FROM trade_cost_records
 WHERE abs((cost->'spread'->>'perUnit')::numeric + (cost->'slippage'->>'perUnit')::numeric + (cost->'statutory'->>'perUnit')::numeric
         + (cost->'brokerage'->>'perUnit')::numeric + (cost->'gstOnBrokerage'->>'perUnit')::numeric - (cost->'total'->>'perUnit')::numeric) > 0.01;
SELECT '1f records that disagree with the setup estimatedCostPct (want 0)' k, count(*)::text v FROM trade_cost_records
 WHERE cost->'reconciliation'->>'matchesSetup' = 'false';

-- 2. Post-exit records for closed trades: right trade id, a valid status.
SELECT '2a trades closed since' k, count(*)::text v FROM signals
 WHERE signal_type='TRADE_SETUP' AND time >= :'since' AND inputs->>'outcome' IS NOT NULL AND inputs->>'voided' IS NULL
   AND coalesce(inputs->>'structureType','NAKED_LONG')='NAKED_LONG';
SELECT '2b post-exit rows by status' k, coalesce(string_agg(status||'='||n, ', '), 'none') v FROM
 (SELECT status, count(*) n FROM trade_post_exit WHERE exit_at >= :'since' GROUP BY 1) x;
SELECT '2c post-exit rows with no matching trade (want 0)' k, count(*)::text v FROM trade_post_exit p WHERE NOT EXISTS (SELECT 1 FROM signals s WHERE s.id = p.signal_id);
SELECT '2d outcome differs from the trade (want 0)' k, count(*)::text v FROM trade_post_exit p JOIN signals s ON s.id = p.signal_id WHERE p.outcome <> s.inputs->>'outcome';
SELECT '2e invalid status (want 0)' k, count(*)::text v FROM trade_post_exit WHERE status NOT IN ('OBSERVED','NO_DATA','NOT_WATCHED');
SELECT '2f closed trades still without a row after the session (unwatched ones are allowed only if open watch)' k, count(*)::text v FROM signals s
 WHERE s.signal_type='TRADE_SETUP' AND s.time >= :'since' AND s.inputs->>'outcome' IS NOT NULL AND s.inputs->>'voided' IS NULL
   AND coalesce(s.inputs->>'structureType','NAKED_LONG')='NAKED_LONG' AND (s.inputs->>'exitTime')::bigint < (extract(epoch from now() - interval '9 hours')*1000)::bigint
   AND NOT EXISTS (SELECT 1 FROM trade_post_exit p WHERE p.signal_id = s.id);
SELECT '2g duplicate post-exit rows (want 0)' k, count(*)::text v FROM (SELECT signal_id FROM trade_post_exit GROUP BY 1 HAVING count(*)>1) x;

-- 3. OPTION_PAYOFF_V2 beside, never over, the legacy grades.
SELECT '3a V2 rows' k, count(*)::text v FROM forward_outcomes WHERE kind='OPTION_PAYOFF_V2';
SELECT '3b duplicate V2 rows (want 0)' k, count(*)::text v FROM (SELECT subject_id FROM forward_outcomes WHERE kind='OPTION_PAYOFF_V2' GROUP BY 1 HAVING count(*)>1) x;
SELECT '3c legacy rows graded after V2 began (want 0)' k, count(*)::text v FROM forward_outcomes
 WHERE kind='OPTION_PAYOFF' AND graded_at >= (SELECT min(graded_at) FROM forward_outcomes WHERE kind='OPTION_PAYOFF_V2');
SELECT '3d V2 rows with no matching trade (want 0)' k, count(*)::text v FROM forward_outcomes f WHERE kind='OPTION_PAYOFF_V2' AND NOT EXISTS (SELECT 1 FROM signals s WHERE s.id::text = f.subject_id);
SELECT '3e V2 verdicts' k, string_agg(coalesce(vd,'null')||'='||n, ', ') v FROM (SELECT actual->>'verdict' AS vd, count(*) n FROM forward_outcomes WHERE kind='OPTION_PAYOFF_V2' GROUP BY 1) x;
SELECT '3f closed trades in the last 10 days still ungraded by V2 (the job grades 40 per run)' k, count(*)::text v FROM signals s
 WHERE s.signal_type='TRADE_SETUP' AND s.inputs->>'outcome' IS NOT NULL AND s.inputs->>'voided' IS NULL AND coalesce(s.inputs->>'structureType','NAKED_LONG') <> 'SPREAD'
   AND s.time >= now() - interval '10 days' AND s.time < date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
   AND NOT EXISTS (SELECT 1 FROM forward_outcomes f WHERE f.kind='OPTION_PAYOFF_V2' AND f.subject_id = s.id::text);

-- 4. Retries / reruns: nothing duplicated or left queued (the Redis retry queue is checked separately: LLEN pending_cost_records).
SELECT '4a signals rows with a duplicate cost record or post-exit row (want 0)' k,
 ((SELECT count(*) FROM (SELECT signal_id FROM trade_cost_records GROUP BY 1 HAVING count(*)>1) a)
 + (SELECT count(*) FROM (SELECT signal_id FROM trade_post_exit GROUP BY 1 HAVING count(*)>1) b))::text v;
