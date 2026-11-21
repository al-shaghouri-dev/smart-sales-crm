import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { KeyRound, ShieldCheck } from 'lucide-react';
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
  const { platform, signIn, completeMfa, locale } = useApp();
  const [ticket, setTicket] = useState(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const admin = kind === 'platform';

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await signIn(email, password, kind);
      if (r?.mfaRequired) { setTicket(r.ticket); setPassword(''); setBusy(false); }
    } catch (err) { setError(err); setBusy(false); }
  }

  async function submitCode(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await completeMfa(ticket, code); } catch (err) {
      setError(err); setBusy(false); setCode('');
      if (err.code === 'auth.mfa_expired') { setTicket(null); setUseRecovery(false); }
    }
  }

  return (
    <AuthShell
      heading={admin ? t('auth.adminHeading') : localizedText(platform.loginHeading, locale) || t('auth.defaultHeading')}
      subheading={admin ? t('auth.adminSubheading') : localizedText(platform.loginSubheading, locale) || t('auth.defaultSubheading')}>
      {ticket ? (
        <form onSubmit={submitCode} noValidate>
          <div className="admin-pill"><KeyRound size={14} aria-hidden />{t('auth.mfaStep')}</div>
          <h2>{t('auth.mfaTitle')}</h2>
          <p className="muted form-intro">{useRecovery ? t('auth.mfaRecoveryHelp') : t('auth.mfaHelp')}</p>
          {error && <div className="alert alert-error" role="alert">{errorMessage(t, error)}</div>}
          <Field label={useRecovery ? t('auth.recoveryCode') : t('auth.mfaCode')}>
            {id => useRecovery
              ? <input id={id} dir="ltr" autoComplete="one-time-code" autoFocus required value={code} onChange={e => setCode(e.target.value)} placeholder="xxxx-xxxx" />
              : <input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={6} pattern="[0-9]*" className="otp-input"
                  value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" />}
          </Field>
          <Button variant="primary" type="submit" loading={busy} disabled={useRecovery ? code.length < 8 : code.length !== 6} className="btn-block">{t('auth.verify')}</Button>
          <div className="auth-links">
            <button type="button" className="link-btn" onClick={() => { setUseRecovery(x => !x); setCode(''); setError(null); }}>{useRecovery ? t('auth.useAuthenticator') : t('auth.useRecovery')}</button>
            <button type="button" className="link-btn" onClick={() => { setTicket(null); setCode(''); setError(null); }}>{t('auth.backToSignIn')}</button>
          </div>
        </form>
      ) : (
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
      )}
    </AuthShell>
  );
}
