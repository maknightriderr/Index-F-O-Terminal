-- ============================================================
-- 044 — Paper execution ledger (LEDGER-1.0, 2026-10-23) — measurement only
-- ============================================================
-- One row per observed quote of a paper trade: ENTRY (the quote the entry was
-- decided on), EXIT (the quote when the exit fired) and MARK (at most one a
-- minute while open, from quotes the monitor already receives). Beside the
-- OFFICIAL paper price (assigned_fill, under fill_policy) it keeps a SIMULATED
-- quote-based estimate (sim_fill: ask entry / bid exit / target only when the
-- bid reached it), labelled by sim_quality. Nothing here is read by a
-- decision, and the official trade rows (signals) are never rewritten.
-- ============================================================

CREATE TABLE IF NOT EXISTS paper_execution_observations (
  id                   BIGSERIAL PRIMARY KEY,
  signal_id            UUID        NOT NULL,
  event                VARCHAR(8)  NOT NULL,   -- ENTRY | EXIT | MARK
  observed_at          TIMESTAMPTZ NOT NULL,   -- when this server received the quote
  exchange_at          TIMESTAMPTZ,            -- when the exchange published it (broker-supplied)
  last_trade_at        TIMESTAMPTZ,
  quote_age_ms         INTEGER,                -- observed_at - exchange_at, null when unknown
  quote_source         VARCHAR(10) NOT NULL,   -- CHAIN | TICK | BACKFILL
  feed_state           VARCHAR(20),            -- tick feed freshness (TICK only)
  symbol               VARCHAR(50) NOT NULL,
  exchange             VARCHAR(10) NOT NULL,
  mode                 VARCHAR(12) NOT NULL,
  token                VARCHAR(32),
  ltp                  NUMERIC,
  bid                  NUMERIC,
  ask                  NUMERIC,
  bid_qty              BIGINT,
  ask_qty              BIGINT,
  underlying           NUMERIC,
  order_type           VARCHAR(20) NOT NULL,   -- ENTRY_MARKETABLE | LIMIT_TARGET | STOP_MARKET | MARKET_EXIT | NONE
  close_reason         VARCHAR(32),
  original_entry       NUMERIC,
  original_stop        NUMERIC,
  current_stop         NUMERIC,
  target               NUMERIC,
  assigned_fill        NUMERIC,                -- the official paper price on the trade row (entry or exit)
  fill_policy          VARCHAR(40) NOT NULL,   -- MID_AT_DECISION | TARGET_LIMIT_MIN_LTP_TARGET | OBSERVED_LTP | NONE
  fill_policy_version  VARCHAR(12) NOT NULL,
  sim_fill             NUMERIC,                -- SIMULATED estimate, not a fill
  sim_basis            VARCHAR(28) NOT NULL,   -- ASK | BID | TARGET_LIMIT_BID_REACHED | NONE
  sim_quality          VARCHAR(24) NOT NULL,   -- OK | NO_QUOTE | ONE_SIDED | STALE | AGE_UNKNOWN | SIZE_* | LIMIT_NOT_EXECUTABLE | NOT_APPLICABLE
  paper_quantity       INTEGER,                -- configured paper sizing (positionSize), when recorded
  lot_size             INTEGER,
  risk_budget_inr      NUMERIC,
  capital_inr          NUMERIC,
  ledger_version       VARCHAR(12) NOT NULL,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_id, event, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_peo_signal ON paper_execution_observations (signal_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_peo_observed ON paper_execution_observations (observed_at);
