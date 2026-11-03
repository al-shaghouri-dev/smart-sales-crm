const STORAGE_KEY = 'sscrm.theme';
export const THEMES = ['light', 'dark', 'system'];

/** Same precedence as language: manual choice (account, then device) → platform default. */
export function resolveThemePreference({ account, saved, fallback = 'system' }) {
  if (THEMES.includes(account)) return account;
  if (THEMES.includes(saved)) return saved;
  return THEMES.includes(fallback) ? fallback : 'system';
}

export function effectiveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readSavedTheme() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
export function saveTheme(theme) {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
}

/** Accessible text color for a given background hex. */
export function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? '#0f172a' : '#ffffff';
}

const FONT_URLS = {
  Cairo: 'Cairo:wght@400;500;600;700;800',
  Inter: 'Inter:wght@400;500;600;700;800',
  'IBM Plex Sans Arabic': 'IBM+Plex+Sans+Arabic:wght@400;500;600;700',
  Tajawal: 'Tajawal:wght@400;500;700;800',
  'Noto Sans Arabic': 'Noto+Sans+Arabic:wght@400;500;600;700'
};

/** Apply platform/company branding as CSS variables (no hardcoded brand anywhere in the code). */
export function applyBranding({ primary, secondary, accent, font, faviconUrl, title }) {
  const root = document.documentElement;
  if (primary) { root.style.setProperty('--primary', primary); root.style.setProperty('--on-primary', contrastText(primary)); }
  if (secondary) root.style.setProperty('--secondary', secondary);
  if (accent) root.style.setProperty('--accent', accent);
  if (font) {
    root.style.setProperty('--font', font === 'system-ui' ? 'system-ui' : `"${font}"`);
    if (FONT_URLS[font] && !document.getElementById(`font-${font}`)) {
      const link = document.createElement('link');
      link.id = `font-${font}`;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${FONT_URLS[font]}&display=swap`;
      document.head.appendChild(link);
    }
  }
  if (title) document.title = title;
  const icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = faviconUrl || 'data:,';
}
