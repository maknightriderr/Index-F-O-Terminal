// ============================================================
// DHAN SESSION (2026-10-21)
// ============================================================
// A Dhan access token lasts 24 hours. The one pasted into DHAN_ACCESS_TOKEN on
// 20 Oct ~13:00 IST expired on 21 Oct ~13:00, and the order-flow feed went back
// to TOKEN_REJECTED until someone pasted a new one. This keeps the session
// alive on its own, data only (no order API is ever called):
//
//   TOTP   DHAN_PIN + DHAN_TOTP_SECRET set (TOTP enabled on Dhan Web): a fresh
//          token from auth.dhan.co/app/generateAccessToken whenever none is
//          valid or the current one has under REFRESH_BEFORE_MS left, the same
//          way the Angel One login works. Survives any outage or restart.
//   RENEW  only DHAN_ACCESS_TOKEN: renewed through /v2/RenewToken while it is
//          still active (an expired token cannot be renewed: paste a new one).
//
// The newest token is kept in Redis until it expires, so a restart picks up a
// renewed token rather than the (older) one in the Railway variable. Tokens,
// the PIN and TOTP codes are never logged: the generate call carries them in
// its URL, so only error messages are.
// ============================================================

import axios from 'axios';
import { authenticator } from 'otplib';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

export const DHAN_GENERATE_TOKEN_URL = 'https://auth.dhan.co/app/generateAccessToken';
export const DHAN_RENEW_TOKEN_URL = 'https://api.dhan.co/v2/RenewToken';
const SESSION_KEY = 'dhan:session';
/** Refresh when less than this is left on the token. */
export const REFRESH_BEFORE_MS = 2 * 60 * 60_000;
/** After a failed refresh, wait this long before the next attempt. */
const REFRESH_RETRY_MS = 10 * 60_000;

export type DhanAutoRenew = 'TOTP' | 'RENEW' | 'NONE';

export interface DhanEnv {
  clientId: string | null;
  envToken: string | null;
  pin: string | null;
  totpSecret: string | null;
}

export function dhanEnv(env: NodeJS.ProcessEnv = process.env): DhanEnv {
  const v = (k: string) => env[k]?.trim() || null;
  return { clientId: v('DHAN_CLIENT_ID'), envToken: v('DHAN_ACCESS_TOKEN'), pin: v('DHAN_PIN'), totpSecret: v('DHAN_TOTP_SECRET') };
}

/** Configured: a client id plus either a token or the TOTP login. */
export function dhanConfigured(e: DhanEnv = dhanEnv()): boolean {
  return e.clientId != null && (e.envToken != null || (e.pin != null && e.totpSecret != null));
}

export function autoRenewOf(e: DhanEnv): DhanAutoRenew {
  return e.pin && e.totpSecret ? 'TOTP' : e.envToken ? 'RENEW' : 'NONE';
}

/** Pure: a JWT's expiry (epoch ms), or null when it does not say. */
export function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

interface Held {
  token: string;
  expiresAt: number | null;
  source: 'ENV' | 'RENEWED' | 'TOTP';
}

/** Pure: the token to use among those held, the one that lasts longest, never one already expired. */
export function bestToken(candidates: readonly (Held | null)[], now: number): Held | null {
  const live = candidates.filter((c): c is Held => c != null && (c.expiresAt == null || c.expiresAt > now));
  return live.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0] ?? null;
}

/** Pure: whether to refresh now. */
export function refreshDue(held: Held | null, now: number, rejected: boolean): boolean {
  return held == null || rejected || (held.expiresAt != null && held.expiresAt - now < REFRESH_BEFORE_MS);
}

const state = {
  clientId: null as string | null,
  loaded: false,
  held: null as Held | null,
  rejected: false,
  retryAt: 0,
  lastRefreshAt: null as number | null,
  lastError: null as string | null,
};

/** The session to call Dhan with right now, or null. Synchronous: refreshed by ensureDhanSession. */
export function dhanSession(): { clientId: string; accessToken: string } | null {
  const { clientId } = state;
  return clientId && state.held && !state.rejected ? { clientId, accessToken: state.held.token } : null;
}

/** Dhan answered 401/403 with the current token: drop it, so the next ensure refreshes (TOTP) or reports it. */
export function markDhanTokenRejected(token: string): void {
  if (state.held?.token !== token) return; // already replaced
  state.rejected = true;
  state.retryAt = 0;
}

