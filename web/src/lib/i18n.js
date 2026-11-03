import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import ar from '../locales/ar.json';
import { detectLocale, directionOf, readSavedLocale, browserLanguages } from './locale';

// To add a language: create locales/<code>.json, register it here and in SUPPORTED_LOCALES.
i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ar: { translation: ar } },
  lng: detectLocale({ saved: readSavedLocale(), languages: browserLanguages() }),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React already escapes output
  returnNull: false
});

export function applyDocumentLocale(locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = directionOf(locale);
}
applyDocumentLocale(i18n.language);
i18n.on('languageChanged', applyDocumentLocale);

/** Translate an API error code (falls back to a generic message). */
export function errorMessage(t, error) {
  const code = error?.code || 'common.server_error';
  return t(`errors.${code}`, { defaultValue: t('errors.common.server_error') });
}

export default i18n;
