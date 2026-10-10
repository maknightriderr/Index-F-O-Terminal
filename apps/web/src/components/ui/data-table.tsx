'use client';

// ============================================================
// DATA TABLE — sticky header, zebra rows, sorting, paging, expandable rows
// ============================================================
// The shared table for every long list. Headings stay visible while the body
// scrolls (sticky inside the scroll container), rows alternate subtly, numbers
// are right-aligned and tabular, columns can be dropped on narrow screens
// (`hideBelow`) while the row stays expandable to show everything, and long
// lists page instead of rendering thousands of rows.
// ============================================================

import React, { useMemo, useState } from 'react';
import { EmptyState } from './data-state';

export interface Column<T> {
  id: string;
  header: React.ReactNode;
  /** Plain-text name for screen readers / sort announcements when `header` is not text. */
  label?: string;
  cell: (row: T) => React.ReactNode;
  numeric?: boolean;
  /** Present = the column is sortable by this value (null sorts last). */
  sortValue?: (row: T) => number | string | null | undefined;
  /** Hide this column below a breakpoint; the row's detail panel still shows it. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  width?: string;
  title?: string;
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
  '2xl': 'hidden 2xl:table-cell',
};

export type SortState = { id: string; dir: 'asc' | 'desc' } | null;

/** Pure: rows sorted by a column; null / undefined values always sort last. */
export function sortRows<T>(rows: readonly T[], col: Column<T> | undefined, dir: 'asc' | 'desc'): T[] {
  if (!col?.sortValue) return [...rows];
  const val = col.sortValue;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const xn = x == null || (typeof x === 'number' && !Number.isFinite(x));
    const yn = y == null || (typeof y === 'number' && !Number.isFinite(y));
    if (xn && yn) return 0;
    if (xn) return 1;
    if (yn) return -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y)) * sign;
  });
}

export function Pagination({ page, pageCount, total, pageSize, onPage }: { page: number; pageCount: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav aria-label="Pagination" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--text-secondary)]">
      <span>
        Showing {from}–{to} of {total}
      </span>
      <span className="flex items-center gap-2">
        <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} className="rounded-md border border-[var(--border-secondary)] px-3 py-1.5 disabled:opacity-40 hover:bg-[var(--surface-card-alt)]">
          Previous
        </button>
        <span aria-live="polite">
          Page {page + 1} of {pageCount}
        </span>
        <button type="button" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)} className="rounded-md border border-[var(--border-secondary)] px-3 py-1.5 disabled:opacity-40 hover:bg-[var(--surface-card-alt)]">
          Next
        </button>
      </span>
    </nav>
  );
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  ariaLabel,
  pageSize = 50,
  initialSort = null,
  maxHeight,
  renderDetail,
  emptyTitle = 'No rows',
  emptyHint,
  rowClassName,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  ariaLabel: string;
  pageSize?: number;
  initialSort?: SortState;
  /** Scroll the body inside this height so the header stays visible (e.g. "70vh"). */
  maxHeight?: string;
  /** Present = each row can be expanded; the panel gets the full row. */
  renderDetail?: (row: T) => React.ReactNode;
  emptyTitle?: string;
  emptyHint?: React.ReactNode;
  rowClassName?: (row: T) => string;
  /** A click anywhere on the row. Keyboard users get the same action from a real button inside the row (never rely on this alone). */
  onRowClick?: (row: T) => void;
}) {
  const [sort, setSort] = useState<SortState>(initialSort);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => (sort ? sortRows(rows, columns.find((c) => c.id === sort.id), sort.dir) : [...rows]), [rows, sort, columns]);
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const toggleSort = (id: string) => {
    setPage(0);
    setSort((s) => (s?.id === id ? (s.dir === 'asc' ? { id, dir: 'desc' } : null) : { id, dir: 'desc' }));
  };
  const toggleRow = (k: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  if (rows.length === 0) return <EmptyState title={emptyTitle} hint={emptyHint} />;

  const colCount = columns.length + (renderDetail ? 1 : 0);
  return (
    <div>
      <div className="ui-table-wrap rounded-lg border border-[var(--border-primary)]" style={maxHeight ? { maxHeight } : undefined} tabIndex={0} role="region" aria-label={ariaLabel}>
        <table className="ui-table">
          <thead>
            <tr>
              {renderDetail && (
                <th scope="col" className="w-8">
                  <span className="sr-only">Expand</span>
                </th>
              )}
              {columns.map((c) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    title={c.title}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.sortValue ? 'none' : undefined}
                    className={`${c.numeric ? 'num' : ''} ${c.hideBelow ? HIDE[c.hideBelow] : ''}`}
                    style={c.width ? { width: c.width } : undefined}
                  >
                    {c.sortValue ? (
                      <button type="button" onClick={() => toggleSort(c.id)} className="inline-flex items-center gap-1 font-semibold" aria-label={`Sort by ${c.label ?? (typeof c.header === 'string' ? c.header : c.id)}`}>
                        {c.header}
                        <span aria-hidden="true" className="text-[10px]">
                          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const k = rowKey(row);
              const expanded = open.has(k);
              return (
                <React.Fragment key={k}>
                  <tr className={`${onRowClick ? 'cursor-pointer' : ''} ${rowClassName?.(row) ?? ''}`} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                    {renderDetail && (
                      <td>
                        <button type="button" aria-expanded={expanded} aria-label={expanded ? 'Collapse row details' : 'Expand row details'} onClick={() => toggleRow(k)} className="px-1 text-[var(--text-secondary)]">
                          {expanded ? '▾' : '▸'}
                        </button>
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.id} className={`${c.numeric ? 'num' : ''} ${c.hideBelow ? HIDE[c.hideBelow] : ''}`}>
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                  {renderDetail && expanded && (
                    <tr>
                      <td colSpan={colCount} className="!bg-[var(--surface-card-alt)]">
                        {renderDetail(row)}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination page={safePage} pageCount={pageCount} total={sorted.length} pageSize={pageSize} onPage={setPage} />
    </div>
  );
}
