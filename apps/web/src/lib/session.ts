// ============================================================
// TERMINAL SESSION (audit 2026-10-18, SEC-1)
// ============================================================
// The server locks every /api route behind a session token from
// POST /api/session (server: lib/api-auth.ts). The token lives in this tab's
// memory and in localStorage (so a reload stays signed in for its 7 days);
// every API call and the /ws upgrade read it from here. A 401 from the API
// clears it and fires SESSION_REQUIRED_EVENT, which puts the sign-in screen back.
// ============================================================

const STORAGE_KEY = 'fno.terminal-session.v1';
export const SESSION_REQUIRED_EVENT = 'terminal-auth-required';

export interface StoredSession {
  token: string;
  expiresAt: number;
}

let current: StoredSession | null | undefined;

function read(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    return typeof s?.token === 'string' && typeof s?.expiresAt === 'number' ? s : null;
  } catch {
    return null;
  }
}

/** The token to send, or null (none, or expired). */
export function sessionToken(now = Date.now()): string | null {
  if (current === undefined) current = typeof window === 'undefined' ? null : read();
  if (current && current.expiresAt <= now) clearSession();
  return current?.token ?? null;
}

export function saveSession(s: StoredSession): void {
  current = s;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage blocked (private window): the session lasts for this tab only.
  }
}

export function clearSession(): void {
  current = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored.
  }
}

/** The API answered "sign in" (401) or "locked" (503 AUTH_NOT_CONFIGURED): drop the token and show the sign-in screen. */
export function signalSessionRequired(code: string): void {
  if (code === 'AUTH_REQUIRED') clearSession();
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SESSION_REQUIRED_EVENT, { detail: { code } }));
}

/** Test seam: forget the in-memory copy so the next read goes back to storage. */
export function resetSessionCacheForTests(): void {
  current = undefined;
}
