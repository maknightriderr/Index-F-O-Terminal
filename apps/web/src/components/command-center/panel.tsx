'use client';

import React, { useId } from 'react';

/** The Command Center panel: hairline border, uppercase micro-title, optional right-hand meta. */
export function Panel({ title, meta, children, className = '', bodyClassName = 'cc-panel-body', accent = false }: { title: React.ReactNode; meta?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string; accent?: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={`cc-panel ${className}`} style={accent ? { borderColor: 'var(--desk-accent)' } : undefined}>
      <div className="cc-panel-head">
        <h2 id={id} className="cc-title">{title}</h2>
        {meta && <div className="cc-note">{meta}</div>}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'off';
export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className="cc-pill" data-tone={tone}>{children}</span>;
}

export function Kpi({ label, value, sub, valueClass = '' }: { label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; valueClass?: string }) {
  return (
    <div>
      <div className="cc-label">{label}</div>
      <div className={`cc-kpi-value ${valueClass}`}>{value}</div>
      {sub && <div className="cc-note">{sub}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="cc-empty">{children}</p>;
}

/** A small labelled number (label above, mono value). */
export function Stat({ label, value, className = '' }: { label: React.ReactNode; value: React.ReactNode; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="cc-label" style={{ fontSize: 10 }}>{label}</div>
      <div className={`cc-num text-[13px] ${className}`}>{value}</div>
    </div>
  );
}
