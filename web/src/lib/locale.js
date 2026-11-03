export const SUPPORTED_LOCALES = ['ar', 'en'];
export const RTL_LOCALES = ['ar'];
const STORAGE_KEY = 'sscrm.locale';

/**
 * Decide the UI language.
 *  1. A language the user chose manually (saved on their account, or on this device before login).
 *  2. Otherwise the device/browser languages, in order of preference (ar* → Arabic, en* → English).
 *  3. Otherwise the platform default.
 * Automatic detection never overrides a manual choice.
 */
export function detectLocale({ account, saved, languages, fallback = 'en' }) {
  if (SUPPORTED_LOCALES.includes(account)) return account;
  if (SUPPORTED_LOCALES.includes(saved)) return saved;
  for (const lang of languages || []) {
    const base = String(lang || '').toLowerCase().split('-')[0];
    if (SUPPORTED_LOCALES.includes(base)) return base;
  }
  return SUPPORTED_LOCALES.includes(fallback) ? fallback : 'en';
}

export const directionOf = locale => (RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr');

export function readSavedLocale() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function saveLocale(locale) {
  try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* storage unavailable */ }
}

export function browserLanguages() {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}
