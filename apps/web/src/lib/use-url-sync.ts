'use client';

// ============================================================
// URL SYNC — the selected page lives in the address bar too
// ============================================================
// The zustand stores stay the source of truth (no router rewrite); this mirrors them to ?page=…&asset=…&view=… and
// back, so a view can be bookmarked and the browser's back / forward buttons move between pages instead of leaving the
// app. Old persisted tab ids (fno-stocks, oi-intelligence, iv-greeks) are redirected to their replacement.
// ============================================================

import { useEffect, useRef } from 'react';
import { useAssetTabsStore, useMarketStore, useNavStore } from '@/stores';
import { resolveTab } from './nav';
import { buildUrlSearch, parseUrlState, sameUrlState, type UrlState } from './url-state';
import type { Exchange } from '@fno/shared';

function applyToStores(state: UrlState): void {
  const nav = useNavStore.getState();
  if (state.view) nav.setExplorerView(state.view);
  if (state.tab.startsWith('asset:')) {
    const [, exchange, symbol] = state.tab.split(':');
    useAssetTabsStore.getState().openTab(symbol, exchange as Exchange);
  } else {
    useMarketStore.getState().setActiveTab(state.tab);
  }
}

export function useUrlSync(): void {
  const activeTab = useMarketStore((s) => s.activeTab);
  const explorerView = useNavStore((s) => s.explorerView);
  const applying = useRef(false);
  const initialised = useRef(false);

  // On mount: the URL wins; otherwise redirect a legacy persisted tab id.
  useEffect(() => {
    const fromUrl = parseUrlState(window.location.search);
    applying.current = true;
    if (fromUrl) applyToStores(fromUrl);
    else {
      const resolved = resolveTab(useMarketStore.getState().activeTab);
      if (resolved.tab !== useMarketStore.getState().activeTab) applyToStores({ tab: resolved.tab, view: resolved.view });
      else if (resolved.view) useNavStore.getState().setExplorerView(resolved.view);
    }
    initialised.current = true;
    // Let the store updates above settle before state → URL starts writing.
    queueMicrotask(() => {
      applying.current = false;
    });

    const onPop = () => {
      const s = parseUrlState(window.location.search) ?? { tab: 'dashboard' };
      applying.current = true;
      applyToStores(s);
      queueMicrotask(() => {
        applying.current = false;
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // State → URL (push, so back works). Skipped while applying a URL to the stores.
  useEffect(() => {
    if (!initialised.current || applying.current) return;
    const target: UrlState = { tab: activeTab, view: explorerView };
    const current = parseUrlState(window.location.search) ?? { tab: 'dashboard' };
    if (sameUrlState(target, current)) return;
    const search = buildUrlSearch(target);
    window.history.pushState(null, '', `${window.location.pathname}${search}`);
  }, [activeTab, explorerView]);
}
