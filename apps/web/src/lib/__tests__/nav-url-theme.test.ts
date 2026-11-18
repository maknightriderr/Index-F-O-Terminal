import { describe, expect, it } from 'vitest';
import { EXPLORER_VIEWS, NAV_GROUPS, UNBUILT_PAGES, resolveTab } from '../nav';
import { buildUrlSearch, parseUrlState, sameUrlState } from '../url-state';
import { migrateUiSettings, resolveStoredTheme, concreteTheme, themeBootstrapScript } from '../theme';

describe('navigation', () => {
  it('has the seven workspaces of the trading loop, every page once, a unique code and key each (redesign phase 1)', () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(['Today', 'Trade', 'Opportunities', 'Markets', 'Paper', 'Research', 'System']);
    const ids = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['alerts', 'backtesting', 'best-setups', 'corporate-actions', 'dashboard', 'desk', 'evidence', 'fno-explorer', 'indices', 'institutional-flow', 'loss-attribution', 'market-overview', 'market-scanner', 'measurement', 'option-chain', 'paper-trades', 'signal-diagnostics', 'strategy-lab', 'strategy-scanner', 'system-health', 'system-learning', 'workspace']);
    const codes = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.code));
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(NAV_GROUPS.map((g) => g.key)).size).toBe(NAV_GROUPS.length);
    for (const g of NAV_GROUPS) expect(g.items.map((i) => i.id)).toContain(g.primary);
  });
  it('redirects the three retired pages into the explorer views', () => {
    expect(resolveTab('fno-stocks')).toEqual({ tab: 'fno-explorer', view: 'overview' });
    expect(resolveTab('oi-intelligence')).toEqual({ tab: 'fno-explorer', view: 'oi' });
    expect(resolveTab('iv-greeks')).toEqual({ tab: 'fno-explorer', view: 'iv' });
    expect(EXPLORER_VIEWS.map((v) => v.id)).toEqual(['overview', 'oi', 'iv']);
  });
  it('falls back to the dashboard for unknown ids and keeps asset tabs', () => {
    expect(resolveTab('nope')).toEqual({ tab: 'dashboard' });
    expect(resolveTab(null)).toEqual({ tab: 'dashboard' });
    expect(resolveTab('asset:NSE:NIFTY')).toEqual({ tab: 'asset:NSE:NIFTY' });
    expect(resolveTab('asset:XXX:NIFTY')).toEqual({ tab: 'dashboard' });
  });
  it('keeps unbuilt pages routable', () => {
    for (const id of UNBUILT_PAGES) expect(resolveTab(id).tab).toBe(id);
  });
});

describe('url state', () => {
  it('round-trips pages, explorer views and assets', () => {
    for (const s of [{ tab: 'paper-trades' }, { tab: 'fno-explorer', view: 'iv' as const }, { tab: 'asset:NSE:NIFTY' }]) {
      expect(parseUrlState(buildUrlSearch(s))).toEqual(s);
    }
  });
  it('keeps the bare URL for the dashboard and default explorer view', () => {
    expect(buildUrlSearch({ tab: 'dashboard' })).toBe('');
    expect(buildUrlSearch({ tab: 'fno-explorer', view: 'overview' })).toBe('?page=fno-explorer');
  });
  it('is safe against hostile input', () => {
    expect(parseUrlState('')).toBeNull();
    expect(parseUrlState('?page=<script>')).toEqual({ tab: 'dashboard' });
    expect(parseUrlState('?page=asset&asset=NSE:../../x')).toEqual({ tab: 'dashboard' });
    expect(parseUrlState('?page=fno-explorer&view=zzz')).toEqual({ tab: 'fno-explorer' });
  });
  it('maps legacy ids from the URL', () => {
    expect(parseUrlState('?page=iv-greeks')).toEqual({ tab: 'fno-explorer', view: 'iv' });
  });
  it('compares states', () => {
    expect(sameUrlState({ tab: 'dashboard' }, { tab: 'dashboard' })).toBe(true);
    expect(sameUrlState({ tab: 'dashboard' }, { tab: 'alerts' })).toBe(false);
  });
});

describe('theme', () => {
  const stored = (theme: string, version: number) => JSON.stringify({ state: { theme }, version });
  it('defaults to dark', () => {
    expect(resolveStoredTheme(null)).toBe('dark');
    expect(resolveStoredTheme('{bad json')).toBe('dark');
    expect(resolveStoredTheme(stored('purple', 2))).toBe('dark');
  });
  it('treats a v1 light as the old default but keeps a v2 light choice', () => {
    expect(resolveStoredTheme(stored('light', 1))).toBe('dark');
    expect(resolveStoredTheme(stored('light', 2))).toBe('light');
    expect(resolveStoredTheme(stored('system', 2))).toBe('system');
  });
  it('migrates persisted state the same way', () => {
    expect(migrateUiSettings({ theme: 'light', other: 1 }, 1)).toEqual({ theme: 'dark', other: 1 });
    expect(migrateUiSettings({ theme: 'light' }, 2)).toEqual({ theme: 'light' });
  });
  it('resolves system from the OS and ships a self-contained pre-paint script', () => {
    expect(concreteTheme('system', true)).toBe('light');
    expect(concreteTheme('system', false)).toBe('dark');
    const script = themeBootstrapScript();
    expect(script).toContain('data-theme');
    expect(() => new Function(script)).not.toThrow();
  });
});
