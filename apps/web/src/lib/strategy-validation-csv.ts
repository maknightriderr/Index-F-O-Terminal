import type { StrategyValidationRow } from '@fno/shared';

/** Neutralise spreadsheet formulas in recorded text; numeric P&L retains its sign. */
const cell = (v: string | number | boolean | null) => {
  const raw = v == null ? '' : typeof v === 'string' && /^[\s]*[=+@-]/.test(v) ? `'${v}` : String(v);
  return `"${raw.replaceAll('"', '""')}"`;
};
export function strategyValidationCsv(rows: StrategyValidationRow[]): string {
  const keys: Array<keyof StrategyValidationRow> = ['strategy', 'logicVersion', 'sourceVersion', 'mode', 'exchange', 'population', 'total', 'open', 'measured', 'profitable', 'losing', 'flat', 'expired', 'missingCost', 'excluded', 'sessions', 'grossR', 'costR', 'profitR', 'lossR', 'netR', 'expectancyR', 'profitFactor', 'noLosses', 'status'];
  return [keys.map(cell).join(','), ...rows.map(r => keys.map(k => cell(r[k])).join(','))].join('\r\n');
}
