import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../context/AppContext';
import { Button, Field } from '../components/ui';
import { LanguageSwitcher, ThemeToggle } from '../components/Preferences';
import { BrandMark } from '../components/Layout';
import { errorMessage } from '../lib/i18n';

export const localizedText = (value, locale) => (value && (value[locale] || value.en || value.ar)) || '';

export default function Login() {
  const { t } = useTranslation();
  const { platform, signIn, locale } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const heading = localizedText(platform.loginHeading, locale) || t('auth.defaultHeading');
  const subheading = localizedText(platform.loginSubheading, locale) || t('auth.defaultSubheading');
  const tagline = localizedText(platform.tagline, locale);
  const contact = platform.supportEmail || platform.supportPhone;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await signIn(email, password); } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <div className="auth-page">
      <section className="auth-brand" aria-hidden="false">
        <div className="auth-brand-top">
          <BrandMark logoUrl={platform.logoUrl} name={platform.appName} size={44} />
          <div>
            <strong className="auth-app-name">{platform.appName}</strong>
            {tagline && <small>{tagline}</small>}
          </div>
        </div>
        <div className="auth-brand-copy">
          <h1>{heading}</h1>
          <p>{subheading}</p>
        </div>
        {contact && <p className="auth-contact">{t('auth.contactSupport', { contact })}</p>}
      </section>

      <section className="auth-form-wrap">
        <div className="auth-tools"><LanguageSwitcher /><ThemeToggle /></div>
        <form className="auth-form" onSubmit={submit} noValidate>
          <div className="only-mobile auth-mobile-brand">
            <BrandMark logoUrl={platform.logoUrl} name={platform.appName} size={40} />
            <strong>{platform.appName}</strong>
          </div>
          <h2>{t('auth.signInTitle')}</h2>
          {error && <div className="alert alert-error" role="alert">{errorMessage(t, error)}</div>}
          <Field label={t('auth.email')}>
            {id => <input id={id} type="email" dir="ltr" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />}
          </Field>
          <Field label={t('auth.password')}>
            {id => <input id={id} type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />}
          </Field>
          <Button variant="primary" type="submit" loading={busy} className="btn-block">{busy ? t('auth.signingIn') : t('auth.signIn')}</Button>
        </form>
      </section>
    </div>
  );
}
