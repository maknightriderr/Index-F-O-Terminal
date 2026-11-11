-- Order flow: checkpoint of the OPEN 15-minute bar (11 Nov 2026, audit F-08).
--   A restart used to lose the trades of the bar the process stopped in (9 Nov: seven in-session deploys, seven lost
--   bars and a session VWAP marked incomplete). The store now saves each contract's open-bar events once a minute and
--   at shutdown; the next process restores them when it starts inside the same bar shortly after. One row per
--   contract, overwritten in place (never grows). Same encoding as order_flow_events. Idempotent.
CREATE TABLE IF NOT EXISTS order_flow_open_bars (
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  instrument VARCHAR(80),
  bar_time TIMESTAMPTZ NOT NULL,
  encoding VARCHAR(20) NOT NULL,
  events BYTEA NOT NULL,
  saved_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, exchange)
);
