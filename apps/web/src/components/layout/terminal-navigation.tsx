'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { NAV_GROUPS, resolveTab } from '@/lib/nav';
import { useAssetTabsStore, useMarketStore } from '@/stores';

const NavigationContext = createContext<() => void>(() => {});
export const useTerminalNavigation = () => useContext(NavigationContext);

/** One keyboard-accessible directory for every terminal page and open asset. Navigation only. */
export function TerminalNavigation({ children }: { children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const activeTab = useMarketStore(s => resolveTab(s.activeTab).tab);
  const setActiveTab = useMarketStore(s => s.setActiveTab);
  const assets = useAssetTabsStore(s => s.tabs);
  const switchToTab = useAssetTabsStore(s => s.switchToTab);
  const open = () => { setQuery(''); dialog.current?.showModal(); search.current?.focus(); };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog.current?.open) {
        event.preventDefault();
        dialog.current.close();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else { setQuery(''); dialog.current?.showModal(); search.current?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const needle = query.trim().toLowerCase();
  const groups = NAV_GROUPS.map(group => ({ ...group, items: group.items.filter(item => `${group.title} ${item.label} ${item.description}`.toLowerCase().includes(needle)) })).filter(group => group.items.length);
  const assetMatches = assets.filter(asset => `${asset.symbol} ${asset.exchange} workspace`.toLowerCase().includes(needle));
  const navigate = (id: string) => { dialog.current?.close(); if (id.startsWith('asset:')) switchToTab(id); else setActiveTab(id); };

  return <NavigationContext.Provider value={open}>
    {children}
    <dialog ref={dialog} className="terminal-directory" aria-labelledby="terminal-directory-title" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="terminal-directory-inner">
        <div className="flex items-center justify-between gap-4 px-5 pt-5">
          <div><p className="desk-eyebrow">F&O Terminal</p><h2 id="terminal-directory-title" className="mt-1 text-xl font-semibold">Find your workspace</h2></div>
          <button type="button" onClick={() => dialog.current?.close()} aria-label="Close page directory" className="terminal-icon-button">×</button>
        </div>
        <div className="p-5"><input ref={search} value={query} onChange={e => setQuery(e.target.value)} type="search" aria-label="Search terminal pages" placeholder="Search pages, research or open instruments…" className="terminal-directory-search" /></div>
        <nav aria-label="All terminal pages" className="terminal-directory-results">
          {groups.map(group => <section key={group.id}><h3 className="desk-eyebrow mb-2">{group.title}</h3>{group.items.map(item => <button key={item.id} type="button" aria-current={item.id === activeTab ? 'page' : undefined} onClick={() => navigate(item.id)} className="terminal-directory-item"><span><strong>{item.label}</strong><span>{item.description}</span></span><span aria-hidden="true">↗</span></button>)}</section>)}
          {assetMatches.length > 0 && <section><h3 className="desk-eyebrow mb-2">Open instruments</h3>{assetMatches.map(asset => <button key={asset.id} type="button" onClick={() => navigate(asset.id)} className="terminal-directory-item"><span><strong>{asset.symbol}</strong><span>{asset.exchange} · Asset workspace</span></span><span aria-hidden="true">↗</span></button>)}</section>}
          {!groups.length && !assetMatches.length && <p className="p-6 text-center text-sm text-[var(--text-secondary)]">No matching pages. Try “paper”, “flow” or “health”.</p>}
        </nav>
        <p className="border-t border-[var(--border-primary)] px-5 py-3 text-xs text-[var(--text-secondary)]">Ctrl / ⌘ K to open · Tab to navigate · Esc to close</p>
      </div>
    </dialog>
  </NavigationContext.Provider>;
}

/** Contextual navigation is present on all pages, including legacy and asset workspaces. */
export function WorkspaceTabs() {
  const active = useMarketStore(s => resolveTab(s.activeTab).tab);
  const go = useMarketStore(s => s.setActiveTab);
  if (active === 'dashboard' || active.startsWith('asset:')) return null;
  const group = NAV_GROUPS.find(g => g.items.some(i => i.id === active));
  if (!group) return null;
  return <nav aria-label={`${group.title} workspace pages`} className="terminal-workspace-tabs"><span className="terminal-workspace-group">{group.title}</span>{group.items.map(item => <button key={item.id} type="button" aria-current={item.id === active ? 'page' : undefined} onClick={() => go(item.id)}>{item.label}</button>)}</nav>;
}
