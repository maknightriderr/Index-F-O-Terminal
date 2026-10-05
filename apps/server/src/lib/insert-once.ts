// Idempotent inserts for tables guarded by immutability RULEs (migrations 034 /
// 035). Postgres refuses `INSERT … ON CONFLICT` on any table that has INSERT
// or UPDATE rules, so the duplicate is detected instead: a unique violation
// (23505) means the row is already stored — the same outcome as DO NOTHING.

const UNIQUE_VIOLATION = '23505';

/** Runs the insert; an already-stored row (unique violation) is EXISTS, never an error. */
export async function insertOnce(query: PromiseLike<unknown>): Promise<'INSERTED' | 'EXISTS'> {
  try {
    await query;
    return 'INSERTED';
  } catch (err: any) {
    if (err?.code === UNIQUE_VIOLATION) return 'EXISTS';
    throw err;
  }
}
