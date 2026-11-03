import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button, Field } from '../components/ui';
import { LanguageSwitcher, ThemeToggle } from '../components/Preferences';
import { BrandMark } from '../components/Layout';
import { errorMessage } from '../lib/i18n';

export const localizedText = (value, locale) => (value && (value[locale] || value.en || value.ar)) || '';

/** Two-column branded shell shared by sign-in, registration, recovery and invitation pages. */
export function AuthShell({ heading, subheading, children }) {
  const { t } = useTranslation();
  const { platform, locale } = useApp();
  const tagline = localizedText(platform.tagline, locale);
  const contact = platform.supportEmail || platform.supportPhone;
  return (
    <div className="auth-page">
      <section className="auth-brand">
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
        <div className="auth-form">
          <div className="only-mobile auth-mobile-brand">
            <BrandMark logoUrl={platform.logoUrl} name={platform.appName} size={40} />
            <strong>{platform.appName}</strong>
          </div>
          {children}
        </div>
      </section>
    </div>
  );
}

/** kind="company": workspace sign-in · kind="platform": Super Admin console sign-in. */
export default function Login({ kind = 'company' }) {
  const { t } = useTranslation();
  const { platform, signIn, locale } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const admin = kind === 'platform';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await signIn(email, password, kind); } catch (err) { setError(err); setBusy(false); }
  }

  return (
    <AuthShell
      heading={admin ? t('auth.adminHeading') : localizedText(platform.loginHeading, locale) || t('auth.defaultHeading')}
      subheading={admin ? t('auth.adminSubheading') : localizedText(platform.loginSubheading, locale) || t('auth.defaultSubheading')}>
      <form onSubmit={submit} noValidate>
        {admin && <div className="admin-pill"><ShieldCheck size={14} aria-hidden />{t('auth.adminConsole')}</div>}
        <h2>{admin ? t('auth.adminSignIn') : t('auth.signInTitle')}</h2>
        {error && <div className="alert alert-error" role="alert">{errorMessage(t, error)}</div>}
        <Field label={t('auth.email')}>
          {id => <input id={id} type="email" dir="ltr" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />}
        </Field>
        <Field label={t('auth.password')}>
          {id => <input id={id} type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />}
        </Field>
        <Button variant="primary" type="submit" loading={busy} className="btn-block">{busy ? t('auth.signingIn') : t('auth.signIn')}</Button>
        <div className="auth-links">
          <Link to="/forgot-password">{t('auth.forgotPassword')}</Link>
          {!admin && platform.registrationEnabled && <span>{t('auth.noAccount')} <Link to="/register">{t('auth.registerCompany')}</Link></span>}
        </div>
      </form>
    </AuthShell>
  );
}
