// ============================================================
// NAVIGATION — one map of pages, groups and legacy ids
// ============================================================
// The sidebar, the router in terminal-app.tsx, the URL sync and the tests all
// read this, so a page exists in exactly one place.
//
// Consolidations (no feature removed):
//   F&O Stocks, OI Intelligence, IV & Greeks → one F&O Explorer (three presets over ONE dataset)
//   Positions, Settings → not in the sidebar while they are empty placeholders (the routes still resolve and
//     say plainly that the feature is not built)
// ============================================================

export type PageId =
  | 'dashboard'
  | 'indices'
  | 'fno-explorer'
  | 'corporate-actions'
  | 'paper-trades'
  | 'best-setups'
  | 'strategy-scanner'
  | 'market-scanner'
  | 'backtesting'
  | 'loss-attribution'
  | 'signal-diagnostics'
  | 'measurement'
  | 'institutional-flow'
  | 'system-health'
  | 'alerts'
  | 'ai-assistant'
  | 'system-learning'
  | 'positions'
  | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  /** One line: what this page is for (tooltip and page subtitle). */
  description: string;
  icon: string;
}

export interface NavGroup {
  id: string;
  title: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'markets',
    title: 'Markets',
    items: [
      { id: 'dashboard', label: 'Dashboard', description: 'Market status, paper trades, best setups and the main chart.', icon: 'dashboard' },
      { id: 'indices', label: 'Indices', description: 'NSE, BSE and MCX index levels.', icon: 'indices' },
      { id: 'fno-explorer', label: 'F&O Explorer', description: 'The F&O universe: price and OI, OI build-up, and IV and Greeks views.', icon: 'fno-stocks' },
      { id: 'corporate-actions', label: 'Corporate Actions', description: 'Dividends, splits, bonuses and other corporate actions.', icon: 'corporate-actions' },
    ],
  },
  {
    id: 'trade-desk',
    title: 'Trade Desk',
    items: [
      { id: 'paper-trades', label: 'Paper Trades', description: 'Every simulated trade: open, closed and expired, with costs and status.', icon: 'paper-trades' },
      { id: 'best-setups', label: 'Best Setups', description: 'Ranked candidates with their decision state.', icon: 'best-setups' },
      { id: 'strategy-scanner', label: 'Option-Buying Leans', description: 'Stock-by-stock option-buying leans from direction, IV rank and theta (the Strategy Scanner).', icon: 'strategy-scanner' },
      { id: 'market-scanner', label: 'Structure Scanner', description: 'Developing liquidity-sweep setups and the top-down market scan (the Market Scanner).', icon: 'market-scanner' },
    ],
  },
  {
    id: 'performance',
    title: 'Performance',
    items: [
      { id: 'backtesting', label: 'Backtesting', description: 'Win rates and results of every paper trade, by strategy, source and symbol.', icon: 'backtesting' },
      { id: 'loss-attribution', label: 'Loss Attribution', description: 'Why trades lose: twelve questions answered from the recorded trades.', icon: 'loss-attribution' },
      { id: 'signal-diagnostics', label: 'Signal Diagnostics', description: 'Why candidates were accepted or rejected, shadow experiments, order blocks and order flow.', icon: 'signal-diagnostics' },
      { id: 'measurement', label: 'Measurement', description: 'Sample reliability: cohorts, denominators, estimated costs and payoff grading.', icon: 'measurement' },
    ],
  },
  {
    id: 'market-context',
    title: 'Market Context',
    items: [{ id: 'institutional-flow', label: 'Institutional Flow', description: 'FII/DII positioning, next-day bias and commentary.', icon: 'institutional-flow' }],
  },
  {
    id: 'system',
    title: 'System',
    items: [
      { id: 'system-health', label: 'System Health', description: 'Service and data-feed status, from observed evidence.', icon: 'system-health' },
      { id: 'alerts', label: 'Alerts', description: 'Open-interest, volatility and trade alerts.', icon: 'alerts' },
      { id: 'ai-assistant', label: 'AI Assistant', description: 'Ask questions about the current market data.', icon: 'ai-assistant' },
      { id: 'system-learning', label: 'System Learning', description: 'Self-audit of failures and protections.', icon: 'system-learning' },
    ],
  },
];

/** Sub-pages of the Performance area (rendered as a tab strip at the top of each). */
export const PERFORMANCE_PAGES: PageId[] = ['backtesting', 'loss-attribution', 'signal-diagnostics', 'measurement'];

/** Pages that are reachable but are not built; they are not in the sidebar. */
export const UNBUILT_PAGES: PageId[] = ['positions', 'settings'];

/** The F&O Explorer's views, one per page it replaces. */
export type ExplorerView = 'overview' | 'oi' | 'iv';
export const EXPLORER_VIEWS: ReadonlyArray<{ id: ExplorerView; label: string; description: string }> = [
  { id: 'overview', label: 'F&O Stocks', description: 'Price, volume, OI and bias for every F&O stock.' },
  { id: 'oi', label: 'OI Intelligence', description: 'Open-interest build-up classification and PCR.' },
  { id: 'iv', label: 'IV & Greeks', description: 'ATM implied volatility, IV rank, skew and Greeks.' },
];

/** Old sidebar ids (persisted in localStorage or bookmarked) → the page and view that replaced them. */
const LEGACY: Record<string, { page: PageId; view?: ExplorerView }> = {
  'fno-stocks': { page: 'fno-explorer', view: 'overview' },
  'oi-intelligence': { page: 'fno-explorer', view: 'oi' },
  'iv-greeks': { page: 'fno-explorer', view: 'iv' },
};

const ALL_PAGES = new Set<string>([...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id)), ...UNBUILT_PAGES]);

export interface ResolvedTab {
  /** The activeTab value the router renders: a page id or "asset:EXCHANGE:SYMBOL". */
  tab: string;
  view?: ExplorerView;
}

/** Maps any stored or requested tab id to a valid one (legacy ids redirect; unknown ids fall back to the dashboard). */
export function resolveTab(id: string | null | undefined): ResolvedTab {
  if (!id) return { tab: 'dashboard' };
  if (/^asset:(NSE|BSE|MCX):[A-Z0-9&_-]+$/.test(id)) return { tab: id };
  if (LEGACY[id]) return { tab: LEGACY[id].page, view: LEGACY[id].view };
  return ALL_PAGES.has(id) ? { tab: id } : { tab: 'dashboard' };
}

export function pageMeta(id: string): NavItem | null {
  for (const g of NAV_GROUPS) for (const i of g.items) if (i.id === id) return i;
  return null;
}
