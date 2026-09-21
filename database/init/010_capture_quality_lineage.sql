-- ============================================================
-- CAPTURE QUALITY AND HARD LINEAGE
-- ============================================================
-- Observability, lineage and research-integrity only. No trading rule,
-- threshold, gate, cooldown, circuit breaker or decision ordering is touched.
--
-- Four problems the previous release left, each of which produced a
-- misleading number rather than a wrong one:
--
--   Snapshots were linked to capture runs by MATCHING (timestamp, symbol)
--   in the reporting query. That is a reconstruction, not a lineage, and it
--   silently fails the moment two captures share a second or a run records a
--   marginally different instant. A snapshot must carry the identity of the
--   run that wrote it.
--
--   A zero was being read as "missing" by inference. A numeric zero is not
--   universally missing — a far-OTM gamma legitimately rounds toward zero —
--   so validity has to be stated at write time rather than guessed at read
--   time.
--
--   The interpreted value overwrote the raw one. Once `nullIfZero` turned a
--   0 into NULL there was no record of what the broker or model had actually
--   returned, so the persistence layer's own behaviour became unauditable.
--
--   Greeks were recorded as "locally solved" with no model identity. A
--   replay cannot reproduce a Greek it cannot attribute to a specific model
--   and a specific set of inputs.
-- ============================================================

-- ============================================================
-- HARD LINEAGE
-- ============================================================
-- The run that wrote this row, carried on the row itself. Nullable because
-- rows written before this column existed genuinely have no run, and
-- back-filling a guess would turn an honest gap into a false claim.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS capture_run_id UUID;
ALTER TABLE futures_snapshots ADD COLUMN IF NOT EXISTS capture_run_id UUID;
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS capture_run_id UUID;
ALTER TABLE market_ticks ADD COLUMN IF NOT EXISTS capture_run_id UUID;

CREATE INDEX IF NOT EXISTS idx_oi_capture_run ON oi_snapshots(capture_run_id);
CREATE INDEX IF NOT EXISTS idx_futures_capture_run ON futures_snapshots(capture_run_id);

-- ============================================================
-- CAPTURE QUALITY VERSION
-- ============================================================
-- Which persistence contract wrote this row.
--
--   LEGACY_ZERO_MAPPING  an absent quote or model failure was stored as 0
--   NULL_PRESERVING_V1   absence is stored as NULL, validity stated explicitly
--
-- This exists so the research population can be stated rather than inferred.
-- The previous report suggested legacy zero rows would "age out" of the
-- window; they will not, because they are retained research data and the
-- retention horizon is 400 days. Splitting the population by the contract
-- that produced it is the honest alternative to waiting.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS capture_quality_version VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_oi_quality_version ON oi_snapshots(capture_quality_version, time DESC);

-- ============================================================
-- EXPLICIT VALIDITY
-- ============================================================
-- Stated at write time by the code that saw the raw value, not inferred at
-- read time from whether a number happens to equal zero.
--
-- The distinction matters in both directions: a far-OTM gamma of 0.00000001
-- is a real measurement that rounds to zero in storage, and a delta of
-- exactly 0 from a model that was handed no price is not a measurement at
-- all. Only the writer knows which it was looking at.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS quote_available BOOLEAN;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS depth_available BOOLEAN;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS iv_available BOOLEAN;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS greeks_available BOOLEAN;
-- greeks_valid is the research predicate. usable_greek = greeks_valid, never
-- `greek <> 0`.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS greeks_valid BOOLEAN;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS validity_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_oi_greeks_valid ON oi_snapshots(greeks_valid, time DESC);

-- ============================================================
-- RAW VERSUS INTERPRETED
-- ============================================================
-- Exactly what the chain leg carried before the persistence layer touched
-- it. The scalar columns hold the interpreted value; this holds the original,
-- so the interpretation itself is auditable rather than lossy.
--
-- JSONB rather than a raw_* column per field: the set of values worth
-- preserving will grow, and adding a column each time is how a wide table
-- becomes unmaintainable. Nothing queries inside it on a hot path.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS raw_values JSONB;

-- ============================================================
-- GREEK MODEL PROVENANCE
-- ============================================================
-- Every captured Greek so far is model output, not a broker observation. A
-- replay that cannot name the model and its inputs cannot reproduce the
-- number, and a Greek that cannot be reproduced is not evidence.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS greeks_model_name VARCHAR(48);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS greeks_model_version VARCHAR(16);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS greeks_calculated_at TIMESTAMPTZ;
-- The inputs the model was handed. Without these the output is a number with
-- no derivation.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS model_spot DECIMAL(12,2);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS model_option_price DECIMAL(12,2);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS model_iv_input DECIMAL(10,6);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS model_rate DECIMAL(8,6);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS model_time_to_expiry DECIMAL(12,8);

CREATE INDEX IF NOT EXISTS idx_oi_greeks_model ON oi_snapshots(greeks_model_name, greeks_model_version);
