'use client';

// ============================================================
// CONTROLS — segmented control, chip filters, select, search, tab strip
// ============================================================
// Filter bars wrap instead of clipping (flex-wrap), controls are at least
// 32 px high with a visible focus ring, and every control has an accessible name.
// ============================================================

import React from 'react';

const btnBase = 'inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-md border px-3 py-1 text-sm font-medium transition-colors';
const btnOff = 'border-[var(--border-secondary)] text-[var(--text-secondary)] hover:bg-[var(--surface-card-alt)] hover:text-[var(--text-primary)]';
const btnOn = 'border-[var(--accent-indigo)] bg-[var(--accent-indigo)]/15 text-[var(--text-primary)]';

/** One of several mutually exclusive choices (a radio group that looks like buttons). */
export function SegmentedControl<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ id: T; label: string; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap gap-1">
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} title={o.title} onClick={() => onChange(o.id)} className={`${btnBase} ${value === o.id ? btnOn : btnOff}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Independent on/off chips (multi-select filters). */
export function ChipToggle({ pressed, onToggle, children, title }: { pressed: boolean; onToggle: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button type="button" aria-pressed={pressed} title={title} onClick={onToggle} className={`${btnBase} ${pressed ? btnOn : btnOff}`}>
      {children}
    </button>
  );
}

export function SelectField({ label, value, onChange, options, className = '' }: { label: string; value: string; onChange: (v: string) => void; options: ReadonlyArray<{ id: string; label: string }>; className?: string }) {
  return (
    <label className={`inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] ${className}`}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="min-h-8 rounded-md border border-[var(--border-secondary)] bg-[var(--surface-card)] px-2 py-1 text-sm text-[var(--text-primary)]">
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SearchField({ value, onChange, placeholder = 'Search', label = 'Search' }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="min-h-8 w-48 rounded-md border border-[var(--border-secondary)] bg-[var(--surface-card)] px-3 py-1 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dimmed)]"
      />
    </label>
  );
}

/** A wrapping row of filters; never clips on a narrow screen. */
export function FilterBar({ children, label = 'Filters' }: { children: React.ReactNode; label?: string }) {
  return (
    <div role="group" aria-label={label} className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      {children}
    </div>
  );
}

export function ActionButton({ children, onClick, disabled, title, variant = 'default' }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; title?: string; variant?: 'default' | 'primary' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${btnBase} disabled:opacity-50 ${variant === 'primary' ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo)]/20 text-[var(--text-primary)]' : btnOff}`}
    >
      {children}
    </button>
  );
}

/** A horizontal tab strip (e.g. the Performance area's sub-views). */
export function TabStrip<T extends string>({ value, tabs, onChange, label }: { value: T; tabs: ReadonlyArray<{ id: T; label: string; title?: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-[var(--border-secondary)]">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          title={t.title}
          onClick={() => onChange(t.id)}
          className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${value === t.id ? 'border-[var(--accent-indigo)] text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A short expandable explanation ("What does this mean?"). */
export function Disclosure({ summary, children }: { summary: React.ReactNode; children: React.ReactNode }) {
  return (
    <details className="rounded-md border border-[var(--border-primary)] bg-[var(--surface-card-alt)] px-3 py-2 text-sm text-[var(--text-secondary)]">
      <summary className="cursor-pointer font-medium text-[var(--text-primary)]">{summary}</summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}

/** The standing "simulated" notice used wherever paper results appear. */
export function SimulatedNotice({ children }: { children?: React.ReactNode }) {
  return (
    <p className="rounded-md border border-[var(--status-info)]/40 bg-[var(--status-info)]/10 px-3 py-2 text-sm text-[var(--text-primary)]">
      <span aria-hidden="true">ℹ </span>
      {children ?? 'Simulated paper trades: no broker order was placed. Costs shown are estimates, not actual fills.'}
    </p>
  );
}
