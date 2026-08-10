'use client';

import React from 'react';
import { useUISettingsStore } from '@/stores';

export function AddAssetButton({ compact }: { compact?: boolean }) {
  const openAddAssetModal = useUISettingsStore((s) => s.openAddAssetModal);

  return (
    <button
      onClick={openAddAssetModal}
      title="Add Asset"
      className={`flex items-center gap-2 bg-emerald-500/10 hover:bg-emerald-500/20 light:hover:bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 light:text-emerald-700 text-sm font-medium rounded-lg transition-colors ${
        compact ? 'justify-center px-2 py-2' : 'px-4 py-2'
      }`}
    >
      <span className="text-base leading-none">+</span>
      {!compact && 'Add Asset'}
    </button>
  );
}
