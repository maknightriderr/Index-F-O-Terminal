-- ============================================================
-- OPPORTUNITY_CENSUS: drop sessions censused before recording covered them
-- ============================================================
-- setup_events started recording on 30 Sep 2026 at 18:50 IST, after the
-- NSE/BSE close. The first census pass still classified that day's index
-- sessions, and with no setup_events rows every opportunity read
-- NEVER_DETECTED. The job now skips any session that opened before recording
-- started (opportunity-census-job.ts, RECORDING_START_MS); this removes the
-- rows written before that guard existed.
--
-- Idempotent: ensured at boot, and no session on or before 30 Sep 2026 can be
-- censused again.
-- ============================================================

DELETE FROM opportunity_census WHERE session_date <= DATE '2026-09-30';
DELETE FROM opportunity_census_daily WHERE session_date <= DATE '2026-09-30';
