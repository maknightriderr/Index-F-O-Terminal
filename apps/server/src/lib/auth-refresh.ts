// The scheduled Angel One re-authentication (every 8 h), with retry and an
// alert (Phase 5). A refresh that fails is retried with exponential backoff;
// when every attempt fails an operational alert goes out. After a success the
// caller re-connects the tick feed (new feed token) — every token is then
// RECOVERING until its switchover gap is checked.
// Dependencies are injected so the policy is tested without a broker.

export interface AuthAttemptResult {
  success: boolean;
  error?: string;
}

export const AUTH_REFRESH_ATTEMPTS = 4;
export const AUTH_REFRESH_BASE_DELAY_MS = 30_000;

export async function refreshAuthWithRetry(args: {
  attempt: () => Promise<AuthAttemptResult>;
  onSuccess: () => Promise<void>;
  alert: (message: string) => Promise<unknown> | unknown;
  log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void; info?: (o: object, m: string) => void };
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  baseDelayMs?: number;
}): Promise<{ success: boolean; attempts: number; error: string | null }> {
  const attempts = args.attempts ?? AUTH_REFRESH_ATTEMPTS;
  const base = args.baseDelayMs ?? AUTH_REFRESH_BASE_DELAY_MS;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  let lastError: string | null = null;
  for (let k = 1; k <= attempts; k++) {
    try {
      const r = await args.attempt();
      if (r.success) {
        try {
          await args.onSuccess();
        } catch (err: any) {
          args.log.error({ error: err.message }, 'Re-authentication succeeded but the feed reconnect failed');
        }
        args.log.info?.({ attempt: k }, 'Scheduled Angel One re-authentication succeeded');
        return { success: true, attempts: k, error: null };
      }
      lastError = r.error ?? 'unknown error';
    } catch (err: any) {
      lastError = err?.message ?? String(err);
    }
    args.log.warn({ attempt: k, of: attempts, error: lastError }, 'Scheduled Angel One re-authentication failed — retrying');
    if (k < attempts) await sleep(base * 2 ** (k - 1));
  }
  args.log.error({ attempts, error: lastError }, 'Scheduled Angel One re-authentication failed on every attempt');
  await Promise.resolve(args.alert(`⚠️ Angel One re-authentication failed ${attempts} times (${lastError}). Quotes and the tick feed may stop; open paper trades are still checked by REST until the session lapses.`)).catch(() => undefined);
  return { success: false, attempts, error: lastError };
}
