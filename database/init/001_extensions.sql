-- ============================================================
-- F&O TERMINAL — DATABASE INITIALIZATION
-- ============================================================
-- Enables TimescaleDB extension and creates initial schema.
-- This runs automatically when the PostgreSQL container starts.
-- ============================================================

-- Enable TimescaleDB
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
