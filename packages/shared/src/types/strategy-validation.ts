export interface StrategyValidationRow {
  key: string;
  strategy: string;
  logicVersion: string;
  sourceVersion: string;
  mode: string;
  exchange: string;
  population: 'RELIABLE' | 'HISTORICAL';
  total: number;
  open: number;
  excluded: number;
  missingCost: number;
  measured: number;
  profitable: number;
  losing: number;
  flat: number;
  expired: number;
  sessions: number;
  grossR: number | null;
  costR: number | null;
  profitR: number | null;
  lossR: number | null;
  netR: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  noLosses: boolean;
  status: 'NO_MEASURABLE_RESULTS' | 'SMALL_SAMPLE' | 'NEGATIVE_REVIEW' | 'POSITIVE_UNPROVEN' | 'FLAT';
}

export interface StrategyValidationReport {
  asOf: string;
  complete: boolean;
  rowLimit: number;
  loaded: number;
  reliableFrom: string;
  inventory: string[];
  rows: StrategyValidationRow[];
}
