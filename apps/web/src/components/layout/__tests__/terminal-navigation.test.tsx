import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TerminalNavigation, WorkspaceTabs, useTerminalNavigation } from '../terminal-navigation';
import { AssetTabBar } from '../asset-tab-bar';
import { useAssetTabsStore, useMarketStore, useNavHistoryStore, useWorkspaceStore } from '@/stores';
import { NAV_GROUPS } from '@/lib/nav';

function Trigger() { const open = useTerminalNavigation(); return <button onClick={open}>Open directory</button>; }
beforeEach(() => {
  useMarketStore.setState({ activeTab: 'dashboard', selectedSymbol: null });
  useAssetTabsStore.setState({ tabs: [] });
  useNavHistoryStore.setState({ recent: [], favourites: [] });
  HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open',''); };
  HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
});
describe('terminal-wide navigation', () => {
  it('searches every existing page and navigates without creating assets or trades', () => {
    render(<TerminalNavigation><Trigger /></TerminalNavigation>);
    fireEvent.click(screen.getByText('Open directory'));
    const dialog=screen.getByRole('dialog');
    for(const group of NAV_GROUPS) for(const page of group.items) expect(within(dialog).getByText(page.label,{exact:true})).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'measurement'}});
    fireEvent.click(within(dialog).getByText('Measurement',{exact:true}));
    expect(useMarketStore.getState().activeTab).toBe('measurement');
    expect(useAssetTabsStore.getState().tabs).toEqual([]);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(document,{key:'k',ctrlKey:true});
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'paper'}});
    fireEvent.keyDown(document,{key:'Escape'});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('offers an explicit no-match state and Ctrl+K toggles the directory', () => {
    render(<TerminalNavigation><Trigger /></TerminalNavigation>);
    fireEvent.keyDown(document,{key:'k',ctrlKey:true});
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'zzzzz'}});
    expect(screen.getByText(/No matching pages/)).toBeInTheDocument();
    fireEvent.keyDown(document,{key:'k',ctrlKey:true});
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('keeps related pages and the current selection accessible outside the dashboard', () => {
    useMarketStore.setState({activeTab:'best-setups'});
    const {unmount}=render(<WorkspaceTabs />);
    const nav=screen.getByRole('navigation',{name:'Opportunities workspace pages'});
    expect(within(nav).getByRole('button',{name:'Best Setups'})).toHaveAttribute('aria-current','page');
    fireEvent.click(within(nav).getByRole('button',{name:'Structure Scanner'}));
    expect(useMarketStore.getState().activeTab).toBe('market-scanner');
    unmount();
    // A one-page workspace (Paper) shows no tab strip: there is nothing to switch to.
    useMarketStore.setState({activeTab:'paper-trades'});
    render(<WorkspaceTabs />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('opens a typed underlying, offers favourites, and jumps to a workspace with G then a key', () => {
    render(<TerminalNavigation><Trigger /></TerminalNavigation>);
    fireEvent.keyDown(document,{key:'k',ctrlKey:true});
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'banknifty oc'}});
    fireEvent.click(screen.getByText('Open BANKNIFTY in the Workspace'));
    expect(useMarketStore.getState().activeTab).toBe('workspace');
    expect(useWorkspaceStore.getState()).toMatchObject({symbol:'BANKNIFTY',focus:'chain'});
    fireEvent.keyDown(document,{key:'k',ctrlKey:true});
    fireEvent.click(screen.getByRole('button',{name:'Add Loss Attribution to favourites'}));
    expect(useNavHistoryStore.getState().favourites).toContain('loss-attribution');
    fireEvent.keyDown(document,{key:'Escape'});
    fireEvent.keyDown(document.body,{key:'g'});
    fireEvent.keyDown(document.body,{key:'p'});
    expect(useMarketStore.getState().activeTab).toBe('paper-trades');
    fireEvent.keyDown(document.body,{key:'g'});
    fireEvent.keyDown(document.body,{key:'r'});
    expect(useMarketStore.getState().activeTab).toBe('strategy-lab');
  });
  it('exposes separate keyboard-reachable open and close asset controls', () => {
    useAssetTabsStore.getState().openTab('NIFTY','NSE');
    render(<AssetTabBar />);
    expect(screen.getByRole('button',{name:'Open NIFTY workspace'})).toHaveAttribute('aria-current','page');
    const close=screen.getByRole('button',{name:'Close NIFTY workspace'});
    expect(close.closest('button')?.parentElement?.closest('button')).toBeNull();
    fireEvent.click(close);
    expect(useAssetTabsStore.getState().tabs).toHaveLength(0);
    expect(useMarketStore.getState().activeTab).toBe('dashboard');
  });
});
