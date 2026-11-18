'use client';

// ============================================================
// TERMINAL NAVIGATION — Ctrl/⌘ K palette, "G then key" workspace shortcuts, in-workspace tabs
// ============================================================
// One keyboard-accessible directory for every page, every instrument (typed or open), recent and favourite places and
// a few actions (theme, Workspace layout). It is generated from lib/nav.ts, the one navigation registry. Navigation
// only: nothing here creates a trade, an alert or a decision.
// ============================================================

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { NAV_GROUPS, groupOf, resolveTab, tabLabel } from '@/lib/nav';
import { KNOWN_UNDERLYINGS, parseCommand, WORKSPACE_PRESETS } from '@/lib/commands';
import { useAssetTabsStore, useMarketStore, useNavHistoryStore, useUISettingsStore, useWorkspaceStore } from '@/stores';

const NavigationContext = createContext<() => void>(() => {});
export const useTerminalNavigation = () => useContext(NavigationContext);

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
};

interface Action { id: string; label: string; hint: string; run: () => void }

export function TerminalNavigation({ children }: { children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const activeTab = useMarketStore(s => resolveTab(s.activeTab).tab);
  const setActiveTab = useMarketStore(s => s.setActiveTab);
  const assets = useAssetTabsStore(s => s.tabs);
  const switchToTab = useAssetTabsStore(s => s.switchToTab);
  const openAsset = useAssetTabsStore(s => s.openTab);
  const { recent, favourites, toggleFavourite } = useNavHistoryStore();
  const setTheme = useUISettingsStore(s => s.setTheme);
  const setLayout = useWorkspaceStore(s => s.setLayout);
  const openWorkspace = useWorkspaceStore(s => s.open);
  const open = () => { setQuery(''); dialog.current?.showModal(); search.current?.focus(); };
  const close = () => dialog.current?.close();

  // Ctrl/⌘ K toggles the palette; "G" then a workspace key (within 1.2 s) jumps to that workspace.
  useEffect(() => {
    let gAt = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dialog.current?.open) { event.preventDefault(); dialog.current.close(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else { setQuery(''); dialog.current?.showModal(); search.current?.focus(); }
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || typing(event.target) || dialog.current?.open) return;
      const key = event.key.toLowerCase();
      if (key === 'g') { gAt = Date.now(); return; }
      if (gAt && Date.now() - gAt <= 1200) {
        const group = NAV_GROUPS.find(g => g.key === key);
        gAt = 0;
        if (group) { event.preventDefault(); setActiveTab(group.primary); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setActiveTab]);

  const needle = query.trim().toLowerCase();
  const groups = NAV_GROUPS.map(group => ({ ...group, items: group.items.filter(item => `${group.title} ${item.label} ${item.description} ${item.code}`.toLowerCase().includes(needle)) })).filter(group => group.items.length);
  const assetMatches = assets.filter(asset => `${asset.symbol} ${asset.exchange} workspace`.toLowerCase().includes(needle));
  // A typed instrument ("banknifty", "crudeoil oc"): the same parser as the command bar.
  const typed = needle ? parseCommand(query) : null;
  // Offered for a known underlying (NIFTY, CRUDEOIL…) or any symbol with a function word (RELIANCE OC), never for
  // random text, so a page search stays clean and a typo still says "no match".
  const namesFunction = needle.split(/\s+/).length === 2;
  const instrument = typed?.kind === 'workspace' && !assetMatches.some(a => a.symbol === typed.symbol) && (namesFunction || KNOWN_UNDERLYINGS.has(typed.symbol)) ? typed : null;
  const actions: Action[] = [
    { id: 'theme-dark', label: 'Dark theme', hint: 'Appearance', run: () => setTheme('dark') },
    { id: 'theme-light', label: 'Light theme', hint: 'Appearance', run: () => setTheme('light') },
    ...WORKSPACE_PRESETS.map(p => ({ id: `layout-${p.id}`, label: `${p.label} layout`, hint: `Workspace · Alt+${p.key}`, run: () => { setLayout(p.id, p.symbol, p.exchange); setActiveTab('workspace'); } })),
  ].filter(a => needle && `${a.label} ${a.hint}`.toLowerCase().includes(needle));
  const places = needle ? [] : [...favourites, ...recent.filter(t => !favourites.includes(t) && t !== activeTab)].slice(0, 8);

  const navigate = (id: string) => {
    close();
    const m = /^asset:(NSE|BSE|MCX):(.+)$/.exec(id);
    if (m) { if (assets.some(a => a.id === id)) switchToTab(id); else openAsset(m[2], m[1] as 'NSE' | 'BSE' | 'MCX'); }
    else setActiveTab(id);
  };
  const star = (id: string, label: string) => {
    const on = favourites.includes(id);
    return <button type="button" onClick={() => toggleFavourite(id)} aria-pressed={on} aria-label={on ? `Remove ${label} from favourites` : `Add ${label} to favourites`} className="terminal-directory-star" title={on ? 'Remove from favourites' : 'Add to favourites (shown in the side rail)'}>{on ? '★' : '☆'}</button>;
  };

  return <NavigationContext.Provider value={open}>
    {children}
    <dialog ref={dialog} className="terminal-directory" aria-labelledby="terminal-directory-title" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <div className="terminal-directory-inner">
        <div className="flex items-center justify-between gap-4 px-5 pt-5">
          <div><p className="desk-eyebrow">F&O Terminal</p><h2 id="terminal-directory-title" className="mt-1 text-xl font-semibold">Go to anything</h2></div>
          <button type="button" onClick={close} aria-label="Close page directory" className="terminal-icon-button">×</button>
        </div>
        <div className="p-5"><input ref={search} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && instrument) { e.preventDefault(); close(); openWorkspace(instrument.symbol, instrument.exchange, instrument.focus); setActiveTab('workspace'); } }} type="search" aria-label="Search terminal pages" placeholder="A page, an instrument (BANKNIFTY OC) or an action…" className="terminal-directory-search" /></div>
        <nav aria-label="All terminal pages" className="terminal-directory-results">
          {instrument && <section><h3 className="desk-eyebrow mb-2">Instrument</h3>
            <div className="terminal-directory-row"><button type="button" onClick={() => { close(); openWorkspace(instrument.symbol, instrument.exchange, instrument.focus); setActiveTab('workspace'); }} className="terminal-directory-item"><span><strong>Open {instrument.symbol} in the Workspace</strong><span>{instrument.exchange} · {instrument.focus === 'chain' ? 'option chain in focus' : instrument.focus === 'quote' ? 'quote in focus' : instrument.focus === 'radar' ? 'engine radar in focus' : 'chart in focus'} · Enter</span></span><span>→</span></button></div>
            <div className="terminal-directory-row"><button type="button" onClick={() => navigate(`asset:${instrument.exchange}:${instrument.symbol}`)} className="terminal-directory-item"><span><strong>Open {instrument.symbol} full analysis</strong><span>Bias, trade setup, structure, option chain and OI intelligence</span></span><span>→</span></button></div>
          </section>}
          {places.length > 0 && <section><h3 className="desk-eyebrow mb-2">Favourites and recent</h3>{places.map(id => <div key={id} className="terminal-directory-row">{star(id, tabLabel(id))}<button type="button" aria-current={id === activeTab ? 'page' : undefined} onClick={() => navigate(id)} className="terminal-directory-item"><span><strong>{tabLabel(id)}</strong><span>{groupOf(id)?.title ?? ''}</span></span><span>→</span></button></div>)}</section>}
          {groups.map(group => <section key={group.id}><h3 className="desk-eyebrow mb-2">{group.title} <span className="terminal-directory-key">G {group.key.toUpperCase()}</span></h3>{group.items.map(item => <div key={item.id} className="terminal-directory-row">{star(item.id, item.label)}<button type="button" aria-current={item.id === activeTab ? 'page' : undefined} onClick={() => navigate(item.id)} className="terminal-directory-item"><span><strong>{item.label}</strong><span>{item.description}</span></span><span className="terminal-directory-code">{item.code}</span></button></div>)}</section>)}
          {assetMatches.length > 0 && <section><h3 className="desk-eyebrow mb-2">Open instruments</h3>{assetMatches.map(asset => <div key={asset.id} className="terminal-directory-row">{star(asset.id, asset.symbol)}<button type="button" onClick={() => navigate(asset.id)} className="terminal-directory-item"><span><strong>{asset.symbol}</strong><span>{asset.exchange} instrument workspace</span></span><span>→</span></button></div>)}</section>}
          {actions.length > 0 && <section><h3 className="desk-eyebrow mb-2">Actions</h3>{actions.map(a => <div key={a.id} className="terminal-directory-row"><button type="button" onClick={() => { close(); a.run(); }} className="terminal-directory-item"><span><strong>{a.label}</strong><span>{a.hint}</span></span><span>↵</span></button></div>)}</section>}
          {!groups.length && !assetMatches.length && !instrument && !actions.length && <p className="p-6 text-center text-sm text-[var(--text-secondary)]">No matching pages. Try “paper”, “flow”, “health”, a symbol such as NIFTY, or SYMBOL OC for any stock.</p>}
        </nav>
        <p className="border-t border-[var(--border-primary)] px-5 py-3 text-xs text-[var(--text-secondary)]">Ctrl / ⌘ K to open · G then T W O M P R S for a workspace · ☆ pins to the rail · Esc to close</p>
      </div>
    </dialog>
  </NavigationContext.Provider>;
}

/** The pages of the current workspace, on every page of a workspace that has more than one. */
export function WorkspaceTabs() {
  const active = useMarketStore(s => resolveTab(s.activeTab).tab);
  const go = useMarketStore(s => s.setActiveTab);
  if (active.startsWith('asset:')) return null;
  const group = groupOf(active);
  if (!group || group.items.length < 2) return null;
  return <nav aria-label={`${group.title} workspace pages`} className="terminal-workspace-tabs"><span className="terminal-workspace-group">{group.title}</span>{group.items.map(item => <button key={item.id} type="button" aria-current={item.id === active ? 'page' : undefined} onClick={() => go(item.id)} title={item.description}>{item.label}</button>)}</nav>;
}
