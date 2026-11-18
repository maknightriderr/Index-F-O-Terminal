'use client';

// ============================================================
// SETTINGS MENU — one ⚙ in the header for theme, the index ticker and sign-out (redesign: a quieter header)
// ============================================================

import React, { useEffect, useRef } from 'react';
import { useUISettingsStore } from '@/stores';
import type { ThemeName } from '@/stores';
import { SignOutButton } from '@/components/auth/sign-out-button';

const THEMES: Array<{ value: ThemeName; icon: string; label: string }> = [
  { value: 'dark', icon: '◐', label: 'Dark' },
  { value: 'light', icon: '☼', label: 'Light' },
  { value: 'system', icon: '▣', label: 'System' },
];

export function SettingsMenu() {
  const { theme, setTheme, showTicker, toggleTicker } = useUISettingsStore();
  const ref = useRef<HTMLDetailsElement>(null);
  // Closes on Escape and on a click outside.
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !d.contains(e.target as Node)) d.open = false;
    };
    document.addEventListener('keydown', close);
    document.addEventListener('mousedown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('mousedown', close); };
  }, []);
  const current = THEMES.find((t) => t.value === theme) ?? THEMES[0];
  return (
    <details ref={ref} className="terminal-settings">
      <summary aria-label={`Settings · theme ${current.label}`} title="Theme, ticker and sign-out"><span aria-hidden="true">⚙</span></summary>
      <div className="terminal-settings-pop" role="group" aria-label="Settings">
        <p className="desk-eyebrow">Theme</p>
        <div role="radiogroup" aria-label="Theme" className="terminal-settings-themes">
          {THEMES.map((t) => (
            <button key={t.value} type="button" role="radio" aria-checked={theme === t.value} aria-label={`${t.label} theme`} onClick={() => setTheme(t.value)}>
              <span aria-hidden="true">{t.icon}</span> {t.label}
            </button>
          ))}
        </div>
        <label className="terminal-settings-row">
          <input type="checkbox" checked={showTicker} onChange={toggleTicker} /> Index ticker above the header
        </label>
        <div className="terminal-settings-row"><SignOutButton /></div>
      </div>
    </details>
  );
}
