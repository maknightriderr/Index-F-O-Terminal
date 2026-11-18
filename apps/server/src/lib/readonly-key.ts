// ============================================================
// READ-ONLY API KEY (owner, 18 Nov): Claude reads reports without a 7-day session token
// ============================================================
// The signed-in owner creates a key in the terminal (System health); it is shown ONCE and only its SHA-256 is stored
// (database/init/057). A valid key opens GET / HEAD requests under /api only — never a write (403 READ_ONLY_KEY),
// never /api/session or /api/auth. Creating a key revokes the previous one; revoking removes it at once. The hashes are
// held in memory (re-read every minute) so the request gate stays synchronous.
// ============================================================

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const READONLY_KEY_PREFIX = 'fnoro_';
export const READONLY_KEY_REFRESH_MS = 60_000;
/** Paths a read-only key never opens, even for GET (prefix match, lower case). */
export const READONLY_KEY_DENIED_PREFIXES: readonly string[] = ['/api/session', '/api/auth'];

export const hashReadonlyKey = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');
export const looksLikeReadonlyKey = (token: string | null | undefined): token is string => typeof token === 'string' && token.startsWith(READONLY_KEY_PREFIX) && token.length >= READONLY_KEY_PREFIX.length + 40;
export const newReadonlyKey = (): string => `${READONLY_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;

let active = new Set<string>();
/** Replaces the in-memory set of active key hashes. */
export function setActiveReadonlyHashes(hashes: Iterable<string>): void { active = new Set(hashes); }
export function activeReadonlyHashCount(): number { return active.size; }

/** True when `token` is an active read-only key (constant-time against each active hash). Pure over the memory set. */
export function isActiveReadonlyKey(token: string | null | undefined): boolean {
  if (!looksLikeReadonlyKey(token)) return false;
  const h = Buffer.from(hashReadonlyKey(token), 'hex');
  let hit = false;
  for (const a of active) { const b = Buffer.from(a, 'hex'); if (b.length === h.length && timingSafeEqual(b, h)) hit = true; }
  return hit;
}

export type ReadonlyVerdict = 'ALLOW' | 'DENY_WRITE' | 'DENY_PATH';
/** What a VALID read-only key may do on this request. */
export function readonlyKeyVerdict(method: string, path: string): ReadonlyVerdict {
  const m = method.toUpperCase(), p = path.toLowerCase();
  if (READONLY_KEY_DENIED_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`))) return 'DENY_PATH';
  return m === 'GET' || m === 'HEAD' ? 'ALLOW' : 'DENY_WRITE';
}

// ---- Storage (lazy imports keep the pure part above importable without a database) ----

export async function loadReadonlyKeys(): Promise<number> {
  const { sql } = await import('./db.js');
  const rows = await sql<Array<{ sha256: string }>>`SELECT sha256 FROM api_readonly_keys WHERE revoked_at IS NULL`;
  setActiveReadonlyHashes(rows.map((r) => r.sha256));
  return rows.length;
}

/** Creates a key (revoking every earlier one) and returns it — the only time it exists outside the caller's screen. */
export async function createReadonlyKey(): Promise<{ key: string; createdAt: number }> {
  const { sql } = await import('./db.js');
  const key = newReadonlyKey(), hash = hashReadonlyKey(key);
  const [row] = await sql.begin(async (tx: any) => {
    await tx`UPDATE api_readonly_keys SET revoked_at = now() WHERE revoked_at IS NULL`;
    return tx`INSERT INTO api_readonly_keys (sha256) VALUES (${hash}) RETURNING created_at`;
  }) as Array<{ created_at: Date }>;
  setActiveReadonlyHashes([hash]);
  return { key, createdAt: new Date(row.created_at).getTime() };
}

export async function revokeReadonlyKeys(): Promise<number> {
  const { sql } = await import('./db.js');
  const rows = await sql`UPDATE api_readonly_keys SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id`;
  setActiveReadonlyHashes([]);
  return rows.length;
}

export async function readonlyKeyStatus(): Promise<{ active: boolean; createdAt: number | null; lastUsedAt: number | null }> {
  const { sql } = await import('./db.js');
  const [row] = await sql<Array<{ created_at: Date; last_used_at: Date | null }>>`SELECT created_at, last_used_at FROM api_readonly_keys WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  return { active: !!row, createdAt: row ? new Date(row.created_at).getTime() : null, lastUsedAt: row?.last_used_at ? new Date(row.last_used_at).getTime() : null };
}

let lastTouch = 0;
/** Records (at most once a minute) that the key was used, so the owner sees it in the terminal. Never throws. */
export function touchReadonlyKey(token: string, now = Date.now()): void {
  if (now - lastTouch < 60_000) return;
  lastTouch = now;
  void import('./db.js').then(({ sql }) => sql`UPDATE api_readonly_keys SET last_used_at = now() WHERE sha256 = ${hashReadonlyKey(token)} AND revoked_at IS NULL`).catch(() => undefined);
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Loads the active hashes now and every minute (another replica or a revoke elsewhere is picked up). Never throws. */
export function startReadonlyKeyRefresh(log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined): void {
  const run = () => loadReadonlyKeys().catch((err) => log('Read-only key: hashes unavailable (the last set stays)', { error: err?.message }));
  void run();
  if (!timer) { timer = setInterval(run, READONLY_KEY_REFRESH_MS); timer.unref?.(); }
}
