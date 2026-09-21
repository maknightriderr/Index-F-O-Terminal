-- ============================================================
-- HISTORICAL MARKET-STATE CAPTURE
-- ============================================================
-- The look-ahead audit found that oi_snapshots, futures_snapshots,
-- pcr_history, market_ticks and ohlcv were all full schema with zero
-- writers. Nothing had ever inserted a row. That is why no historical
-- option chain exists, why the chain-dependent half of the engine cannot
-- be replayed at a past instant, and why four of the validation
-- comparisons had no data to report.
--
-- This file does not replace those tables — they already carry the right
-- columns, the right indexes and (on a TimescaleDB host) hypertables.
-- It adds the few columns the raw-observation requirement needs on top of
-- them, and creates the one genuinely new table: the decision snapshot.
--
-- SIZING. A chain snapshot is ~21 strikes either side of ATM, two sides,
-- so ~42 rows per symbol per capture. At a 15-minute cadence over a
-- 6.25-hour session that is 25 captures a day: ~1,050 rows per symbol per
-- day. Across the ~12 symbols the engine actually reads, ~12,600 rows a
-- day, call it 2 MB. A year is under 1 GB, against a 5 GB volume — and
-- 007 adds retention so it never reaches that. The cadence is deliberately
-- NOT per-tick: the decision engine polls on minutes, not ticks, so
-- per-tick chain capture would multiply the row count by two orders of
-- magnitude to record state no decision was ever made from.
-- ============================================================

-- --- Raw quote depth on the option legs ---
-- oi_snapshots already carries ltp, oi, change_oi, volume, iv and the
-- Greeks. The spec asks for the raw two-sided market as well, because a
-- premium mid-point is a derived number and the audit's whole point is
-- that derived numbers are not enough to reconstruct a decision.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS bid DECIMAL(12,2);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS ask DECIMAL(12,2);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS bid_qty BIGINT;
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS ask_qty BIGINT;
-- Which underlying price this chain was observed against. Without it a
-- historical chain cannot be re-centred, because "ATM" is meaningless
-- without the spot it was ATM to.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS spot_price DECIMAL(12,2);
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS moneyness VARCHAR(4);
-- Whether the Greeks came from the broker or were solved locally. A replay
-- that cannot tell the two apart will treat a modelled delta as an
-- observed one.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS greeks_source VARCHAR(12);

-- --- Raw quote depth on the futures leg ---
ALTER TABLE futures_snapshots ADD COLUMN IF NOT EXISTS bid DECIMAL(12,2);
ALTER TABLE futures_snapshots ADD COLUMN IF NOT EXISTS ask DECIMAL(12,2);
ALTER TABLE futures_snapshots ADD COLUMN IF NOT EXISTS ltp DECIMAL(12,2);

-- --- Underlying observations ---
-- market_ticks carries ltp/OHLC/volume/oi/bid/ask already. It needs the
-- symbol (it is keyed by token, which is not human-queryable) and the two
-- derived series the engine actually decides on, so a replay does not have
-- to recompute them from candles and hope it matches.
ALTER TABLE market_ticks ADD COLUMN IF NOT EXISTS symbol VARCHAR(50);
ALTER TABLE market_ticks ADD COLUMN IF NOT EXISTS bid_qty BIGINT;
ALTER TABLE market_ticks ADD COLUMN IF NOT EXISTS ask_qty BIGINT;
ALTER TABLE market_ticks ADD COLUMN IF NOT EXISTS vwap DECIMAL(12,2);
ALTER TABLE market_ticks ADD COLUMN IF NOT EXISTS atr DECIMAL(12,4);

