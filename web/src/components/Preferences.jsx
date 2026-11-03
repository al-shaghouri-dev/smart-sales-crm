import { useTranslation } from 'react-i18next';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useApp } from '../context/AppContext';

export function LanguageSwitcher() {
  const { t } = useTranslation();
  const { locale, setLocale } = useApp();
  const next = locale === 'ar' ? 'en' : 'ar';
  return (
    <button type="button" className="pref-btn" onClick={() => setLocale(next)} aria-label={t('common.language')} title={t('common.language')}>
      <Languages size={16} aria-hidden />
      <span lang={next}>{next === 'ar' ? t('common.arabic') : t('common.english')}</span>
    </button>
  );
}

const ORDER = ['light', 'dark', 'system'];
const ICONS = { light: Sun, dark: Moon, system: Monitor };

export function ThemeToggle() {
  const { t } = useTranslation();
  const { themePref, setTheme } = useApp();
  const Icon = ICONS[themePref] || Monitor;
  const next = ORDER[(ORDER.indexOf(themePref) + 1) % ORDER.length];
  return (
    <button type="button" className="pref-btn icon-only" onClick={() => setTheme(next)}
      aria-label={`${t('common.theme')}: ${t(`common.${themePref}`)}`} title={`${t('common.theme')}: ${t(`common.${themePref}`)}`}>
      <Icon size={16} aria-hidden />
    </button>
  );
}
