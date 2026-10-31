CREATE TABLE IF NOT EXISTS fresh_calendar_snapshots(id text PRIMARY KEY,source text NOT NULL,observed_at timestamptz NOT NULL,valid_until timestamptz NOT NULL,evidence jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS fresh_calendar_snapshots_recent ON fresh_calendar_snapshots(observed_at DESC);
