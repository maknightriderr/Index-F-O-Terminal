-- Dhan order-flow engine v2, phase 4 (8 Nov 2026): what the paper path decided for each recorded SIGNAL
-- (FILLED, or the adapter / store refusal code). Option paper trades only; the position itself lives in
-- fresh_paper_positions under its DHAN_* strategy tag.
ALTER TABLE dhan_engine_signals ADD COLUMN IF NOT EXISTS paper_decision TEXT;
ALTER TABLE dhan_engine_signals ADD COLUMN IF NOT EXISTS paper_candidate_id TEXT;
