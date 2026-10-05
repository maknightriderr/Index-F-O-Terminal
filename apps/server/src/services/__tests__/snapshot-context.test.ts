// Phase 2: rows written inside a poll carry its snapshot id — only once migration 034 applied.
import { describe, it, expect, vi } from 'vitest';

const ready = new Set<string>();
vi.mock('../ensure-capture-schema.js', () => ({ schemaFileReady: (f: string) => ready.has(f) }));
const { runInSnapshotScope, setScopeSnapshotId, currentSnapshotId, DECISION_RECORDS_MIGRATION } = await import('../snapshot-context.js');

describe('snapshot scope', () => {
  it('tags writes in the poll that persisted a snapshot, and only there', async () => {
    ready.add(DECISION_RECORDS_MIGRATION);
    expect(currentSnapshotId()).toBeNull();
    await runInSnapshotScope(async () => {
      expect(currentSnapshotId()).toBeNull();
      setScopeSnapshotId('11111111-1111-5111-8111-111111111111');
      await Promise.resolve();
      expect(currentSnapshotId()).toBe('11111111-1111-5111-8111-111111111111');
      // A concurrent poll has its own scope.
      await runInSnapshotScope(async () => expect(currentSnapshotId()).toBeNull());
    });
    expect(currentSnapshotId()).toBeNull();
  });

  it('never tags while migration 034 has not applied (the column may not exist)', async () => {
    ready.clear();
    await runInSnapshotScope(async () => {
      setScopeSnapshotId('11111111-1111-5111-8111-111111111111');
      expect(currentSnapshotId()).toBeNull();
    });
  });
});
