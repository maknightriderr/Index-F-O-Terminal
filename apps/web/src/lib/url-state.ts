// ============================================================
// URL STATE — the selected page (and asset workspace) in the address bar
// ============================================================
// The terminal is one route; the page lived only in client state, so a view
// could not be bookmarked and the browser's back button left the app. This maps
// the state to ?page=…&asset=…&view=… and back, with the existing store staying
// the source of truth (no router rewrite).
//
//   /?page=paper-trades
//   /?page=fno-explorer&view=iv
//   /?page=asset&asset=NSE:NIFTY
// ============================================================

import { EXPLORER_VIEWS, resolveTab, type ExplorerView } from './nav';

export interface UrlState {
  tab: string;
  view?: ExplorerView;
}

/** Parses a location search string ("?page=…") into a valid tab; null when the URL names no page. */
export function parseUrlState(search: string): UrlState | null {
  const p = new URLSearchParams(search);
  const page = p.get('page');
  if (!page) return null;
  if (page === 'asset') {
    const a = p.get('asset');
    const m = a ? /^(NSE|BSE|MCX):([A-Za-z0-9&_-]+)$/.exec(a) : null;
    return m ? { tab: `asset:${m[1]}:${m[2].toUpperCase()}` } : { tab: 'dashboard' };
  }
  const resolved = resolveTab(page);
  const requestedView = p.get('view');
  const view = EXPLORER_VIEWS.find((v) => v.id === requestedView)?.id ?? resolved.view;
  return { tab: resolved.tab, ...(resolved.tab === 'fno-explorer' && view ? { view } : {}) };
}

/** The search string for a state ("" for the default dashboard, so the bare URL stays clean). */
export function buildUrlSearch(state: UrlState): string {
  const p = new URLSearchParams();
  if (state.tab.startsWith('asset:')) {
    const [, exchange, symbol] = state.tab.split(':');
    p.set('page', 'asset');
    p.set('asset', `${exchange}:${symbol}`);
  } else if (state.tab !== 'dashboard') {
    p.set('page', state.tab);
    if (state.tab === 'fno-explorer' && state.view && state.view !== 'overview') p.set('view', state.view);
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const sameUrlState = (a: UrlState, b: UrlState): boolean => buildUrlSearch(a) === buildUrlSearch(b);
