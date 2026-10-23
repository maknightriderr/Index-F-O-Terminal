/** A downgrade to a binary without all arm-version readers requires BOTH ledgers to be drained. */
export interface ExperimentRollbackRow {
  id: string;
  arm: string;
  arm_version: string;
  official_status: string | null;
  sim_status: string | null;
}

export function experimentRollbackBlockers(rows: readonly ExperimentRollbackRow[]): ExperimentRollbackRow[] {
  // Unknown/missing statuses fail closed. Official closure alone is insufficient: the simulated exit may still wait for a quote.
  return rows.filter((p) => p.official_status !== 'CLOSED' || (p.sim_status !== 'CLOSED' && p.sim_status !== 'NOT_OPENED'));
}
