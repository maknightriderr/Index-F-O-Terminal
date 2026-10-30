// Fresh-start retirement: no env/default/recovery path may reactivate old entries.
// Existing plans, exit monitoring and historical readers remain enabled.
export const LEGACY_NEW_ENTRIES_ENABLED = false;
export function legacyEntriesAllowed(): boolean { return LEGACY_NEW_ENTRIES_ENABLED; }
export const LEGACY_ENTRY_REASON = 'Legacy new entries retired for the approved fresh start; existing paper positions retain their original exit plans.';
