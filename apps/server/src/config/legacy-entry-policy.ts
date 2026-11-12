// Retired 31 Oct for the fresh start; re-enabled 12 Nov (owner: "enable every disabled strategy"), paper only, running
// beside the fresh-start engine in its own book (a legacy position no longer blocks fresh-start entries).
export const LEGACY_NEW_ENTRIES_ENABLED = true;
export function legacyEntriesAllowed(): boolean { return LEGACY_NEW_ENTRIES_ENABLED; }
export const LEGACY_ENTRY_REASON = 'Legacy new entries are off; existing paper positions retain their original exit plans.';
