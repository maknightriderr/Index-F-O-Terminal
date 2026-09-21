-- ============================================================
-- CONTRACT GENERATIONS
-- ============================================================
-- Observability and research-integrity only. No trading rule, threshold,
-- gate, ordering or parameter is touched by anything in this file.
--
-- The previous release reported two capture populations when the data
-- contains three. Rows written between the null-preserving cutover and the
-- validity-column rollout preserve absence correctly but carry no validity
-- flag, no provenance and no model identity — they are neither legacy nor
-- fully contracted, and labelling all 1,066 of them NULL_PRESERVING_V1
-- implied 984 rows had metadata they do not have.
--
-- The generations are DERIVED, never assigned by renaming: from the
-- presence of the persisted fields themselves, falling back to immutable
-- cutover milestones for rows that predate those fields. Every row can say
-- which generation it belongs to and WHY.
-- ============================================================

-- Stamped on every row written from here on, so a future reader never has to
-- infer the generation at all. Nullable because rows written before this
-- column existed genuinely have no stamp, and back-filling one would be a
-- claim rather than a record.
ALTER TABLE oi_snapshots ADD COLUMN IF NOT EXISTS contract_generation VARCHAR(40);

CREATE INDEX IF NOT EXISTS idx_oi_contract_generation
  ON oi_snapshots(contract_generation, time DESC);

-- ============================================================
-- SEPARATE CUTOVER MILESTONES
-- ============================================================
-- Four independent transitions that happened to land close together and
-- are NOT the same event. Folding them into one "post-instrumentation"
-- concept is what allowed a row to be described as belonging to a contract
-- whose columns it does not carry.
--
--   capture_lineage_cutover_at     capture_run_id began being written
--   data_quality_cutover_at        absence stopped being stored as zero
--   validity_contract_cutover_at   greeks_valid and friends began being written
--   greek_provenance_cutover_at    model name, version and inputs began being written
--
-- They live in research_milestones, which is already write-once: the
-- INSERT ... ON CONFLICT DO NOTHING pattern means the first boot after a
-- transition records it and every boot afterwards leaves it alone. A
-- milestone that moved on restart would be worse than none.
--
-- No schema change is needed for them — this comment documents the
-- contract, and ensure-capture-schema.ts writes the rows.
