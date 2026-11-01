-- Experiment event codes such as SIM_STRUCTURE_INVALIDATED_PENDING (33 chars) overflowed VARCHAR(32)
-- and the whole persist failed, losing held experiment exit evidence. Widening is idempotent.
ALTER TABLE IF EXISTS experiment_events ALTER COLUMN event TYPE VARCHAR(64);
