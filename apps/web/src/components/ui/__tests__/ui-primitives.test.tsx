import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { DataState, resolveDataStatus } from '../data-state';
import { DataTable, type Column } from '../data-table';
import { DecisionBadge, FreshnessBadge, HealthBadge, StatusBadge } from '../status-badge';
import type { Freshness } from '@/lib/freshness';
import type { HealthStatus } from '@/lib/health-model';

interface Row { name: string; value: number | null }
const cols: Column<Row>[] = [
  { id: 'name', header: 'Name', sortValue: (r) => r.name, cell: (r) => r.name },
  { id: 'value', header: 'Value', numeric: true, sortValue: (r) => r.value, cell: (r) => (r.value == null ? '—' : r.value) },
];
const rows: Row[] = [
  { name: 'b', value: 2 },
  { name: 'a', value: null },
  { name: 'c', value: 3 },
];

const violations = async (container: HTMLElement) => {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.help}`);
};

describe('resolveDataStatus', () => {
  it('names each state', () => {
    expect(resolveDataStatus({ loading: true, error: null, hasData: false })).toBe('loading');
    expect(resolveDataStatus({ loading: true, error: null, hasData: true })).toBe('refreshing');
    expect(resolveDataStatus({ loading: false, error: null, hasData: false })).toBe('empty');
    expect(resolveDataStatus({ loading: false, error: 'x', hasData: false })).toBe('error');
    expect(resolveDataStatus({ loading: false, error: 'x', hasData: true })).toBe('error-with-data');
    expect(resolveDataStatus({ loading: false, error: null, hasData: true })).toBe('ready');
  });
});

describe('DataState', () => {
  it('loading shows a skeleton, not content or zeros', () => {
    render(<DataState loading error={null} hasData={false}><p>content</p></DataState>);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    expect(screen.queryByText('content')).toBeNull();
  });
  it('empty explains itself', () => {
    render(<DataState loading={false} error={null} hasData={false} emptyTitle="No trades yet" emptyHint="Trades appear after a mint."><p>content</p></DataState>);
    expect(screen.getByText('No trades yet')).toBeInTheDocument();
    expect(screen.getByText('Trades appear after a mint.')).toBeInTheDocument();
  });
  it('error offers retry', () => {
    const retry = vi.fn();
    render(<DataState loading={false} error="HTTP 503" hasData={false} onRetry={retry}><p>content</p></DataState>);
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 503');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('keeps old data and says so when a refresh fails', () => {
    render(<DataState loading={false} error="timeout" hasData><p>old data</p></DataState>);
    expect(screen.getByText('old data')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/last data received/i);
  });
  it('shows refreshing quietly and the stale note when given', () => {
    render(<DataState loading error={null} hasData staleNote="Last recorded scan, not live."><p>data</p></DataState>);
    expect(screen.getByText('Updating…')).toBeInTheDocument();
    expect(screen.getByTestId('stale-note')).toHaveTextContent('not live');
  });
});

describe('status badges are not colour-only', () => {
  it('every tone carries a glyph and a text label', () => {
    for (const tone of ['ok', 'warn', 'bad', 'info', 'off'] as const) {
      const { container, unmount } = render(<StatusBadge tone={tone} label={`L-${tone}`} />);
      expect(container.textContent).toContain(`L-${tone}`);
      expect(container.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/\S/);
      unmount();
    }
  });
  it('renders every freshness, health and decision state with its own text', () => {
    const f: Freshness[] = ['FRESH', 'STALE', 'DISCONNECTED', 'UNAVAILABLE', 'MARKET_CLOSED'];
    for (const s of f) {
      const { container, unmount } = render(<FreshnessBadge state={s} />);
      expect(container.textContent).toContain(s.replace('_', ' '));
      unmount();
    }
    const h: HealthStatus[] = ['HEALTHY', 'DEGRADED', 'STALE', 'DISCONNECTED', 'UNAVAILABLE', 'NOT_IMPLEMENTED', 'API_UNREACHABLE', 'MARKET_CLOSED'];
    for (const s of h) {
      const { container, unmount } = render(<HealthBadge status={s} />);
      expect(container.textContent).toContain(s.replace('_', ' '));
      unmount();
    }
    for (const s of ['LIVE_PAPER_ELIGIBLE', 'SHADOW_ONLY', 'REJECTED', 'UNAVAILABLE'] as const) {
      const { container, unmount } = render(<DecisionBadge state={s} />);
      expect(container.textContent).toMatch(/\S/);
      unmount();
    }
  });
});

describe('DataTable', () => {
  it('sorts by a column and puts missing values last, never as 0', () => {
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.name} ariaLabel="t" />);
    fireEvent.click(screen.getByRole('button', { name: /Value/ }));
    const body = screen.getAllByRole('row').slice(1);
    expect(body[0]).toHaveTextContent('c');
    expect(body[body.length - 1]).toHaveTextContent('—');
  });
  it('pages long lists and shows the denominator', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ name: `r${String(i).padStart(3, '0')}`, value: i }));
    render(<DataTable columns={cols} rows={many} rowKey={(r) => r.name} ariaLabel="t" pageSize={50} />);
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getByText(/120/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /next/i }));
    expect(screen.getByText('r050')).toBeInTheDocument();
  });
  it('expands a row for detail with a keyboard-reachable control', () => {
    render(<DataTable columns={cols} rows={rows} rowKey={(r) => r.name} ariaLabel="t" renderDetail={(r) => <p>detail for {r.name}</p>} />);
    const toggle = screen.getAllByRole('button', { name: /expand|details|row/i })[0];
    fireEvent.click(toggle);
    expect(screen.getByText(/detail for/)).toBeInTheDocument();
  });
  it('shows its empty state', () => {
    render(<DataTable columns={cols} rows={[]} rowKey={(r) => r.name} ariaLabel="t" emptyTitle="No matches" />);
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
  it('has no accessibility violations (structure, names, roles)', async () => {
    const { container } = render(
      <div>
        <DataTable columns={cols} rows={rows} rowKey={(r) => r.name} ariaLabel="Example" renderDetail={(r) => <p>{r.name}</p>} />
        <DataState loading={false} error="x" hasData={false}><p /></DataState>
        <FreshnessBadge state="STALE" detail="old" />
      </div>
    );
    expect(await violations(container)).toEqual([]);
    expect(within(container).getByRole('region', { name: 'Example' })).toBeInTheDocument();
  });
});
