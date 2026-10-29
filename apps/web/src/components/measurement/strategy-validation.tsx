'use client';

import React, { useState } from 'react';
import type { StrategyValidationReport, StrategyValidationRow } from '@fno/shared';
import { Section } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { ActionButton, FilterBar, SelectField } from '@/components/ui/controls';
import { ErrorNotice } from '@/components/ui/data-state';
import { formatNumber, formatR, formatIstDateTime } from '@/lib/format';
import { strategyValidationCsv } from '@/lib/strategy-validation-csv';

const status: Record<StrategyValidationRow['status'], string> = {
  NO_MEASURABLE_RESULTS: 'No measurable results', SMALL_SAMPLE: 'Insufficient sample',
  NEGATIVE_REVIEW: 'Negative · review', POSITIVE_UNPROVEN: 'Positive · unproven', FLAT: 'Flat',
};
const columns: Column<StrategyValidationRow>[] = [
  { id: 'strategy', header: 'Strategy / version', sortValue: r => r.strategy, cell: r => <div><strong>{r.strategy === 'S1' ? 'Structure S1' : r.strategy === 'INDICATOR' ? 'Old Indicator' : r.strategy}</strong><span className="block text-xs text-[var(--text-secondary)]" title={r.logicVersion}>{r.sourceVersion} · expand for rules</span></div> },
  { id: 'mode', header: 'Mode / exchange', cell: r => `${r.mode} · ${r.exchange}` },
  { id: 'total', header: 'Total trades', numeric: true, sortValue: r => r.total, cell: r => r.total },
  { id: 'open', header: 'Open', numeric: true, cell: r => r.open },
  { id: 'measured', header: 'Closed with costs', numeric: true, sortValue: r => r.measured, cell: r => r.measured },
  { id: 'wins', header: 'Profitable', numeric: true, cell: r => r.profitable },
  { id: 'losses', header: 'Losing', numeric: true, cell: r => r.losing },
  { id: 'profit', header: 'Profit (net R)', numeric: true, sortValue: r => r.profitR, cell: r => formatR(r.profitR) },
  { id: 'loss', header: 'Loss (net R)', numeric: true, sortValue: r => r.lossR, cell: r => formatR(r.lossR == null ? null : -r.lossR) },
  { id: 'net', header: 'Net P&L (R)', numeric: true, sortValue: r => r.netR, cell: r => <strong className={r.netR == null || r.netR === 0 ? '' : r.netR > 0 ? 'text-[var(--status-ok)]' : 'text-[var(--status-bad)]'}>{formatR(r.netR)}</strong> },
  { id: 'pf', header: 'Profit factor', numeric: true, sortValue: r => r.profitFactor, cell: r => r.noLosses ? 'No losses yet' : formatNumber(r.profitFactor) },
  { id: 'status', header: 'Validation', cell: r => r.total === 0 ? 'No recorded trades' : status[r.status] },
];

