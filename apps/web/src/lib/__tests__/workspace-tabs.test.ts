import { describe, expect, it, beforeEach } from 'vitest';
import { SYMBOL_TAB_LIMIT, useWorkspaceStore } from '@/stores';

describe('Trade symbol tabs', () => {
  beforeEach(() => useWorkspaceStore.setState({ symbol: 'NIFTY', exchange: 'NSE', tabs: [{ symbol: 'NIFTY', exchange: 'NSE' }, { symbol: 'BANKNIFTY', exchange: 'NSE' }] }));

  it('adds a newly opened symbol once, keeping order and the limit', () => {
    const s = useWorkspaceStore.getState();
    s.open('CRUDEOIL', 'MCX'); s.open('NIFTY', 'NSE'); s.open('CRUDEOIL', 'MCX');
    expect(useWorkspaceStore.getState().tabs.map((t) => t.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'CRUDEOIL']);
    for (let i = 0; i < 12; i++) useWorkspaceStore.getState().open(`S${i}`, 'NSE');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(SYMBOL_TAB_LIMIT);
  });

  it('closing the active tab moves to its neighbour; the last tab cannot be closed', () => {
    useWorkspaceStore.getState().closeTab('NIFTY', 'NSE');
    expect(useWorkspaceStore.getState()).toMatchObject({ symbol: 'BANKNIFTY', tabs: [{ symbol: 'BANKNIFTY', exchange: 'NSE' }] });
    useWorkspaceStore.getState().closeTab('BANKNIFTY', 'NSE');
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
  });
});
