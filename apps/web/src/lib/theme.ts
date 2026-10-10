// ============================================================
// THEME RESOLUTION — dark by default, no flash on first paint
// ============================================================
// The terminal is dark-first, but the settings store's default had been
// 'light', so a fresh visitor got a white page (and every chart and table
// built for dark looked wrong). Also, the theme was only applied after React
// hydrated, so a returning user saw the wrong theme for a moment.
//
// resolveStoredTheme is the ONE rule. It is used by:
//   * the inline script in app/layout.tsx (runs before first paint, via toString()), and
//   * the settings store's persisted-state migration,
// so the pre-paint theme and the hydrated theme can never disagree. It must stay
// dependency-free: it is serialised into the page.
// ============================================================

export type ThemeName = 'dark' | 'light' | 'system';
export const THEME_STORAGE_KEY = 'fno-ui-settings';
/** Bump when the persisted shape / default changes (see migrateUiSettings). */
export const UI_SETTINGS_VERSION = 2;

/**
 * The theme to apply, from the raw persisted settings string.
 * - nothing stored, or unreadable: 'dark' (the default)
 * - version 1 stored 'light' as the DEFAULT (nobody had picked it), so a v1 'light' is treated as unset → 'dark'
 * - 'dark', 'system' and a v2 'light' are explicit choices and are kept
 */
export function resolveStoredTheme(raw: string | null | undefined): ThemeName {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const theme = parsed && parsed.state ? parsed.state.theme : null;
    const version = parsed && typeof parsed.version === 'number' ? parsed.version : 0;
    if (theme !== 'dark' && theme !== 'light' && theme !== 'system') return 'dark';
    if (theme === 'light' && version < 2) return 'dark';
    return theme;
  } catch {
    return 'dark';
  }
}

/** The concrete data-theme for a theme choice (system follows the OS). */
export function concreteTheme(theme: ThemeName, prefersLight: boolean): 'dark' | 'light' {
  return theme === 'system' ? (prefersLight ? 'light' : 'dark') : theme;
}

/** Script text for <head>: applies the stored theme before the first paint. */
export function themeBootstrapScript(): string {
  return `(function(){try{
var resolve=${resolveStoredTheme.toString()};
var t=resolve(localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}));
var light=t==='system'?window.matchMedia('(prefers-color-scheme: light)').matches:t==='light';
document.documentElement.setAttribute('data-theme',light?'light':'dark');
}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;
}

/** Persisted-state migration for the UI settings store. */
export function migrateUiSettings(persisted: unknown, version: number): Record<string, unknown> {
  const state = (persisted && typeof persisted === 'object' ? { ...(persisted as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (version < 2 && (state.theme === 'light' || state.theme == null)) state.theme = 'dark';
  return state;
}
