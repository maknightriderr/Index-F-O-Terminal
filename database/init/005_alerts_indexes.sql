-- ============================================================
-- ALERTS TABLE — MISSING INDEXES
-- ============================================================
-- The only query against this table (GET /api/alerts) sorts by
-- created_at and, as of the alert-digest rework, also filters by
-- alert_type/severity — none of which the original schema indexed
-- (its one index, on (user_id, triggered), doesn't match this access
-- pattern since user_id is never actually populated). Without this,
-- every request is a full table scan + sort.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_type_created_at ON alerts (alert_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_severity_created_at ON alerts (severity, created_at DESC);
