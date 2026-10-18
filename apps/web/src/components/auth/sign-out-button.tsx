'use client';

import React from 'react';
import { useSessionStore } from './session-store';

/** Top-bar control: shown only when the server requires a sign-in. */
export function SignOutButton() {
  const mode = useSessionStore((s) => s.mode);
  const signOut = useSessionStore((s) => s.signOut);
  if (mode !== 'ENFORCED') return null;
  return (
    <button
      type="button"
      onClick={signOut}
      aria-label="Sign out"
      title="Sign out of the terminal on this browser"
      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-card-alt)] hover:text-[var(--text-primary)]"
    >
      <span className="hidden sm:inline">Sign out</span>
      <span className="sm:hidden" aria-hidden="true">
        ⎋
      </span>
    </button>
  );
}
