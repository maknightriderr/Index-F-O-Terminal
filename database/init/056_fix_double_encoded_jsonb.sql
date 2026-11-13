-- 13 Nov 2026: repair jsonb values stored as JSON strings (double-encoded) by the fresh-start store before the
-- ::text::jsonb fix: a value whose jsonb type is 'string' but whose text is a JSON object / array is replaced by that
-- object / array. Rows already correct are untouched; every statement is idempotent.
UPDATE fresh_paper_positions SET state = (state #>> '{}')::jsonb WHERE jsonb_typeof(state) = 'string' AND left(state #>> '{}', 1) IN ('{', '[');
UPDATE fresh_paper_events SET evidence = (evidence #>> '{}')::jsonb WHERE jsonb_typeof(evidence) = 'string' AND left(evidence #>> '{}', 1) IN ('{', '[');
UPDATE fresh_parent_moves SET evidence = (evidence #>> '{}')::jsonb WHERE jsonb_typeof(evidence) = 'string' AND left(evidence #>> '{}', 1) IN ('{', '[');
UPDATE fresh_candidates SET evidence = (evidence #>> '{}')::jsonb WHERE jsonb_typeof(evidence) = 'string' AND left(evidence #>> '{}', 1) IN ('{', '[');
