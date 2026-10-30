-- Serializes the single terminal-paper portfolio across account-day rollovers and worker replicas.
CREATE TABLE IF NOT EXISTS fresh_paper_portfolio (id text PRIMARY KEY CHECK(id='terminal-paper'));
INSERT INTO fresh_paper_portfolio(id) VALUES('terminal-paper') ON CONFLICT DO NOTHING;
-- New cohort only. No legacy table is changed or backfilled.
CREATE TABLE IF NOT EXISTS fresh_paper_accounts (
  id text PRIMARY KEY,
  session text NOT NULL,
  version text NOT NULL,
  capital double precision NOT NULL CHECK (capital > 0),
  realized_net double precision NOT NULL DEFAULT 0,
  consecutive_losses integer NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS fresh_candidates (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES fresh_paper_accounts(id),
  at timestamptz NOT NULL,
  version text NOT NULL,
  strategy text NOT NULL,
  parent_id text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('CANDIDATE','REFUSED','FILLED')),
  code text,
  evidence jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS fresh_candidates_recent ON fresh_candidates(at DESC);
CREATE TABLE IF NOT EXISTS fresh_parent_moves (
  account_id text NOT NULL REFERENCES fresh_paper_accounts(id),
  id text NOT NULL,
  instrument text NOT NULL,
  direction text NOT NULL,
  session text NOT NULL,
  origin bigint NOT NULL,
  ended boolean NOT NULL DEFAULT false,
  traded boolean NOT NULL DEFAULT false,
  evidence jsonb NOT NULL,
  PRIMARY KEY(account_id,id)
);
CREATE TABLE IF NOT EXISTS fresh_paper_positions (
  id text PRIMARY KEY REFERENCES fresh_candidates(id),
  account_id text NOT NULL REFERENCES fresh_paper_accounts(id),
  version text NOT NULL,
  strategy text NOT NULL,
  instrument text NOT NULL,
  risk_group text NOT NULL,
  parent_id text NOT NULL,
  session text NOT NULL,
  status text NOT NULL CHECK(status IN ('OPEN','EXIT_PENDING','CLOSED')),
  revision integer NOT NULL DEFAULT 0,
  reserved_risk double precision NOT NULL CHECK(reserved_risk > 0),
  reserved_premium double precision NOT NULL CHECK(reserved_premium > 0),
  opened_at timestamptz NOT NULL,
  closed_at timestamptz,
  net_pnl double precision,
  state jsonb NOT NULL,
  CHECK((status='CLOSED') = (closed_at IS NOT NULL AND net_pnl IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fresh_one_open_underlying ON fresh_paper_positions(account_id,instrument) WHERE status<>'CLOSED';
CREATE UNIQUE INDEX IF NOT EXISTS fresh_one_open_group ON fresh_paper_positions(account_id,risk_group) WHERE status<>'CLOSED';
CREATE UNIQUE INDEX IF NOT EXISTS fresh_one_parent_fill ON fresh_paper_positions(account_id,parent_id);
CREATE INDEX IF NOT EXISTS fresh_positions_recent ON fresh_paper_positions(opened_at DESC);
CREATE TABLE IF NOT EXISTS fresh_paper_events (
  id text PRIMARY KEY,
  position_id text NOT NULL REFERENCES fresh_paper_positions(id),
  revision integer NOT NULL,
  at timestamptz NOT NULL,
  kind text NOT NULL,
  evidence jsonb NOT NULL,
  UNIQUE(position_id,revision)
);
CREATE TABLE IF NOT EXISTS fresh_paper_reviews (
  position_id text PRIMARY KEY REFERENCES fresh_paper_positions(id),
  version text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','COMPLETE')),
  attempts integer NOT NULL DEFAULT 0,
  lease text,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response jsonb,
  completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS fresh_account_day_cohort ON fresh_paper_accounts(session,version);
