'use client';

import { useEffect } from 'react';
import { useUISettingsStore } from '@/stores';

/**
 * Applies the persisted theme choice to <html data-theme="...">, which
 * globals.css and every component's `light:` Tailwind variant key off.
 * "system" resolves via prefers-color-scheme and stays live-updated if
 * the OS setting changes while the tab is open.
 */
export function ThemeEffect() {
  const theme = useUISettingsStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;

    if (theme !== 'system') {
      root.dataset.theme = theme;
      return;
    }

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      root.dataset.theme = media.matches ? 'light' : 'dark';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  return null;
}