CREATE INDEX IF NOT EXISTS idx_market_ticks_symbol ON market_ticks(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_oi_snapshots_capture ON oi_snapshots(symbol, expiry, time DESC);

-- --- Positioning ---
-- pcr_history already carries the four PCR readings. Add the raw OI
-- aggregates they are computed from: the spec is explicit that derived
-- indicators alone are not enough.
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS call_oi BIGINT;
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS put_oi BIGINT;
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS call_oi_change BIGINT;
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS put_oi_change BIGINT;
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS call_wall DECIMAL(12,2);
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS put_wall DECIMAL(12,2);
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS max_pain DECIMAL(12,2);
ALTER TABLE pcr_history ADD COLUMN IF NOT EXISTS spot_price DECIMAL(12,2);

-- ============================================================
-- DECISION SNAPSHOTS
-- ============================================================
-- One row every time the engine evaluates a potential trade, whether it
-- took it or refused it. The refusals are the point: the engine has been
-- getting steadily stricter, and until now there was no way to answer
-- whether that protected capital or merely prevented trading.
--
-- Scalar columns are the ones worth filtering and grouping on. Everything
-- else goes in the JSONB blocks, which keeps the table from growing a
-- column every time a new feature is recorded — and keeps the raw
-- observation alongside the derived read, which is the requirement.
--
-- The outcome_* columns start NULL and are filled in later by the
-- missed-winner audit, once enough time has passed to know what the market
-- actually did. They are the only columns in this table written after the
-- fact, and nothing in the decision path ever reads them.
-- ============================================================
CREATE TABLE IF NOT EXISTS decision_snapshots (
  decision_id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  -- When the engine decided. In production this is now; in a replay it is
  -- the instant the engine was told to believe it was.
  time TIMESTAMPTZ NOT NULL,
  -- The market data's own timestamp, which can lag the decision.
  market_time TIMESTAMPTZ,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  mode VARCHAR(20) NOT NULL,
  expiry DATE,

  decision VARCHAR(10) NOT NULL,      -- TAKE | REFUSE
  reason_code VARCHAR(40),            -- the NoTradeCode taxonomy
  reason TEXT,

  -- Market read
  regime VARCHAR(40),
  bias VARCHAR(20),
  confidence DECIMAL(5,2),
  vix DECIMAL(8,2),
  pcr DECIMAL(8,4),

  -- Underlying
  underlying_price DECIMAL(12,2),
  atr DECIMAL(12,4),
  vwap DECIMAL(12,2),

  -- The instrument the trade would be expressed through
  option_symbol VARCHAR(80),
  strike DECIMAL(12,2),
  option_type VARCHAR(2),
  premium DECIMAL(12,2),
  bid DECIMAL(12,2),
  ask DECIMAL(12,2),
  spread_pct DECIMAL(8,4),
  iv DECIMAL(8,4),
  delta DECIMAL(8,6),
  gamma DECIMAL(10,8),
  theta DECIMAL(10,4),
  vega DECIMAL(10,4),
  option_volume BIGINT,
  option_oi BIGINT,
  option_quality_score INTEGER,
  option_quality_grade VARCHAR(16),

  -- The shadow layers
  location_score INTEGER,
  room_available_atr DECIMAL(8,4),
  room_required_atr DECIMAL(8,4),
  room_ratio DECIMAL(8,4),

  -- Risk, as it would have been sized
  stop_loss DECIMAL(12,2),
  target DECIMAL(12,2),
  risk_reward DECIMAL(8,4),
  position_lots INTEGER,

  -- Raw blocks
  underlying JSONB NOT NULL DEFAULT '{}',
  market JSONB NOT NULL DEFAULT '{}',
  futures JSONB NOT NULL DEFAULT '{}',
  option JSONB NOT NULL DEFAULT '{}',
  location JSONB NOT NULL DEFAULT '{}',
  room JSONB NOT NULL DEFAULT '{}',
  risk JSONB NOT NULL DEFAULT '{}',

  -- Filled in by the missed-winner audit, never read by the engine
  outcome_evaluated_at TIMESTAMPTZ,
  outcome_class VARCHAR(20),          -- GOOD_REJECTION | MISSED_WINNER | MISSED_LOSER | NEUTRAL | TAKEN | UNKNOWN
  outcome_mfe_atr DECIMAL(8,4),
  outcome_mae_atr DECIMAL(8,4),
  outcome_hit_target BOOLEAN,
  outcome_hit_stop BOOLEAN,
  outcome_reached_025r BOOLEAN,
  outcome_reached_05r BOOLEAN,
  outcome_reached_1r BOOLEAN,
  outcome_r DECIMAL(8,4),
  outcome_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_decision_time ON decision_snapshots(time DESC);
CREATE INDEX IF NOT EXISTS idx_decision_symbol ON decision_snapshots(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_decision_reason ON decision_snapshots(reason_code, time DESC);
-- The missed-winner sweep's working query: refusals old enough to grade
-- that nothing has graded yet.
CREATE INDEX IF NOT EXISTS idx_decision_pending ON decision_snapshots(time)
  WHERE outcome_evaluated_at IS NULL;

-- ============================================================
-- DATA QUALITY EVENTS
-- ============================================================
-- The engine must not decide from stale or incomplete data, and until now
-- there was nothing recording when it might have. One row per detected
-- problem, so a bad decision can be traced back to the feed that caused it
-- rather than being blamed on the logic.
-- ============================================================
CREATE TABLE IF NOT EXISTS data_quality_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(50),
  exchange VARCHAR(10),
  issue VARCHAR(40) NOT NULL,        -- STALE_TIMESTAMP | MISSING_LTP | ABNORMAL_SPREAD | ...
  severity VARCHAR(10) NOT NULL,     -- WARN | SEVERE
  detail TEXT,
  context JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_dq_time ON data_quality_events(time DESC);
CREATE INDEX IF NOT EXISTS idx_dq_issue ON data_quality_events(issue, time DESC);
