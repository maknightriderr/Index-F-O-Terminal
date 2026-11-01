-- Research metadata only; no entry/exit/account tables are modified.
CREATE TABLE IF NOT EXISTS fresh_research_protocols (
 id text PRIMARY KEY, digest text NOT NULL, body jsonb NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fresh_research_runs (
 protocol_id text NOT NULL REFERENCES fresh_research_protocols(id),
 cohort text NOT NULL, dataset_digest text NOT NULL,
 inspected_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL CHECK(status IN ('RUNNING','COMPLETE','FAILED')),
 result jsonb,
 PRIMARY KEY(protocol_id,cohort)
);
CREATE OR REPLACE FUNCTION fresh_research_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Frozen research protocol cannot be updated or deleted';
END $$;
DROP TRIGGER IF EXISTS fresh_research_protocol_immutable ON fresh_research_protocols;
CREATE TRIGGER fresh_research_protocol_immutable BEFORE UPDATE OR DELETE ON fresh_research_protocols
FOR EACH ROW EXECUTE FUNCTION fresh_research_immutable();
CREATE OR REPLACE FUNCTION fresh_research_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research inspection receipts cannot be deleted'; END IF;
 IF OLD.status<>'RUNNING' OR NEW.status NOT IN ('COMPLETE','FAILED') OR
 NEW.protocol_id IS DISTINCT FROM OLD.protocol_id OR NEW.cohort IS DISTINCT FROM OLD.cohort OR
 NEW.dataset_digest IS DISTINCT FROM OLD.dataset_digest OR NEW.inspected_at IS DISTINCT FROM OLD.inspected_at
 THEN RAISE EXCEPTION 'Research inspection receipt is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fresh_research_run_immutable ON fresh_research_runs;
CREATE TRIGGER fresh_research_run_immutable BEFORE UPDATE OR DELETE ON fresh_research_runs
FOR EACH ROW EXECUTE FUNCTION fresh_research_run_guard();
