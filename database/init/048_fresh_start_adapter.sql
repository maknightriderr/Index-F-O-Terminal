CREATE TABLE IF NOT EXISTS fresh_evaluations(id text PRIMARY KEY,version text NOT NULL,at timestamptz NOT NULL,instrument text NOT NULL,session text NOT NULL,source_epoch text NOT NULL,input jsonb NOT NULL,result jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS fresh_evaluations_recent ON fresh_evaluations(at DESC);
CREATE TABLE IF NOT EXISTS fresh_adapter_decisions(candidate_id text PRIMARY KEY,version text NOT NULL,at timestamptz NOT NULL,strategy text NOT NULL,code text NOT NULL,evidence jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS fresh_adapter_decisions_recent ON fresh_adapter_decisions(at DESC);
