-- ============================================================
-- MILESTONE DERIVATION
-- ============================================================
-- Observability only. No trading behaviour is touched.
--
-- The first milestone recorder wrote "now" for every cutover, which records
-- when the SERVER BOOTED rather than when the contract changed. All four
-- transitions came back reading 19:14:12 — within four milliseconds of each
-- other — when the data-quality cutover actually happened at 16:05 and the
-- lineage cutover around 17:00.
--
-- A milestone that says when the process started is not a milestone. It is
-- immutable and wrong, which is worse than mutable and wrong, because
-- nothing will ever correct it.
--
-- So each cutover is now seeded from EVIDENCE — the earliest row actually
-- carrying the field that transition introduced, or a compiled constant
-- where one exists — and `derivation` records which. Seeded once and frozen
-- thereafter: a row that already carries a derivation is never touched
-- again, so this cannot become a value that drifts on every restart.
-- ============================================================

-- How this milestone's instant was established. NULL marks the naive
-- boot-time rows written before this column existed, which is what lets the
-- one-time correction find them and nothing else.
ALTER TABLE research_milestones ADD COLUMN IF NOT EXISTS derivation TEXT;

-- When the correction ran, so a reader can tell a seeded value from an
-- original one.
ALTER TABLE research_milestones ADD COLUMN IF NOT EXISTS derived_at TIMESTAMPTZ;
