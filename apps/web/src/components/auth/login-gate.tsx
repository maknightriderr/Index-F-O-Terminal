'use client';

// ============================================================
// SIGN-IN GATE (audit 2026-10-18, SEC-1)
// ============================================================
// Nothing behind the gate mounts (no API call, no /ws connection) until the
// server says this browser may use the terminal. A 401 from any call later
// brings the form back (lib/session.ts SESSION_REQUIRED_EVENT).
// ============================================================

import React, { useEffect, useState } from 'react';
import { ShellSkeleton } from '@/components/layout/app-shell';
import { SESSION_REQUIRED_EVENT } from '@/lib/session';
import { useSessionStore } from './session-store';

export function LoginGate({ children }: { children: React.ReactNode }) {
  const status = useSessionStore((s) => s.status);
  const check = useSessionStore((s) => s.check);
  const required = useSessionStore((s) => s.required);

  useEffect(() => {
    const onRequired = (e: Event) => required((e as CustomEvent<{ code?: string }>).detail?.code ?? 'AUTH_REQUIRED');
    window.addEventListener(SESSION_REQUIRED_EVENT, onRequired);
    void check();
    return () => window.removeEventListener(SESSION_REQUIRED_EVENT, onRequired);
  }, [check, required]);

  if (status === 'open') return <>{children}</>;
  if (status === 'checking') return <ShellSkeleton />;
  return <SignInScreen />;
}

const card = 'w-full max-w-sm space-y-5 rounded-xl border border-[var(--border-primary)] bg-[var(--surface-card)] p-6 shadow-lg';
const primaryButton =
  'inline-flex min-h-10 w-full items-center justify-center rounded-md bg-[var(--accent-indigo)] px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]';

function SignInScreen() {
  const { status, reason, error, submitting, signIn, check } = useSessionStore();
  const [password, setPassword] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await signIn(password)) setPassword('');
  };

  return (
    <main className="flex min-h-[100dvh] w-full items-center justify-center bg-[var(--bg-primary)] px-4 py-8 text-[var(--text-primary)]">
      {status === 'locked' ? (
        <section className={card} aria-labelledby="gate-title">
          <Heading id="gate-title" title="The terminal is locked" />
          <p className="text-sm text-[var(--text-secondary)]">{reason}</p>
          <p className="text-sm text-[var(--text-secondary)]">
            Set <code className="font-mono text-[var(--text-primary)]">TERMINAL_PASSWORD</code> on the backend service, redeploy, then check again.
          </p>
          <button type="button" className={primaryButton} onClick={() => void check()}>
            Check again
          </button>
        </section>
      ) : status === 'unreachable' ? (
        <section className={card} aria-labelledby="gate-title">
          <Heading id="gate-title" title="Can't reach the server" />
          <p role="alert" className="text-sm text-[var(--text-secondary)]">
            {error}
          </p>
          <button type="button" className={primaryButton} onClick={() => void check()}>
            Try again
          </button>
        </section>
      ) : (
        <form className={card} onSubmit={submit} aria-labelledby="gate-title">
          <Heading id="gate-title" title="Sign in" />
          <div className="space-y-2">
            <label htmlFor="terminal-password" className="block text-sm font-medium">
              Terminal password
            </label>
            <input
              id="terminal-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'gate-error' : undefined}
              className="min-h-10 w-full rounded-md border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-3 text-sm text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
            />
          </div>
          {error && (
            <p id="gate-error" role="alert" className="text-sm text-[var(--status-bad)]">
              {error}
            </p>
          )}
          <button type="submit" className={primaryButton} disabled={submitting || password.length === 0}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="text-xs text-[var(--text-muted)]">Paper trading only. You stay signed in on this browser for 7 days.</p>
        </form>
      )}
    </main>
  );
}

function Heading({ id, title }: { id: string; title: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">F&amp;O Terminal</p>
      <h1 id={id} className="text-xl font-semibold">
        {title}
      </h1>
    </div>
  );
}
