'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from './sidebar';
import { TopBar } from './topbar';
import { AssetTabBar } from './asset-tab-bar';
import { ThemeEffect } from '@/components/theme-effect';
import { useUISettingsStore } from '@/stores';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { sidebarOpen, rightPanelOpen, bottomPanelOpen, bottomPanelHeight } = useUISettingsStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null; // Prevent hydration mismatch with persisted state

  return (
    // h-[100dvh] not h-screen: 100vh on mobile browsers measures the viewport
    // as if the address bar were hidden, so the bottom of the app sat
    // permanently under the browser chrome. dvh tracks the visible area as
    // that bar collapses. w-full not w-screen: 100vw includes the scrollbar
    // gutter, which is what produces a phantom horizontal scroll.
    <div className="noise-overlay ambient-bg flex h-[100dvh] w-full overflow-hidden bg-[#0a0a0f] light:bg-slate-50 text-gray-100 light:text-slate-900 font-sans">
      <ThemeEffect />
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex flex-col flex-1 min-w-0 relative z-[1]">
        {/* Top Bar */}
        <TopBar />

        {/* Asset Tabs (only rendered once at least one asset is open) */}
        <AssetTabBar />

        {/* Content */}
        <div className="flex flex-1 min-h-0">
          {/* Center Panel */}
          <main className="flex-1 min-w-0 overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </div>
  );
}
