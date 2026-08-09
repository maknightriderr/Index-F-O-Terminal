'use client';

import React, { useState, useEffect } from 'react';
import { Sidebar } from './sidebar';
import { TopBar } from './topbar';
import { AssetTabBar } from './asset-tab-bar';
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
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0f] text-gray-100 font-sans">
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex flex-col flex-1 min-w-0">
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
