// ============================================================
// SETUP MINT LOCK
// ============================================================
// A symbol's sticky setup is minted by whichever caller of buildMarketBias
// gets there first: a browser poll, the market scanner, the trade-setup
// monitor's bias recheck, and now the background evaluator. Each read the
// Redis slot, found it empty, built a setup and wrote it — so two callers
// landing in the same second could both mint: two `signals` rows, two TAKE
// decision rows, two Telegram messages, and whichever wrote last owned the
// slot.
//
// mintOnce() puts a Redis SET NX lock around the setup-creating branch:
//
//   - the winner re-reads the slot INSIDE the lock (another caller may have
//     minted and released between this caller's first read and now) and
//     only mints when it is still empty of a new setup;
//   - a loser does not mint; it polls the slot for the winner's setup and
//     returns that, or gives up for this poll after `waitMs`;
//   - the lock is released only by its owner (token compare) and carries a
//     TTL, so a crashed winner cannot wedge the slot.
//
// If Redis cannot take the lock at all the mint goes ahead unlocked and the
// error is logged: with Redis down there is no shared slot to protect, and
// refusing every setup would be a worse failure than the old behaviour.
// ============================================================

import { randomUUID } from 'node:crypto';

export interface MintLockStore {
  /** SET key value EX ttl NX — true when this caller now holds the key. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export type MintOutcome<T, E> =
  | { kind: 'MINTED'; value: T; locked: boolean }
  | { kind: 'EXISTING'; value: E }
  | { kind: 'BUSY' };

export interface MintOnceOptions<T, E> {
  store: MintLockStore;
  lockKey: string;
  ttlSeconds: number;
  /** How long a caller that lost the race waits for the winner's setup. */
  waitMs: number;
  pollMs?: number;
  /** A setup minted by SOMEONE ELSE since this caller first read the slot, or null. */
  readExisting: () => Promise<E | null>;
  mint: () => Promise<T>;
  onError?: (stage: 'ACQUIRE' | 'RELEASE', err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export const mintLockKey = (exchange: string, underlying: string, mode: string): string =>
  `trade_setup_mint_lock:${exchange}:${underlying}:${mode}`;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function mintOnce<T, E>(opts: MintOnceOptions<T, E>): Promise<MintOutcome<T, E>> {
  const sleep = opts.sleep ?? defaultSleep;
  const token = randomUUID();

  let acquired: boolean;
  try {
    acquired = await opts.store.setNx(opts.lockKey, token, Math.max(1, Math.round(opts.ttlSeconds)));
  } catch (err) {
    opts.onError?.('ACQUIRE', err);
    return { kind: 'MINTED', value: await opts.mint(), locked: false };
  }

  if (acquired) {
    try {
      const existing = await opts.readExisting();
      if (existing != null) return { kind: 'EXISTING', value: existing };
      return { kind: 'MINTED', value: await opts.mint(), locked: true };
    } finally {
      try {
        if ((await opts.store.get(opts.lockKey)) === token) await opts.store.del(opts.lockKey);
      } catch (err) {
        opts.onError?.('RELEASE', err);
      }
    }
  }

  const pollMs = Math.max(10, opts.pollMs ?? 250);
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  for (;;) {
    const existing = await opts.readExisting();
    if (existing != null) return { kind: 'EXISTING', value: existing };
    if (Date.now() >= deadline) return { kind: 'BUSY' };
    await sleep(pollMs);
  }
}
