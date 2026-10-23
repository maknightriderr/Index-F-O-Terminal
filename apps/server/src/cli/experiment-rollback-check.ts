// Read-only readiness snapshot. Pause the RUNNING server's experiment entries before invoking this.
import postgres from 'postgres';
import { experimentRollbackBlockers, type ExperimentRollbackRow } from '../services/experiment-rollback.js';

if (!process.env.DATABASE_URL || (process.env.EXPERIMENT_NEW_ENTRIES ?? '').toLowerCase() !== 'off') {
  console.error('Requires an explicit DATABASE_URL and EXPERIMENT_NEW_ENTRIES=off. First pause entries on the running server; this CLI does not change server settings.');
  process.exitCode = 2;
} else {
  const db = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try {
    const rows = await db.begin('read only', async (tx) =>
      tx<ExperimentRollbackRow[]>`SELECT id, arm, arm_version, official_status, sim_status FROM experiment_positions`
    );
    const blockers = experimentRollbackBlockers(rows);
    console.log(JSON.stringify({ ready: blockers.length === 0, checked: rows.length, blockers }, null, 2));
    process.exitCode = blockers.length === 0 ? 0 : 1;
  } catch {
    console.error('Unable to verify experiment state; rollback is NOT cleared. Check database access/schema.');
    process.exitCode = 2;
  } finally {
    await db.end({ timeout: 5 });
  }
}
