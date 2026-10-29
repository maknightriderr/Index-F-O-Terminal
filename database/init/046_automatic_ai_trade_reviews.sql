-- Isolated post-trade research. Nothing in trading reads these tables.
CREATE TABLE IF NOT EXISTS ai_review_versions (
  version VARCHAR(40) PRIMARY KEY,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_trade_reviews (
  signal_id UUID NOT NULL,
  version VARCHAR(40) NOT NULL,
  fingerprint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  source_version TEXT NOT NULL,
  logic_version TEXT NOT NULL,
  exchange TEXT NOT NULL,
  mode TEXT NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','RETRY','COMPLETE')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner UUID,
  lease_until TIMESTAMPTZ,
  evidence JSONB,
  review JSONB,
  provider TEXT,
  model TEXT,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (signal_id, version)
);
CREATE INDEX IF NOT EXISTS idx_ai_reviews_due ON ai_trade_reviews (next_attempt_at, closed_at DESC) WHERE status <> 'COMPLETE';
CREATE INDEX IF NOT EXISTS idx_ai_reviews_completed ON ai_trade_reviews (completed_at DESC) WHERE status = 'COMPLETE';
