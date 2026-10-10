'use client';

// ============================================================
// CARD, SECTION, PAGE HEADER, METRIC — the layout primitives
// ============================================================
// Spacing comes from tokens (--space-card, --space-section, --radius-card), not
// per-component guesses, so a card looks the same on every page. Text is never
// below 12px (text-xs); body is 14px; headings are 16-20px.
// ============================================================

import React, { useId, useState } from 'react';

export function Card({ children, className = '', as: Tag = 'div', ...rest }: { children: React.ReactNode; className?: string; as?: 'div' | 'section' | 'article' } & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`rounded-[var(--radius-card)] border border-[var(--border-secondary)] bg-[var(--surface-card)] p-4 ${className}`} {...(rest as object)}>
      {children}
    </Tag>
  );
}

/** A titled block of a page. `collapsible` sections can be folded away (the heading is the toggle). */
export function Section({
  title,
  subtitle,
  actions,
  children,
  collapsible = false,
  defaultOpen = true,
  className = '',
  id,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section id={id} aria-labelledby={`${bodyId}-h`} className={`rounded-[var(--radius-card)] border border-[var(--border-secondary)] bg-[var(--surface-card)] ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4 pb-3">
        <div className="min-w-0">
          <h2 id={`${bodyId}-h`} className="text-base font-semibold text-[var(--text-primary)]">
            {collapsible ? (
              <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-2 text-left">
                <span aria-hidden="true" className="inline-block w-3 text-[var(--text-secondary)]">
                  {open ? '▾' : '▸'}
                </span>
                {title}
              </button>
            ) : (
              title
            )}
          </h2>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div id={bodyId} hidden={collapsible && !open} className="px-4 pb-4">
        {children}
      </div>
    </section>
  );
}

/** The top of every page: title, one-line purpose, actions and an optional tab strip beneath. */
export function PageHeader({ title, subtitle, actions, children }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm text-[var(--text-secondary)]">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </header>
  );
}

/** A labelled figure. `value` is shown as given: pass formatted text, with an em dash for unknown. */
export function MetricTile({ label, value, sub, tone, title }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'neutral'; title?: string }) {
  const color = tone === 'ok' ? 'text-[var(--status-ok)]' : tone === 'bad' ? 'text-[var(--status-bad)]' : tone === 'warn' ? 'text-[var(--status-warn)]' : 'text-[var(--text-primary)]';
  return (
    <div className="min-w-0 rounded-lg border border-[var(--border-primary)] bg-[var(--surface-card-alt)] px-3 py-2.5" title={title}>
      <div className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums leading-7 ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-[var(--text-secondary)]">{sub}</div>}
    </div>
  );
}

/** A responsive grid for metric tiles. */
export function MetricGrid({ children, min = 150 }: { children: React.ReactNode; min?: number }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
      {children}
    </div>
  );
}

/** The standard padded page body. */
export function PageBody({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1600px] space-y-5 p-4 md:p-6">{children}</div>;
}
