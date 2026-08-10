'use client';

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { api } from '@/lib/api';
import { useWatchlistStore, useAssetTabsStore } from '@/stores';
import { generateId } from '@fno/shared';
import type { Exchange } from '@fno/shared';

interface AddAssetModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddAssetModal({ isOpen, onClose }: AddAssetModalProps) {
  const [assetType, setAssetType] = useState<'INDEX' | 'F&O STOCK'>('INDEX');
  const [exchange, setExchange] = useState<'NSE' | 'BSE' | 'MCX'>('NSE');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { addItem, activeWatchlistId } = useWatchlistStore();
  const { openTab } = useAssetTabsStore();

  // Focus input on open
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Search with debounce
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    setSelected(null);

    clearTimeout(searchTimer.current);
    if (query.length < 1) {
      setResults([]);
      return;
    }

    searchTimer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.searchInstruments(query, exchange);
        setResults(data.slice(0, 20));
      } catch {
        // Fallback to local search for demo
        const demoResults = getDemoResults(query, assetType);
        setResults(demoResults);
      }
      setLoading(false);
    }, 300);
  }, [exchange, assetType]);

  const handleSelect = (item: any) => {
    setSelected(item);
  };

  const handleAdd = () => {
    if (!selected || !activeWatchlistId) return;

    const symbol: string = selected.underlying || selected.symbol || selected.name;
    const resolvedExchange = (selected.exchange || exchange) as Exchange;

    addItem(activeWatchlistId, {
      id: generateId(),
      symbol,
      exchange: resolvedExchange,
      sortOrder: 999,
    });

    // Opens (or focuses, if already open) a persistent tab for this asset —
    // its workspace (spot/futures/option chain) auto-discovers expiries and
    // loads on its own; nothing more to prefetch here.
    openTab(symbol, resolvedExchange);

    onClose();
    setSearchQuery('');
    setResults([]);
    setSelected(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[#12121a] light:bg-white border border-gray-800/50 light:border-slate-200 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800/50 light:border-slate-200">
          <h2 className="text-base font-semibold text-gray-100 light:text-slate-900">+ Add Asset</h2>
          <button
            onClick={onClose}
            className="text-gray-500 light:text-slate-400 hover:text-gray-300 light:hover:text-slate-600 text-lg transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Asset Type */}
        <div className="px-5 pt-4 pb-2">
          <label className="text-xs text-gray-500 light:text-slate-500 mb-2 block">Asset Type</label>
          <div className="flex gap-2">
            {(['INDEX', 'F&O STOCK'] as const).map((type) => (
              <button
                key={type}
                onClick={() => setAssetType(type)}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                  assetType === type
                    ? 'bg-emerald-500/15 text-emerald-400 light:text-emerald-700 border border-emerald-500/30'
                    : 'bg-gray-800/50 light:bg-slate-100 text-gray-400 light:text-slate-500 border border-gray-700/30 light:border-slate-200 hover:bg-gray-800 light:hover:bg-slate-200'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        {/* Exchange */}
        <div className="px-5 pt-2 pb-2">
          <label className="text-xs text-gray-500 light:text-slate-500 mb-2 block">Exchange</label>
          <div className="flex gap-2">
            {(['NSE', 'BSE', 'MCX'] as const).map((exch) => (
              <button
                key={exch}
                onClick={() => setExchange(exch)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  exchange === exch
                    ? 'bg-cyan-500/15 text-cyan-400 light:text-cyan-700 border border-cyan-500/30'
                    : 'bg-gray-800/50 light:bg-slate-100 text-gray-400 light:text-slate-500 border border-gray-700/30 light:border-slate-200 hover:bg-gray-800 light:hover:bg-slate-200'
                }`}
              >
                {exch}
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="px-5 pt-2 pb-3">
          <label className="text-xs text-gray-500 light:text-slate-500 mb-2 block">Search</label>
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={assetType === 'INDEX' ? 'NIFTY, BANKNIFTY, SENSEX...' : 'RELIANCE, HDFCBANK, INFY...'}
            className="w-full bg-gray-900/50 light:bg-slate-50 border border-gray-700/50 light:border-slate-200 rounded-lg px-4 py-2.5 text-sm text-gray-200 light:text-slate-800 placeholder-gray-600 light:placeholder-slate-400 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-colors"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-5 pb-3 min-h-[120px]">
          {loading && (
            <div className="text-xs text-gray-500 light:text-slate-500 py-4 text-center">Searching...</div>
          )}
          {!loading && results.length === 0 && searchQuery.length > 0 && (
            <div className="text-xs text-gray-500 light:text-slate-500 py-4 text-center">
              No instruments found for "{searchQuery}"
            </div>
          )}
          {!loading && results.length > 0 && (
            <div className="space-y-1">
              {results.map((item, i) => (
                <button
                  key={i}
                  onClick={() => handleSelect(item)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                    selected === item
                      ? 'bg-emerald-500/15 border border-emerald-500/30'
                      : 'hover:bg-gray-800/50 light:hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-gray-200 light:text-slate-800 font-medium">
                        {item.symbol || item.name}
                      </span>
                      {item.name && item.name !== item.symbol && (
                        <span className="text-gray-500 light:text-slate-500 text-xs ml-2">
                          {item.name}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500 light:text-slate-500">
                      <span>{item.exchange || exchange}</span>
                      {item.lotSize && (
                        <span>Lot: {item.lotSize}</span>
                      )}
                    </div>
                  </div>
                  {selected === item && (
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-gray-500 light:text-slate-500">
                      <div>Type: <span className="text-gray-400 light:text-slate-600">{item.instrumentType || assetType}</span></div>
                      <div>Token: <span className="text-gray-400 light:text-slate-600">{item.token || '—'}</span></div>
                      <div>Segment: <span className="text-gray-400 light:text-slate-600">{item.segment || '—'}</span></div>
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-800/50 light:border-slate-200">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 light:text-slate-500 hover:text-gray-200 light:hover:text-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleAdd}
            disabled={!selected}
            className={`px-5 py-2 text-sm font-medium rounded-lg transition-colors ${
              selected
                ? 'bg-emerald-500 text-black hover:bg-emerald-400'
                : 'bg-gray-800 light:bg-slate-200 text-gray-600 light:text-slate-400 cursor-not-allowed'
            }`}
          >
            Add to Watchlist
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Demo Results (when API is unavailable) ---

function getDemoResults(query: string, type: string) {
  const indices = [
    { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE', instrumentType: 'INDEX', token: '99926000', lotSize: 25, segment: 'CM' },
    { symbol: 'BANKNIFTY', name: 'BANK NIFTY', exchange: 'NSE', instrumentType: 'INDEX', token: '99926009', lotSize: 15, segment: 'CM' },
    { symbol: 'FINNIFTY', name: 'FINNIFTY', exchange: 'NSE', instrumentType: 'INDEX', token: '99926037', lotSize: 25, segment: 'CM' },
    { symbol: 'MIDCPNIFTY', name: 'MIDCP NIFTY', exchange: 'NSE', instrumentType: 'INDEX', token: '99926074', lotSize: 50, segment: 'CM' },
    { symbol: 'SENSEX', name: 'SENSEX', exchange: 'BSE', instrumentType: 'INDEX', token: '99919000', lotSize: 10, segment: 'CM' },
    { symbol: 'BANKEX', name: 'BANKEX', exchange: 'BSE', instrumentType: 'INDEX', token: '99919067', lotSize: 15, segment: 'CM' },
  ];

  const stocks = [
    { symbol: 'RELIANCE', name: 'Reliance Industries', exchange: 'NSE', instrumentType: 'EQ', token: '2885', lotSize: 250, segment: 'CM' },
    { symbol: 'HDFCBANK', name: 'HDFC Bank', exchange: 'NSE', instrumentType: 'EQ', token: '1333', lotSize: 550, segment: 'CM' },
    { symbol: 'ICICIBANK', name: 'ICICI Bank', exchange: 'NSE', instrumentType: 'EQ', token: '4963', lotSize: 700, segment: 'CM' },
    { symbol: 'INFY', name: 'Infosys', exchange: 'NSE', instrumentType: 'EQ', token: '1594', lotSize: 300, segment: 'CM' },
    { symbol: 'TCS', name: 'Tata Consultancy Services', exchange: 'NSE', instrumentType: 'EQ', token: '11536', lotSize: 150, segment: 'CM' },
    { symbol: 'SBIN', name: 'State Bank of India', exchange: 'NSE', instrumentType: 'EQ', token: '3045', lotSize: 750, segment: 'CM' },
    { symbol: 'AXISBANK', name: 'Axis Bank', exchange: 'NSE', instrumentType: 'EQ', token: '5900', lotSize: 625, segment: 'CM' },
    { symbol: 'TATASTEEL', name: 'Tata Steel', exchange: 'NSE', instrumentType: 'EQ', token: '3499', lotSize: 5000, segment: 'CM' },
    { symbol: 'BAJFINANCE', name: 'Bajaj Finance', exchange: 'NSE', instrumentType: 'EQ', token: '317', lotSize: 125, segment: 'CM' },
    { symbol: 'MARUTI', name: 'Maruti Suzuki', exchange: 'NSE', instrumentType: 'EQ', token: '10999', lotSize: 50, segment: 'CM' },
  ];

  const list = type === 'INDEX' ? indices : stocks;
  const q = query.toUpperCase();

  return list.filter(
    (item) =>
      item.symbol.includes(q) ||
      item.name.toUpperCase().includes(q)
  );
}