export function StrategyValidation({ report }: { report?: StrategyValidationReport }) {
  const [population, setPopulation] = useState('RELIABLE');
  const [strategy, setStrategy] = useState('ALL');
  const [mode, setMode] = useState('ALL');
  const [exchange, setExchange] = useState('ALL');
  const rows = (report?.rows ?? []).filter(r => r.population === population && (strategy === 'ALL' || r.strategy === strategy) && (mode === 'ALL' || r.mode === mode) && (exchange === 'ALL' || r.exchange === exchange));
  const absent = (report?.inventory ?? []).filter(s => (strategy === 'ALL' || strategy === s) && !rows.some(r => r.strategy === s));
  const visible: StrategyValidationRow[] = [...rows, ...absent.map(s => ({
    key: `empty:${s}`, strategy: s, logicVersion: 'UNRECORDED', sourceVersion: 'UNRECORDED',
    mode: mode === 'ALL' ? '—' : mode, exchange: exchange === 'ALL' ? '—' : exchange,
    population: population as StrategyValidationRow['population'], total: 0, open: 0, excluded: 0, missingCost: 0,
    measured: 0, profitable: 0, losing: 0, flat: 0, expired: 0, sessions: 0,
    grossR: null, costR: null, profitR: null, lossR: null, netR: null, expectancyR: null, profitFactor: null,
    noLosses: false, status: 'NO_MEASURABLE_RESULTS' as const,
  }))];
  return <Section title="Strategy Validation" subtitle="Every recorded strategy, with realised paper profit and loss after estimated costs. Expand a row for its exact rule versions and data coverage.">
    {!report ? <ErrorNotice title="Strategy validation unavailable" detail="This API build does not include the strategy validation report." /> : <>
      <p className="mb-3 text-sm text-[var(--text-secondary)]">Updated {formatIstDateTime(Date.parse(report.asOf))}. Each row separates strategy, rule version, mode, exchange and reliability period. Expired exits count at their recorded price. Positive results are unproven; 30 trades and 20 entry sessions are only a sample-coverage check, never proof of profitability.</p>
      {!report.complete && <ErrorNotice title="Partial history" detail={`Only the newest ${report.loaded.toLocaleString('en-IN')} records are loaded. These totals do not represent the complete history.`} />}
      <FilterBar label="Strategy validation filters">
        <ActionButton onClick={() => {
          const url = URL.createObjectURL(new Blob([strategyValidationCsv(visible)], { type: 'text/csv;charset=utf-8' }));
          const a = document.createElement('a'); a.href = url; a.download = `strategy-validation-${population.toLowerCase()}${report.complete ? '' : '-partial'}.csv`;
          a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}>Export table CSV</ActionButton>
        <SelectField className="min-w-0 max-w-full flex-wrap [&_select]:min-w-0 [&_select]:max-w-full" label="Period" value={population} onChange={setPopulation} options={[{ id: 'RELIABLE', label: `Measurement reliable · from ${new Date(report.reliableFrom).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' })}` }, { id: 'HISTORICAL', label: 'Earlier history · separate population' }]} />
        <SelectField label="Strategy" value={strategy} onChange={setStrategy} options={[{ id: 'ALL', label: 'All strategies' }, ...report.inventory.map(id => ({ id, label: id }))]} />
        <SelectField label="Mode" value={mode} onChange={setMode} options={[{ id: 'ALL', label: 'All modes' }, ...[...new Set(report.rows.map(r => r.mode))].sort().map(id => ({ id, label: id }))]} />
        <SelectField label="Exchange" value={exchange} onChange={setExchange} options={[{ id: 'ALL', label: 'All exchanges' }, ...[...new Set(report.rows.map(r => r.exchange))].sort().map(id => ({ id, label: id }))]} />
      </FilterBar>
      <DataTable key={`${population}:${strategy}:${mode}:${exchange}`} rows={visible} columns={columns} rowKey={r => r.key} ariaLabel="Strategy validation results" pageSize={20} initialSort={{ id: 'net', dir: 'asc' }} emptyTitle="No recorded trades for these filters" renderDetail={r => <div className="space-y-2 text-sm">
        <p>Logic version: {r.logicVersion} · Source version: {r.sourceVersion}. UNRECORDED versions and unattributed sources are not inferred.</p>
        <p>Gross {formatR(r.grossR)} − estimated costs {formatR(r.costR)} = net {formatR(r.netR)} on the same {r.measured} closed trades. Average {formatR(r.expectancyR)} per measured trade.</p>
        <p>{r.sessions} entry sessions · {r.flat} flat · {r.expired} measured expired exits · {r.missingCost} closed without valid recorded costs · {r.excluded} excluded (voided, tracking lost, off-session, spreads or incomplete geometry).</p>
        <p>Total {r.total} = open {r.open} + measured {r.measured} + missing cost {r.missingCost} + excluded {r.excluded}. Profit and loss are classified from net P&L, regardless of the WIN/LOSS/EXPIRED label.</p>
      </div>} />
      {absent.length > 0 && <p className="mt-3 text-sm text-[var(--text-secondary)]">No recorded trades in the loaded data for these filters: {absent.join(', ')}. No validation verdict is available.</p>}
      <p className="mt-3 text-sm text-[var(--text-secondary)]">R uses each trade’s original entry-to-stop risk. Rupee account P&L is unavailable here because historical executed quantities are not consistently recorded. Shadow candidates and isolated experiments are not pooled with production paper trades.</p>
    </>}
  </Section>;
}
