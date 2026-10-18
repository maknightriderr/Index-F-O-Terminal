import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';

// Plain functions, not vi.fn() (a rejected promise from a reset spy surfaced as an unhandled error elsewhere).
let sessionImpl: () => Promise<unknown> = async () => ({ mode: 'ENFORCED', authenticated: false, reason: null });
let signInImpl: (p: string) => Promise<unknown> = async () => ({ mode: 'ENFORCED', token: 't', expiresAt: Date.now() + 60_000 });
const wsCalls: string[] = [];
vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return { ...actual, api: { getSession: () => sessionImpl(), signIn: (p: string) => signInImpl(p) } };
});
vi.mock('@/lib/ws', () => ({ restartMarketSocket: () => wsCalls.push('restart'), stopMarketSocket: () => wsCalls.push('stop') }));
// The checking frame is the shell skeleton; the real shell drags in the whole terminal.
vi.mock('@/components/layout/app-shell', () => ({ ShellSkeleton: () => <div role="status">Loading the terminal</div> }));

const { LoginGate } = await import('../login-gate');
const { SignOutButton } = await import('../sign-out-button');
const { useSessionStore } = await import('../session-store');
const { ApiError } = await import('@/lib/api');
const { SESSION_REQUIRED_EVENT } = await import('@/lib/session');

const Terminal = () => <p>Terminal content</p>;

beforeEach(() => {
  useSessionStore.setState({ status: 'checking', mode: null, reason: null, error: null, submitting: false });
  sessionImpl = async () => ({ mode: 'ENFORCED', authenticated: false, reason: null });
  signInImpl = async () => ({ mode: 'ENFORCED', token: 't', expiresAt: Date.now() + 60_000 });
  wsCalls.length = 0;
});

describe('sign-in gate', () => {
  it('shows only the password form until signed in; nothing behind the gate mounts', async () => {
    render(<LoginGate><Terminal /></LoginGate>);
    expect(await screen.findByLabelText('Terminal password')).toBeInTheDocument();
    expect(screen.queryByText('Terminal content')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('a wrong password says so; the right one opens the terminal and restarts the feed', async () => {
    signInImpl = async (p) => {
      if (p !== 'right') throw new ApiError('That password is not right.', 'WRONG_PASSWORD', 401);
      return { mode: 'ENFORCED', token: 't', expiresAt: Date.now() + 60_000 };
    };
    render(<LoginGate><Terminal /></LoginGate>);
    const input = await screen.findByLabelText('Terminal password');
    fireEvent.change(input, { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not right.');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: 'right' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Terminal content')).toBeInTheDocument();
    expect(wsCalls).toEqual(['restart']);
  });

  it('a 401 later brings the form back with a reason, and stops the feed', async () => {
    sessionImpl = async () => ({ mode: 'ENFORCED', authenticated: true, reason: null });
    render(<LoginGate><Terminal /><SignOutButton /></LoginGate>);
    expect(await screen.findByText('Terminal content')).toBeInTheDocument();
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_REQUIRED_EVENT, { detail: { code: 'AUTH_REQUIRED' } }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session ended. Sign in again.');
    expect(screen.queryByText('Terminal content')).toBeNull();
    expect(wsCalls).toEqual(['stop']);
  });

  it('sign out returns to the form', async () => {
    sessionImpl = async () => ({ mode: 'ENFORCED', authenticated: true, reason: null });
    render(<LoginGate><SignOutButton /></LoginGate>);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Terminal password')).toBeInTheDocument();
  });

  it('a server without a password set is shown as locked, with the reason', async () => {
    sessionImpl = async () => ({ mode: 'MISCONFIGURED', authenticated: false, reason: 'TERMINAL_PASSWORD is not set.' });
    render(<LoginGate><Terminal /></LoginGate>);
    expect(await screen.findByRole('heading', { name: 'The terminal is locked' })).toBeInTheDocument();
    expect(screen.getByText('TERMINAL_PASSWORD is not set.')).toBeInTheDocument();
    expect(screen.queryByText('Terminal content')).toBeNull();
  });

  it('a development server without a password, or one from before sign-in existed (404), opens directly', async () => {
    sessionImpl = async () => ({ mode: 'OPEN_DEV', authenticated: true, reason: null });
    const { unmount } = render(<LoginGate><Terminal /><SignOutButton /></LoginGate>);
    expect(await screen.findByText('Terminal content')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    unmount();
    useSessionStore.setState({ status: 'checking', mode: null });
    sessionImpl = async () => {
      throw new ApiError('Endpoint not found', 'NOT_FOUND', 404);
    };
    render(<LoginGate><Terminal /></LoginGate>);
    expect(await screen.findByText('Terminal content')).toBeInTheDocument();
  });

  it('an unreachable server without a stored session offers a retry', async () => {
    sessionImpl = async () => {
      throw new TypeError('Failed to fetch');
    };
    render(<LoginGate><Terminal /></LoginGate>);
    expect(await screen.findByRole('heading', { name: "Can't reach the server" })).toBeInTheDocument();
    sessionImpl = async () => ({ mode: 'ENFORCED', authenticated: true, reason: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByText('Terminal content')).toBeInTheDocument());
  });
});
