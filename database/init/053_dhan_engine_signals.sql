-- Dhan order-flow engine v2, phase 3 (7 Nov 2026): SHADOW signals of setups A-D and the expiry-gamma module.
-- One row per strategy / side / contract / decision bar for every evaluation whose setup conditions were met
-- (status SIGNAL, or NO_TRADE with the gate / score / no-trade reasons). Nothing here opens a position.
CREATE TABLE IF NOT EXISTS dhan_engine_signals (
  id BIGSERIAL PRIMARY KEY,
  strategy TEXT NOT NULL,
  side TEXT NOT NULL,
  symbol TEXT NOT NULL,
  instrument TEXT,
  exchange TEXT,
  bar_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  score INTEGER,
  eligibility TEXT,
  entry NUMERIC,
  stop_loss NUMERIC,
  target NUMERIC,
  rr NUMERIC,
  session_window TEXT,
  regime TEXT,
  checks JSONB,
  gates JSONB,
  no_trade JSONB,
  evidence JSONB,
  version TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strategy, side, symbol, bar_time)
);
CREATE INDEX IF NOT EXISTS dhan_engine_signals_bar_time_idx ON dhan_engine_signals (bar_time);
