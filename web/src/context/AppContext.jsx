import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, setCsrfToken, setUnauthorizedHandler } from '../lib/api';
import { detectLocale, readSavedLocale, saveLocale, browserLanguages } from '../lib/locale';
import { applyBranding, effectiveTheme, readSavedTheme, resolveThemePreference, saveTheme } from '../lib/theme';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export function AppProvider({ children }) {
  const { i18n } = useTranslation();
  const [platform, setPlatform] = useState(null);
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [themePref, setThemePref] = useState(() => readSavedTheme() || 'system');

  const loadMe = useCallback(async () => {
    try {
      const data = await api.get('/api/auth/me');
      setCsrfToken(data.csrfToken);
      setMe(data);
      return data;
    } catch (error) {
      if (error.status === 401) { setMe(null); setCsrfToken(null); return null; }
      throw error;
    }
  }, []);

  const boot = useCallback(async () => {
    setBootError(null);
    try {
      const brand = await api.get('/api/public/branding');
      setPlatform(brand);
      const data = await loadMe();
      // Manual choice on this device made before signing in is carried to the account.
      const saved = readSavedLocale();
      if (data && !data.user.locale && saved) api.patch('/api/me/preferences', { locale: saved }).catch(() => {});
      i18n.changeLanguage(detectLocale({ account: data?.user.locale, saved, languages: browserLanguages(), fallback: brand.defaultLocale }));
      setThemePref(resolveThemePreference({ account: data?.user.theme, saved: readSavedTheme(), fallback: brand.defaultTheme }));
    } catch (error) {
      setBootError(error);
    } finally {
      setReady(true);
    }
  }, [i18n, loadMe]);

  useEffect(() => { boot(); }, [boot]);
  useEffect(() => { setUnauthorizedHandler(() => { setMe(null); setCsrfToken(null); }); }, []);

  // Theme: apply and follow OS changes when set to "system".
  useEffect(() => {
    const apply = () => document.documentElement.setAttribute('data-theme', effectiveTheme(themePref));
    apply();
    const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [themePref]);

  // Branding: company branding (inside a workspace) overrides platform colors; never the reverse.
  useEffect(() => {
    if (!platform) return;
    const cb = me?.company?.branding;
    applyBranding({
      primary: cb?.primaryColor || platform.primaryColor,
      secondary: cb?.secondaryColor || platform.secondaryColor,
      accent: cb?.accentColor || platform.accentColor,
      font: platform.fontFamily,
      faviconUrl: platform.faviconUrl,
      title: platform.appName
    });
  }, [platform, me]);

  const setLocale = useCallback(locale => {
    saveLocale(locale);
    i18n.changeLanguage(locale);
    if (me) api.patch('/api/me/preferences', { locale }).catch(() => {});
  }, [i18n, me]);

  const setTheme = useCallback(theme => {
    saveTheme(theme);
    setThemePref(theme);
    if (me) api.patch('/api/me/preferences', { theme }).catch(() => {});
  }, [me]);

  const signIn = useCallback(async (email, password) => {
    await api.post('/api/auth/login', { email, password });
    const data = await loadMe();
    const saved = readSavedLocale();
    if (data.user.locale) { saveLocale(data.user.locale); i18n.changeLanguage(data.user.locale); }
    else if (saved) api.patch('/api/me/preferences', { locale: saved }).catch(() => {});
    if (data.user.theme) { saveTheme(data.user.theme); setThemePref(data.user.theme); }
    return data;
  }, [i18n, loadMe]);

  const signOut = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* already signed out */ }
    setMe(null);
    setCsrfToken(null);
  }, []);

  const switchCompany = useCallback(async companyId => {
    await api.post('/api/auth/switch-company', { companyId });
    await loadMe();
  }, [loadMe]);

  const can = useCallback(perm => Boolean(me?.permissions?.includes(perm)), [me]);

  const value = useMemo(() => ({
    platform, setPlatform, me, ready, bootError, boot, reloadMe: loadMe, signIn, signOut, switchCompany,
    can, locale: i18n.language, setLocale, themePref, setTheme
  }), [platform, me, ready, bootError, boot, loadMe, signIn, signOut, switchCompany, can, i18n.language, setLocale, themePref, setTheme]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
