-- 18 Nov 2026: read-only API keys (owner: Claude reads reports without a 7-day session token).
-- Only the SHA-256 of a key is stored; the key itself is shown once, in the terminal, to the signed-in owner.
-- A key opens GET requests only, never a write, never /api/session or /api/auth. Revoking sets revoked_at.
CREATE TABLE IF NOT EXISTS api_readonly_keys (
  id          bigserial PRIMARY KEY,
  sha256      text        NOT NULL UNIQUE,
  label       text        NOT NULL DEFAULT 'claude',
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_readonly_keys_active ON api_readonly_keys(sha256) WHERE revoked_at IS NULL;
