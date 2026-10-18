'use client';

// ============================================================
// SIGN-IN STATE (audit 2026-10-18, SEC-1)
// ============================================================
// One store for the gate in front of the terminal and the sign-out button.
//   checking   → asking GET /api/session
//   open       → signed in, or a development server without a password
//   signed-out → show the password form
//   locked     → the server has no TERMINAL_PASSWORD (or a weak JWT_SECRET): nobody can sign in until it is set
//   unreachable→ the server did not answer and this browser holds no session
// ============================================================

import { create } from 'zustand';
import { api, ApiError, type TerminalAuthMode } from '@/lib/api';
import { clearSession, sessionToken } from '@/lib/session';
import { restartMarketSocket, stopMarketSocket } from '@/lib/ws';

export type GateStatus = 'checking' | 'open' | 'signed-out' | 'locked' | 'unreachable';

interface SessionState {
  status: GateStatus;
  mode: TerminalAuthMode | null;
  reason: string | null;
  error: string | null;
  submitting: boolean;
  check: () => Promise<void>;
  signIn: (password: string) => Promise<boolean>;
  signOut: () => void;
  /** The API answered 401 AUTH_REQUIRED or 503 AUTH_NOT_CONFIGURED (lib/session.ts SESSION_REQUIRED_EVENT). */
  required: (code: string) => void;
}

const LOCKED_HELP = 'The server has no sign-in configured.';

export const useSessionStore = create<SessionState>((set, get) => ({
  status: 'checking',
  mode: null,
  reason: null,
  error: null,
  submitting: false,

  check: async () => {
    try {
      const s = await api.getSession();
      if (s.mode === 'OPEN_DEV' || s.authenticated) set({ status: 'open', mode: s.mode, reason: null, error: null });
      else if (s.mode === 'MISCONFIGURED') set({ status: 'locked', mode: s.mode, reason: s.reason ?? LOCKED_HELP });
      else {
        clearSession();
        set({ status: 'signed-out', mode: s.mode });
      }
    } catch (err) {
      // A server from before sign-in existed has no /api/session: it is open, as it always was.
      if (err instanceof ApiError && err.status === 404) {
        set({ status: 'open', mode: null, reason: null, error: null });
        return;
      }
      // Not reachable: with a session in hand, open the terminal (its pages show their own errors); without one, offer a retry.
      set(sessionToken() ? { status: 'open', error: null } : { status: 'unreachable', error: 'The server did not answer. Check your connection, then try again.' });
    }
  },

  signIn: async (password) => {
    if (get().submitting) return false;
    set({ submitting: true, error: null });
    try {
      await api.signIn(password);
      set({ status: 'open', mode: 'ENFORCED', submitting: false, error: null });
      restartMarketSocket();
      return true;
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.code === 'WRONG_PASSWORD'
            ? 'That password is not right.'
            : err.message
          : 'The server did not answer. Check your connection, then try again.';
      set({ submitting: false, error: message, ...(err instanceof ApiError && err.code === 'AUTH_NOT_CONFIGURED' ? { status: 'locked' as const, reason: err.message } : {}) });
      return false;
    }
  },

  signOut: () => {
    clearSession();
    stopMarketSocket();
    set({ status: 'signed-out', error: null });
  },

  required: (code) => {
    stopMarketSocket();
    if (code === 'AUTH_NOT_CONFIGURED') set({ status: 'locked', mode: 'MISCONFIGURED', reason: get().reason ?? LOCKED_HELP });
    else set({ status: 'signed-out', error: get().status === 'open' ? 'Your session ended. Sign in again.' : get().error });
  },
}));
