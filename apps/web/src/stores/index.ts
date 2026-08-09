// ============================================================
// GLOBAL STATE — ZUSTAND STORES
// ============================================================
// Central state management for the terminal. Each domain has
// its own slice. All stores are client-side only.
// ============================================================

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  Asset,
  WatchlistItem,
  MarketQuote,
  MarketBias,
  MarketRegime,
  SystemHealth,
  BiasDirection,
  ServiceStatus,
} from '@fno/shared';

// --- Market Data Store ---

interface MarketDataState {
  quotes: Record<string, MarketQuote>; // keyed by token
  selectedSymbol: string | null;
  selectedExchange: string;
  selectedExpiry: string | null;
  activeTab: string;

  // Actions
  updateQuote: (token: string, quote: MarketQuote) => void;
  updateQuotes: (quotes: Record<string, MarketQuote>) => void;
  setSelectedSymbol: (symbol: string | null) => void;
  setSelectedExchange: (exchange: string) => void;
  setSelectedExpiry: (expiry: string | null) => void;
  setActiveTab: (tab: string) => void;
}

export const useMarketStore = create<MarketDataState>()(
  persist(
    (set) => ({
      quotes: {},
      selectedSymbol: null,
      selectedExchange: 'NSE',
      selectedExpiry: null,
      activeTab: 'dashboard',

      updateQuote: (token, quote) =>
        set((state) => ({ quotes: { ...state.quotes, [token]: quote } })),

      updateQuotes: (quotes) =>
        set((state) => ({ quotes: { ...state.quotes, ...quotes } })),

      setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
      setSelectedExchange: (exchange) => set({ selectedExchange: exchange }),
      setSelectedExpiry: (expiry) => set({ selectedExpiry: expiry }),
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    {
      name: 'fno-market-selection',
      // Live tick data shouldn't survive a reload — only the user's
      // navigation/selection state (what a refresh should restore).
      partialize: (state) => ({
        selectedSymbol: state.selectedSymbol,
        selectedExchange: state.selectedExchange,
        selectedExpiry: state.selectedExpiry,
        activeTab: state.activeTab,
      }),
    }
  )
);

// --- Watchlist Store ---

interface WatchlistState {
  watchlists: Array<{ id: string; name: string; items: WatchlistItem[] }>;
  activeWatchlistId: string | null;

  addWatchlist: (name: string) => void;
  removeWatchlist: (id: string) => void;
  setActiveWatchlist: (id: string) => void;
  addItem: (watchlistId: string, item: WatchlistItem) => void;
  removeItem: (watchlistId: string, itemId: string) => void;
  updateItemQuote: (symbol: string, quote: Partial<WatchlistItem>) => void;
}

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set) => ({
      watchlists: [
        {
          id: 'default',
          name: 'My Watchlist',
          items: [
            { id: '1', symbol: 'NIFTY', exchange: 'NSE', sortOrder: 0 },
            { id: '2', symbol: 'BANKNIFTY', exchange: 'NSE', sortOrder: 1 },
            { id: '3', symbol: 'RELIANCE', exchange: 'NSE', sortOrder: 2 },
            { id: '4', symbol: 'HDFCBANK', exchange: 'NSE', sortOrder: 3 },
            { id: '5', symbol: 'ICICIBANK', exchange: 'NSE', sortOrder: 4 },
            { id: '6', symbol: 'INFY', exchange: 'NSE', sortOrder: 5 },
            { id: '7', symbol: 'TCS', exchange: 'NSE', sortOrder: 6 },
          ] as WatchlistItem[],
        },
      ],
      activeWatchlistId: 'default',

      addWatchlist: (name) =>
        set((state) => ({
          watchlists: [
            ...state.watchlists,
            { id: `wl_${Date.now()}`, name, items: [] },
          ],
        })),

      removeWatchlist: (id) =>
        set((state) => ({
          watchlists: state.watchlists.filter((w) => w.id !== id),
        })),

      setActiveWatchlist: (id) => set({ activeWatchlistId: id }),

      addItem: (watchlistId, item) =>
        set((state) => ({
          watchlists: state.watchlists.map((w) =>
            w.id === watchlistId ? { ...w, items: [...w.items, item] } : w
          ),
        })),

      removeItem: (watchlistId, itemId) =>
        set((state) => ({
          watchlists: state.watchlists.map((w) =>
            w.id === watchlistId
              ? { ...w, items: w.items.filter((i) => i.id !== itemId) }
              : w
          ),
        })),

      updateItemQuote: (symbol, quote) =>
        set((state) => ({
          watchlists: state.watchlists.map((w) => ({
            ...w,
            items: w.items.map((i) =>
              i.symbol === symbol ? { ...i, ...quote } : i
            ),
          })),
        })),
    }),
    { name: 'fno-watchlists' }
  )
);

// --- System Health Store ---

interface SystemHealthState {
  health: SystemHealth;
  updateHealth: (health: Partial<SystemHealth>) => void;
}

const defaultHealth: SystemHealth = {
  websocket: {
    status: 'DOWN',
    connected: false,
    reconnectCount: 0,
    errorCount: 0,
    subscriptionCount: 0,
    queueSize: 0,
  },
  api: { status: 'HEALTHY', responseTimeMs: 0, errorRate: 0 },
  database: { status: 'HEALTHY', connectionPoolSize: 10, activeConnections: 0 },
  redis: { status: 'HEALTHY', memoryUsed: '0MB', hitRate: 0 },
  dataFreshness: { status: 'DISCONNECTED', lastUpdate: 0, missingDataPercent: 0 },
  workers: { analytics: 'DOWN', strategy: 'DOWN', alert: 'DOWN' },
};

export const useSystemHealthStore = create<SystemHealthState>((set) => ({
  health: defaultHealth,
  updateHealth: (health) =>
    set((state) => ({
      health: { ...state.health, ...health },
    })),
}));

// --- UI Settings Store ---

interface UISettingsState {
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  bottomPanelOpen: boolean;
  bottomPanelHeight: number;
  theme: 'dark' | 'light';
  addAssetModalOpen: boolean;

  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  toggleBottomPanel: () => void;
  setBottomPanelHeight: (height: number) => void;
  setTheme: (theme: 'dark' | 'light') => void;
  openAddAssetModal: () => void;
  closeAddAssetModal: () => void;
}

export const useUISettingsStore = create<UISettingsState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      rightPanelOpen: true,
      bottomPanelOpen: false,
      bottomPanelHeight: 350,
      theme: 'dark',
      addAssetModalOpen: false,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
      toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
      setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
      setTheme: (theme) => set({ theme }),
      openAddAssetModal: () => set({ addAssetModalOpen: true }),
      closeAddAssetModal: () => set({ addAssetModalOpen: false }),
    }),
    {
      name: 'fno-ui-settings',
      // Never persist transient UI state like an open modal across reloads.
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
        rightPanelOpen: state.rightPanelOpen,
        bottomPanelOpen: state.bottomPanelOpen,
        bottomPanelHeight: state.bottomPanelHeight,
        theme: state.theme,
      }),
    }
  )
);
