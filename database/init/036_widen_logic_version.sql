-- ============================================================
-- 036 — Widen logic_version (2026-10-05 hotfix)
-- ============================================================
-- The live logic stamp now carries every approved version suffix
-- (e.g. 2026-09-29.structure.1+indicator-evidence.1+location-evidence.1
-- +rr-display-only.1+parent-identity.1 — 99 characters), past the 64 these
-- columns were created with, so decision_snapshots / setup_lifecycle_events /
-- recorder_boots writes failed with "value too long". Widening a VARCHAR is a
-- metadata-only change in Postgres: no rewrite, no data touched, existing
-- values unchanged; re-running it is a no-op.
-- ============================================================

ALTER TABLE decision_snapshots ALTER COLUMN logic_version TYPE VARCHAR(200);
ALTER TABLE setup_lifecycle_events ALTER COLUMN logic_version TYPE VARCHAR(200);
ALTER TABLE recorder_boots ALTER COLUMN logic_version TYPE VARCHAR(200);
