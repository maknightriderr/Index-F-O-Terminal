-- ============================================================
-- FII/DII DAILY CASH ACTIVITY HISTORY
-- ============================================================
-- One row per NSE-published trading day (see apps/server/src/
-- services/fii-dii.ts) — upserted on `date` so a re-fetch of the
-- same day's figure (NSE sometimes revises a provisional number)
-- updates in place rather than duplicating.
-- ============================================================

CREATE TABLE IF NOT EXISTS fii_dii_history (
  id SERIAL PRIMARY KEY,
  date VARCHAR(20) UNIQUE NOT NULL,
  fii_buy DECIMAL(14,2) NOT NULL,
  fii_sell DECIMAL(14,2) NOT NULL,
  fii_net DECIMAL(14,2) NOT NULL,
  dii_buy DECIMAL(14,2) NOT NULL,
  dii_sell DECIMAL(14,2) NOT NULL,
  dii_net DECIMAL(14,2) NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fii_dii_history_fetched_at ON fii_dii_history (fetched_at DESC);
