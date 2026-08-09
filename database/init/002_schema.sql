-- ============================================================
-- F&O TERMINAL — CORE TABLES
-- ============================================================
-- Plain PostgreSQL tables — no TimescaleDB-specific DDL here so
-- this file runs unmodified on any managed Postgres (Railway,
-- Render, Supabase, Neon, etc). Hypertable/retention/compression/
-- continuous-aggregate upgrades for the time-series tables below
-- live in 003_timescale.sql and are applied best-effort only
-- where the TimescaleDB extension is actually available.
-- ============================================================

-- --- Users ---
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- --- Instruments Master ---
CREATE TABLE IF NOT EXISTS instruments (
  id SERIAL PRIMARY KEY,
  token VARCHAR(20) NOT NULL,
  symbol VARCHAR(100) NOT NULL,
  name VARCHAR(200),
  exchange VARCHAR(10) NOT NULL,
  segment VARCHAR(10) NOT NULL,
  instrument_type VARCHAR(20),
  underlying VARCHAR(50),
  strike DECIMAL(12,2),
  option_type VARCHAR(2),
  expiry DATE,
  lot_size INTEGER DEFAULT 1,
  tick_size DECIMAL(8,4) DEFAULT 0.05,
  is_fno BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instruments_token ON instruments(token, exchange);
CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments(symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_underlying ON instruments(underlying);
CREATE INDEX IF NOT EXISTS idx_instruments_fno ON instruments(is_fno) WHERE is_fno = true;
CREATE INDEX IF NOT EXISTS idx_instruments_expiry ON instruments(expiry) WHERE expiry IS NOT NULL;

-- --- Watchlists ---
CREATE TABLE IF NOT EXISTS watchlists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  id SERIAL PRIMARY KEY,
  watchlist_id INTEGER REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL DEFAULT 'NSE',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_items_watchlist ON watchlist_items(watchlist_id);

-- ============================================================
-- TIME-SERIES TABLES
-- ============================================================
-- Plain tables here (no create_hypertable). On a TimescaleDB-
-- backed Postgres, 003_timescale.sql upgrades these to hypertables
-- with retention/compression. On plain Postgres they just work as
-- regular tables — no partitioning, no automatic retention, but
-- fully functional.
-- ============================================================

-- --- Market Ticks ---
CREATE TABLE IF NOT EXISTS market_ticks (
  time TIMESTAMPTZ NOT NULL,
  token VARCHAR(20) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  ltp DECIMAL(12,2),
  open_price DECIMAL(12,2),
  high DECIMAL(12,2),
  low DECIMAL(12,2),
  close_price DECIMAL(12,2),
  volume BIGINT,
  oi BIGINT,
  bid DECIMAL(12,2),
  ask DECIMAL(12,2)
);

CREATE INDEX IF NOT EXISTS idx_market_ticks_token ON market_ticks(token, time DESC);

-- --- OHLCV Candles ---
CREATE TABLE IF NOT EXISTS ohlcv (
  time TIMESTAMPTZ NOT NULL,
  token VARCHAR(20) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  interval VARCHAR(20) NOT NULL,
  open_price DECIMAL(12,2),
  high DECIMAL(12,2),
  low DECIMAL(12,2),
  close_price DECIMAL(12,2),
  volume BIGINT
);

CREATE INDEX IF NOT EXISTS idx_ohlcv_token_interval ON ohlcv(token, interval, time DESC);

-- --- OI Snapshots ---
CREATE TABLE IF NOT EXISTS oi_snapshots (
  time TIMESTAMPTZ NOT NULL,
  token VARCHAR(20) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  instrument_type VARCHAR(20),
  strike DECIMAL(12,2),
  option_type VARCHAR(2),
  expiry DATE,
  oi BIGINT,
  change_oi BIGINT,
  volume BIGINT,
  ltp DECIMAL(12,2),
  iv DECIMAL(8,4),
  delta DECIMAL(8,6),
  gamma DECIMAL(8,6),
  theta DECIMAL(8,4),
  vega DECIMAL(8,4)
);

CREATE INDEX IF NOT EXISTS idx_oi_symbol ON oi_snapshots(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_oi_strike ON oi_snapshots(symbol, strike, option_type, time DESC);

-- --- Futures Snapshots ---
CREATE TABLE IF NOT EXISTS futures_snapshots (
  time TIMESTAMPTZ NOT NULL,
  token VARCHAR(20) NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(10) NOT NULL,
  expiry DATE,
  spot_price DECIMAL(12,2),
  futures_price DECIMAL(12,2),
  basis DECIMAL(12,2),
  premium_discount DECIMAL(8,4),
  volume BIGINT,
  oi BIGINT,
  change_oi BIGINT,
  interpretation VARCHAR(30)
);

CREATE INDEX IF NOT EXISTS idx_futures_symbol ON futures_snapshots(symbol, time DESC);

-- --- IV History ---
CREATE TABLE IF NOT EXISTS iv_history (
  time TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  expiry DATE,
  atm_iv DECIMAL(8,4),
  ce_iv DECIMAL(8,4),
  pe_iv DECIMAL(8,4),
  iv_skew DECIMAL(8,4),
  iv_rank DECIMAL(5,2),
  iv_percentile DECIMAL(5,2)
);

CREATE INDEX IF NOT EXISTS idx_iv_symbol ON iv_history(symbol, time DESC);

-- --- PCR History ---
CREATE TABLE IF NOT EXISTS pcr_history (
  time TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  expiry DATE,
  oi_pcr DECIMAL(8,4),
  volume_pcr DECIMAL(8,4),
  change_oi_pcr DECIMAL(8,4),
  near_atm_pcr DECIMAL(8,4)
);

CREATE INDEX IF NOT EXISTS idx_pcr_symbol ON pcr_history(symbol, time DESC);

-- --- Signals ---
CREATE TABLE IF NOT EXISTS signals (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  time TIMESTAMPTZ NOT NULL,
  symbol VARCHAR(50) NOT NULL,
  signal_type VARCHAR(50) NOT NULL,
  direction VARCHAR(20),
  confidence DECIMAL(5,2),
  bullish_prob DECIMAL(5,2),
  bearish_prob DECIMAL(5,2),
  neutral_prob DECIMAL(5,2),
  inputs JSONB NOT NULL DEFAULT '{}',
  reasoning TEXT,
  market_regime VARCHAR(50),
  intelligence_score INTEGER,
  -- Forward performance (calculated later)
  fwd_15m_return DECIMAL(8,4),
  fwd_30m_return DECIMAL(8,4),
  fwd_1h_return DECIMAL(8,4),
  fwd_1d_return DECIMAL(8,4),
  max_favorable_excursion DECIMAL(8,4),
  max_adverse_excursion DECIMAL(8,4)
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, time DESC);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(signal_type, time DESC);

-- --- Alerts ---
CREATE TABLE IF NOT EXISTS alerts (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  symbol VARCHAR(50) NOT NULL,
  alert_type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,
  severity VARCHAR(20) DEFAULT 'INFO',
  channels JSONB DEFAULT '["TERMINAL"]',
  condition JSONB,
  triggered BOOLEAN DEFAULT false,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id, triggered);

-- --- Market Events ---
CREATE TABLE IF NOT EXISTS market_events (
  id SERIAL PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  event_date DATE NOT NULL,
  description TEXT,
  impact VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_symbol ON market_events(symbol, event_date);

-- --- System Health ---
CREATE TABLE IF NOT EXISTS system_health (
  time TIMESTAMPTZ NOT NULL,
  service VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  latency_ms INTEGER,
  error_count INTEGER DEFAULT 0,
  details JSONB
);

-- ============================================================
-- DEFAULT DATA
-- ============================================================

-- Create default user
INSERT INTO users (email, password_hash, settings) VALUES
  ('admin@terminal.local', '', '{"theme": "dark", "defaultExchange": "NSE"}')
ON CONFLICT (email) DO NOTHING;

-- Create default watchlist
INSERT INTO watchlists (user_id, name, sort_order)
SELECT id, 'My Watchlist', 0 FROM users WHERE email = 'admin@terminal.local'
ON CONFLICT DO NOTHING;
