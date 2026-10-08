-- ============================================================
-- 039 — Bar anomalies (2026-10-09) — data quality, measurement only
-- ============================================================
-- A broker bar recorded as anomalous when the engines read it — first kind:
-- SESSION_CLOSE_BAR (the session's final 15m bar trading far outside the
-- session's range, later replaced by the broker; see bar-anomaly.ts). Grading
-- flattens such bars; the live engines are unchanged by it.
-- Additive and idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS bar_anomalies (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  bar_time TIMESTAMPTZ NOT NULL,
  kind VARCHAR(30) NOT NULL,
  high NUMERIC,
  low NUMERIC,
  close NUMERIC,
  session_high NUMERIC,
  session_low NUMERIC,
  median_range NUMERIC,
  reason TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, exchange, bar_time, kind)
);

CREATE INDEX IF NOT EXISTS idx_bar_anomalies_time ON bar_anomalies (bar_time DESC);
