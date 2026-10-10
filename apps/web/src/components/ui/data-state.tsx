'use client';

// ============================================================
// DATA STATE — the same loading / empty / error / stale handling everywhere
// ============================================================
// Every data-driven block states which of these it is in:
//   loading     nothing yet            → skeleton rows (no spinner for data we already have)
//   refreshing  have data, re-fetching → the data stays, a quiet "Updating…" note
//   empty       fetched, nothing there → says why and what would change that
//   error       fetch failed           → says what failed and offers Retry; if older data exists it is kept and marked stale
//   ready       normal
// An unknown value is never replaced by 0 or by sample data.
// ============================================================

import React from 'react';

export type DataStatus = 'loading' | 'refreshing' | 'empty' | 'error' | 'error-with-data' | 'ready';

/** Pure: which state a block is in. */
export function resolveDataStatus(i: { loading: boolean; error: string | null | undefined; hasData: boolean; isEmpty?: boolean }): DataStatus {
  if (i.error && !i.hasData) return 'error';
  if (i.error && i.hasData) return 'error-with-data';
  if (i.loading && !i.hasData) return 'loading';
  if (!i.loading && (!i.hasData || i.isEmpty)) return 'empty';
  if (i.loading && i.hasData) return 'refreshing';
  return i.isEmpty ? 'empty' : 'ready';
}

export function SkeletonRows({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className="space-y-2" data-testid="skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-5 animate-pulse rounded bg-[var(--surface-card-alt)]" style={{ width: `${92 - ((i * 13) % 40)}%` }} />
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--border-secondary)] px-4 py-8 text-center" data-testid="empty-state">
      <p className="text-sm font-medium text-[var(--text-primary)]">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-xl text-sm text-[var(--text-secondary)]">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorNotice({ title, detail, onRetry, tone = 'bad' }: { title: string; detail?: React.ReactNode; onRetry?: () => void; tone?: 'bad' | 'warn' }) {
  const color = tone === 'bad' ? 'border-[var(--status-bad)]/40 bg-[var(--status-bad)]/10' : 'border-[var(--status-warn)]/40 bg-[var(--status-warn)]/10';
  return (
    <div role="alert" className={`flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 ${color}`} data-testid="error-notice">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
        {detail && <p className="mt-0.5 text-sm text-[var(--text-secondary)]">{detail}</p>}
      </div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded-md border border-[var(--border-secondary)] px-3 py-1.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--surface-card-alt)]">
          Retry
        </button>
      )}
    </div>
  );
}

/** A note that the data on screen is not current (older data kept after a failed refresh, or a last-known copy). */
export function StaleNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-md border border-[var(--status-warn)]/40 bg-[var(--status-warn)]/10 px-3 py-1.5 text-sm text-[var(--text-primary)]" data-testid="stale-note">
      <span aria-hidden="true">▲ </span>
      {children}
    </p>
  );
}

export function DataState({
  loading,
  error,
  hasData,
  isEmpty,
  onRetry,
  errorTitle = 'Could not load this data',
  emptyTitle = 'Nothing to show',
  emptyHint,
  staleNote,
  skeletonRows,
  children,
}: {
  loading: boolean;
  error?: string | null;
  hasData: boolean;
  isEmpty?: boolean;
  onRetry?: () => void;
  errorTitle?: string;
  emptyTitle?: string;
  emptyHint?: React.ReactNode;
  /** Shown above the data when it is a last-known / older copy. */
  staleNote?: React.ReactNode;
  skeletonRows?: number;
  children: React.ReactNode;
}) {
  const status = resolveDataStatus({ loading, error, hasData, isEmpty });
  if (status === 'loading') return <SkeletonRows rows={skeletonRows} />;
  if (status === 'error') return <ErrorNotice title={errorTitle} detail={error} onRetry={onRetry} />;
  if (status === 'empty') return <EmptyState title={emptyTitle} hint={emptyHint} />;
  return (
    <div className="space-y-3">
      {status === 'error-with-data' && <ErrorNotice tone="warn" title="Showing the last data received" detail={`The latest refresh failed: ${error}`} onRetry={onRetry} />}
      {staleNote && <StaleNote>{staleNote}</StaleNote>}
      {status === 'refreshing' && (
        <p role="status" aria-live="polite" className="text-xs text-[var(--text-secondary)]">
          Updating…
        </p>
      )}
      {children}
    </div>
  );
}