export function dhanSessionStatus() {
  const e = dhanEnv();
  return {
    autoRenew: autoRenewOf(e),
    source: state.held?.source ?? null,
    expiresAt: state.held?.expiresAt ?? null,
    rejected: state.rejected,
    lastRefreshAt: state.lastRefreshAt,
    lastError: state.lastError,
  };
}

async function generateByTotp(e: DhanEnv): Promise<Held> {
  const params = { dhanClientId: e.clientId!, pin: e.pin!, totp: authenticator.generate(e.totpSecret!) };
  const res = await axios.post(DHAN_GENERATE_TOKEN_URL, null, { params, timeout: 15_000 });
  const token = res.data?.accessToken;
  if (typeof token !== 'string' || !token) throw new Error(`no accessToken in the response (${res.data?.message ?? res.data?.errorMessage ?? 'no message'})`);
  return { token, expiresAt: jwtExpiry(token) ?? (Date.parse(res.data?.expiryTime ?? '') || null), source: 'TOTP' };
}

async function renew(e: DhanEnv, held: Held): Promise<Held> {
  const res = await axios.get(DHAN_RENEW_TOKEN_URL, { headers: { 'access-token': held.token, dhanClientId: e.clientId!, Accept: 'application/json' }, timeout: 15_000 });
  const token = res.data?.accessToken ?? res.data?.token ?? res.data?.data?.accessToken;
  if (typeof token !== 'string' || !token) throw new Error('no accessToken in the RenewToken response');
  return { token, expiresAt: jwtExpiry(token) ?? (Date.parse(res.data?.expiryTime ?? '') || null), source: 'RENEWED' };
}

async function load(e: DhanEnv, now: number): Promise<void> {
  let stored: Held | null = null;
  try {
    const raw = await redis.get(SESSION_KEY);
    stored = raw ? (JSON.parse(raw) as Held) : null;
  } catch {
    stored = null;
  }
  const fromEnv: Held | null = e.envToken ? { token: e.envToken, expiresAt: jwtExpiry(e.envToken), source: 'ENV' } : null;
  state.held = bestToken([stored, fromEnv], now);
  state.loaded = true;
}

async function persist(held: Held, now: number): Promise<void> {
  const ttlSeconds = Math.max(60, Math.round(((held.expiresAt ?? now + 24 * 3600_000) - now) / 1000));
  await redis.set(SESSION_KEY, JSON.stringify(held), 'EX', ttlSeconds).catch(() => undefined);
}

/** Keeps a valid token on hand: loads the newest, refreshes it when due. Never throws. */
export async function ensureDhanSession(now = Date.now(), e: DhanEnv = dhanEnv()): Promise<void> {
  if (!dhanConfigured(e)) return;
  state.clientId = e.clientId;
  if (!state.loaded) await load(e, now);
  if (state.held && state.held.expiresAt != null && state.held.expiresAt <= now) state.held = null;
  if (!refreshDue(state.held, now, state.rejected) || now < state.retryAt) return;

  const mode = autoRenewOf(e);
  // An expired or rejected token cannot be renewed; only the TOTP login recovers from it.
  if (mode !== 'TOTP' && (state.held == null || state.rejected)) {
    state.lastError = 'The Dhan access token has expired or was rejected: paste a new DHAN_ACCESS_TOKEN, or set DHAN_PIN and DHAN_TOTP_SECRET for automatic login.';
    return;
  }
  try {
    const next = mode === 'TOTP' ? await generateByTotp(e) : await renew(e, state.held!);
    state.held = next;
    state.rejected = false;
    state.lastRefreshAt = now;
    state.lastError = null;
    await persist(next, now);
    logger.info({ source: next.source, expiresAt: next.expiresAt ? new Date(next.expiresAt).toISOString() : null }, 'Dhan session: token refreshed');
  } catch (err: any) {
    state.retryAt = now + REFRESH_RETRY_MS;
    state.lastError = `Dhan token ${mode === 'TOTP' ? 'login' : 'renewal'} failed: ${err?.response?.status ?? ''} ${err?.message ?? err}`.trim();
    logger.warn({ error: err?.message, status: err?.response?.status ?? null, mode }, 'Dhan session: token refresh failed — retrying in 10 minutes');
  }
}

/** Tests only. */
export function resetDhanSession(): void {
  Object.assign(state, { clientId: null, loaded: false, held: null, rejected: false, retryAt: 0, lastRefreshAt: null, lastError: null });
}
