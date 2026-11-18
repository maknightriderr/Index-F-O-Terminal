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
  | 'workspace'
  | 'dashboard'
  | 'desk'
  | 'market-overview'
  | 'option-chain'
  | 'strategy-lab'
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
  | 'evidence'
  | 'institutional-flow'
  | 'system-health'
  | 'alerts'
  | 'system-learning'
  | 'positions'
  | 'settings';

export interface NavItem {
  id: PageId;
  label: string;
  /** One line: what this page is for (tooltip and page subtitle). */
  description: string;
  icon: string;
  /** Command-bar code that opens the page (lib/commands.ts reads these; one registry, no second list). */
  code: string;
}

export interface NavGroup {
  id: string;
  title: string;
  /** Rail / phone label of the workspace. */
  short: string;
  /** The page the rail button opens. */
  primary: PageId;
  /** "G" then this key opens the workspace (TerminalNavigation). */
  key: string;
  icon: string;
  items: NavItem[];
}

/**
 * The terminal's ONE map (UX redesign phase 1, 18 Nov): seven workspaces in the order of the trading loop. The rail,
 * the in-workspace tabs, the phone bar, the Ctrl+K directory and the command-bar codes are all generated from this,
 * so they can no longer disagree. Every existing page keeps its id (and so its URL and stored tab).
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'today',
    title: 'Today',
    short: 'Today',
    primary: 'dashboard',
    key: 't',
    icon: 'dashboard',
    items: [
      { id: 'dashboard', label: 'Command Center', code: 'CC', description: 'What is happening now: market read and pulse, the paper account of both engines, every signal of the day, the scorecard and data health.', icon: 'dashboard' },
      { id: 'desk', label: 'Paper desk', code: 'DESK', description: 'The new engine desk: health strip, account and drawdown, live positions, the setup radar, the journal, equity and expiring calendars.', icon: 'paper-trades' },
    ],
  },
  {
    id: 'trade',
    title: 'Trade',
    short: 'Trade',
    primary: 'workspace',
    key: 'w',
    icon: 'workspace',
    items: [
      { id: 'workspace', label: 'Workspace', code: 'WS', description: 'Command bar and linked panels: chart, option chain, quote, engine radar and the paper account on one screen.', icon: 'workspace' },
      { id: 'option-chain', label: 'Option Chain', code: 'CHAIN', description: 'Bid/ask, delta, IV and OI by strike, with the contract the fresh-start rules would accept.', icon: 'option-chain' },
    ],
  },
  {
    id: 'opportunities',
    title: 'Opportunities',
    short: 'Signals',
    primary: 'best-setups',
    key: 'o',
    icon: 'best-setups',
    items: [
      { id: 'best-setups', label: 'Best Setups', code: 'OPP', description: 'Ranked candidates with their decision state.', icon: 'best-setups' },
      { id: 'market-scanner', label: 'Structure Scanner', code: 'SCAN', description: 'Developing liquidity-sweep setups and the top-down market scan (the Market Scanner).', icon: 'market-scanner' },
      { id: 'strategy-scanner', label: 'Option-Buying Leans', code: 'LEANS', description: 'Stock-by-stock option-buying leans from direction, IV rank and theta (the Strategy Scanner).', icon: 'strategy-scanner' },
    ],
  },
  {
    id: 'markets',
    title: 'Markets',
    short: 'Markets',
    primary: 'indices',
    key: 'm',
    icon: 'indices',
    items: [
      { id: 'indices', label: 'Indices', code: 'IDX', description: 'NSE, BSE and MCX index levels.', icon: 'indices' },
      { id: 'fno-explorer', label: 'F&O Explorer', code: 'FNO', description: 'Market Radar breadth and top bullish/bearish candidates; F&O price, OI, IV and Greeks.', icon: 'fno-stocks' },
      { id: 'institutional-flow', label: 'Institutional Flow', code: 'FLOW', description: 'FII/DII positioning, next-day bias and commentary.', icon: 'institutional-flow' },
      { id: 'corporate-actions', label: 'Corporate Actions', code: 'CA', description: 'Dividends, splits, bonuses and other corporate actions.', icon: 'corporate-actions' },
      { id: 'market-overview', label: 'Market Overview', code: 'MKT', description: 'Watchlist, the main chart, best setups and legacy paper history.', icon: 'market-overview' },
    ],
  },
  {
    id: 'paper',
    title: 'Paper',
    short: 'Paper',
    primary: 'paper-trades',
    key: 'p',
    icon: 'paper-trades',
    items: [
      { id: 'paper-trades', label: 'Paper Trades', code: 'TRADES', description: 'Every simulated trade: open, closed and expired, with costs, result and reason.', icon: 'paper-trades' },
    ],
  },
  {
    id: 'research',
    title: 'Research',
    short: 'Research',
    primary: 'strategy-lab',
    key: 'r',
    icon: 'strategy-lab',
    items: [
      { id: 'strategy-lab', label: 'Strategy Lab', code: 'LAB', description: 'Fresh-start results by strategy: R distribution, time of day, exit reasons and the promotion gate.', icon: 'strategy-lab' },
      { id: 'backtesting', label: 'Backtesting', code: 'BT', description: 'Win rates and results of every paper trade, by strategy, source and symbol.', icon: 'backtesting' },
      { id: 'evidence', label: 'Evidence', code: 'EVID', description: 'Which strategies, signals, gates and limits have shown an edge, with intervals.', icon: 'evidence' },
      { id: 'loss-attribution', label: 'Loss Attribution', code: 'LOSS', description: 'Why trades lose: twelve questions answered from the recorded trades.', icon: 'loss-attribution' },
      { id: 'signal-diagnostics', label: 'Signal Diagnostics', code: 'DIAG', description: 'Why candidates were accepted or rejected, shadow experiments, order blocks and order flow.', icon: 'signal-diagnostics' },
      { id: 'measurement', label: 'Measurement', code: 'MEAS', description: 'Sample reliability: cohorts, denominators, estimated costs and payoff grading.', icon: 'measurement' },
    ],
  },
  {
    id: 'system',
    title: 'System',
    short: 'System',
    primary: 'system-health',
    key: 's',
    icon: 'system-health',
    items: [
      { id: 'system-health', label: 'Ops & Health', code: 'HEALTH', description: 'Services, data feeds, open incidents and expiring calendars, from observed evidence.', icon: 'system-health' },
      { id: 'alerts', label: 'Alerts', code: 'ALRT', description: 'Open-interest, volatility and trade alerts.', icon: 'alerts' },
      { id: 'system-learning', label: 'System Learning', code: 'LEARN', description: 'Self-audit of failures and protections.', icon: 'system-learning' },
    ],
  },
];

/** The workspace a page belongs to (null for an asset tab or an unbuilt page). */
export function groupOf(id: string): NavGroup | null {
  if (id.startsWith('asset:')) return NAV_GROUPS.find((g) => g.id === 'trade') ?? null;
  return NAV_GROUPS.find((g) => g.items.some((i) => i.id === id)) ?? null;
}

/** Sub-pages of the Performance area (rendered as a tab strip at the top of each). */
export const PERFORMANCE_PAGES: PageId[] = ['backtesting', 'loss-attribution', 'signal-diagnostics', 'measurement', 'evidence'];

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

/** A tab id in words, for Recent / Favourites: the page label, or "NIFTY · NSE" for an instrument. */
export function tabLabel(tab: string): string {
  const m = /^asset:(NSE|BSE|MCX):(.+)$/.exec(tab);
  if (m) return `${m[2]} · ${m[1]}`;
  return pageMeta(tab)?.label ?? tab;
}
