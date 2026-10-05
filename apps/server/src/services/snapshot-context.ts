import { AsyncLocalStorage } from 'node:async_hooks';
import { schemaFileReady } from './ensure-capture-schema.js';

/**
 * THE DECISION SNAPSHOT SCOPE
 *
 * One bias poll is one async call tree (buildMarketBias → computeMarketBias →
 * engines → writers). When that poll persists a SignalDecisionSnapshot, every
 * setup_events row and paper trade (signals) written later in the same tree
 * carries its snapshot id — without threading a parameter through the dozens
 * of writer call sites. Same mechanism as the decision clock.
 *
 * A row is only tagged once migration 034 applied cleanly at boot (the
 * snapshot_id columns exist): the writers are fire-and-forget and must never
 * fail because the column is missing.
 */

interface SnapshotScope {
  snapshotId: string | null;
}

const storage = new AsyncLocalStorage<SnapshotScope>();

export const DECISION_RECORDS_MIGRATION = '034_decision_records.sql';

/** Runs `fn` in a fresh snapshot scope (no snapshot until setScopeSnapshotId). */
export function runInSnapshotScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ snapshotId: null }, fn);
}

/** Tags the rest of the current scope with a persisted snapshot. No-op outside a scope. */
export function setScopeSnapshotId(snapshotId: string | null): void {
  const scope = storage.getStore();
  if (scope) scope.snapshotId = snapshotId;
}

/** The persisted snapshot the current write belongs to, or null (none, outside a poll, or the column not ready). */
export function currentSnapshotId(): string | null {
  const id = storage.getStore()?.snapshotId ?? null;
  return id != null && schemaFileReady(DECISION_RECORDS_MIGRATION) ? id : null;
}
