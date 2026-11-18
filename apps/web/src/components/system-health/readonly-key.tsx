'use client';

// ============================================================
// READ-ONLY API KEY (18 Nov): the owner creates the key Claude reads reports with
// ============================================================
// The key is shown ONCE, right after it is created, with a copy button; the server keeps only its hash. It opens GET
// requests only (never a trade, a setting or a sign-in), and creating a new one or revoking stops the old one at once.
// ============================================================

import React, { useEffect, useState } from 'react';
import { Section } from '@/components/ui/card';
import { ActionButton } from '@/components/ui/controls';
import { api } from '@/lib/api';
import { formatIstDateTime } from '@/lib/format';

interface KeyStatus { active: boolean; createdAt: number | null; lastUsedAt: number | null }

export function ReadonlyKeySection() {
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.getReadonlyKeyStatus().then(setStatus).catch((e) => setError(e instanceof Error ? e.message : 'unavailable'));
  useEffect(() => { void load(); }, []);

  const create = async () => {
    if (status?.active && !window.confirm('A new key stops the current one. Continue?')) return;
    setBusy(true); setError(null); setCopied(false);
    try { const r = await api.createReadonlyKey(); setFresh(r.key); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  const revoke = async () => {
    if (!window.confirm('Stop the read-only key now?')) return;
    setBusy(true); setError(null);
    try { await api.revokeReadonlyKey(); setFresh(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'failed'); } finally { setBusy(false); }
  };
  const copy = async () => {
    if (!fresh) return;
    try { await navigator.clipboard.writeText(fresh); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <Section title="Read-only key for Claude" subtitle="Lets Claude read reports, trades and status. It cannot place trades, change settings or sign in. Shown once when created; create a new one or stop it at any time.">
      <div className="flex flex-col gap-3 text-[13px]">
        <div>
          {status == null ? 'Checking…' : status.active
            ? <>Active since {formatIstDateTime(status.createdAt!)} IST{status.lastUsedAt ? ` · last used ${formatIstDateTime(status.lastUsedAt)} IST` : ' · not used yet'}</>
            : 'No key yet.'}
        </div>
        {fresh && (
          <div className="flex flex-col gap-2">
            <div className="text-[var(--text-muted)]">Copy it now and paste it into Claude&apos;s secure form. It will not be shown again.</div>
            <input readOnly value={fresh} aria-label="New read-only key" className="w-full rounded border border-[var(--border-primary)] bg-transparent px-2 py-2 font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
            <div><ActionButton variant="primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy key'}</ActionButton></div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <ActionButton variant={status?.active ? 'default' : 'primary'} onClick={create} disabled={busy}>{status?.active ? 'Create a new key' : 'Create key'}</ActionButton>
          {status?.active && <ActionButton onClick={revoke} disabled={busy}>Stop key</ActionButton>}
        </div>
        {error && <div role="alert" style={{ color: 'var(--status-warn)' }}>{error}</div>}
      </div>
    </Section>
  );
}
