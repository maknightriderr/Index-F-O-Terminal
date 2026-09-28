-- ============================================================
-- CONTRACT VALIDATION, OPENING ENVIRONMENT, COOLDOWN & OI-WALL
-- FRESHNESS (Phase 3 — additive/observational, spec §5/§15/§16/§20)
-- ============================================================
-- All four columns below are recorded, not enforced. None of them changes
-- what refuses a setup, what the reward:risk/opening/cooldown gates do, or
-- what roomToTarget() filters by.
--
-- CONTRACT VALIDATION (spec §5)
--   assessOptionQuality() already returns a real tradeable/refusalReason
--   pair for the live ATM contract and trade-setup/index.ts already uses it
--   as a hard refusal (POOR_OPTION_QUALITY / LOW_OPTION_LIQUIDITY). Until now
--   that result was thrown away on a refusal (option_quality_score/grade are
--   only ever populated on a taken trade) and the actual reason survived
--   only in free-text `reason`. These three columns persist the exact result
--   either way, so a quality refusal is queryable by reason.
--     contract_tradeable           mirrors TradeSetup.contractValidation.tradeable
--     contract_refusal_reason      mirrors .refusalReason (null when tradeable)
--     contract_validation_checks   the same assessOptionQuality() components
--                                  array (liquidity/spread/delta/theta/iv)
--
-- OPENING ENVIRONMENT (spec §15)
--   SETUP_OPENING_GUARD_MINUTES is unchanged. This labels WHAT KIND of open
--   it was (apps/server/src/services/opening-classifier.ts), from readings
--   classifyRegime() already computes (ADX, atrZ, breakout flags). Populated
--   for every decision inside the opening window, taken or refused — an
--   OPENING_HOUR refusal gets a label too.
--
-- COOLDOWN EFFECTIVENESS (spec §16)
--   minutes_since_last_loss recovers the elapsed time from the SAME Redis
--   TTLs losingCloseCooldownReason() already reads (no new key): <15min
--   comes from the any-symbol post-loss settle key, 15-60min (INTRADAY only)
--   from this symbol+direction's own SL cooldown key. Null when neither TTL
--   is alive (either no recent loss, or the loss is more than an hour old,
--   or belongs to a different symbol/direction than either key tracks) —
--   the frozen "39 setups, 4 buckets" study in the gate's own docstring can
--   now be re-run on live data as this column populates.
--
-- OI-WALL FRESHNESS (spec §20)
--   room_check_oi_age_seconds is the age of the chain-fetch timestamp the
--   OI-wall levels roomToTarget() filtered by, at the moment it ran.
--   OI_WALL_MIN_STRENGTH_PCT and roomToTarget()'s own filtering are
--   untouched; this is surfaced as a new OI_WALL_FRESHNESS row in
--   gate_diagnostics (PASS/STALE, logged, never enforced — see
--   gate-diagnostics.ts), not as a new refusal branch.
-- ============================================================

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS contract_tradeable BOOLEAN;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS contract_refusal_reason TEXT;
ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS contract_validation_checks JSONB NOT NULL DEFAULT '{}';

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS opening_environment VARCHAR(24)
  CHECK (opening_environment IN ('OPENING_BREAKOUT', 'OPENING_REVERSAL', 'OPENING_RANGE', 'HIGH_VOLATILITY_CHOP', 'LOW_VOLATILITY_CHOP'));

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS minutes_since_last_loss INTEGER;

ALTER TABLE decision_snapshots ADD COLUMN IF NOT EXISTS room_check_oi_age_seconds INTEGER;

CREATE INDEX IF NOT EXISTS idx_decision_contract_untradeable ON decision_snapshots(time DESC) WHERE contract_tradeable = FALSE;
CREATE INDEX IF NOT EXISTS idx_decision_opening_environment ON decision_snapshots(opening_environment, time DESC) WHERE opening_environment IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decision_minutes_since_loss ON decision_snapshots(minutes_since_last_loss) WHERE minutes_since_last_loss IS NOT NULL;

-- gate_diagnostics.status was CHECK-constrained to PASS/FAIL/NOT_EVALUATED;
-- OI_WALL_FRESHNESS also needs STALE. Widening an existing CHECK, not adding
-- a new table or touching how any row already there is interpreted.
ALTER TABLE gate_diagnostics DROP CONSTRAINT IF EXISTS gate_diagnostics_status_check;
ALTER TABLE gate_diagnostics ADD CONSTRAINT gate_diagnostics_status_check CHECK (status IN ('PASS', 'FAIL', 'NOT_EVALUATED', 'STALE'));
