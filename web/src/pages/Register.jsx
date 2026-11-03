import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, Field, fieldError, fmtMoney, localized, useLoader } from '../components/ui';
import { AuthShell, localizedText } from './Login';

/** Public self-service registration. Creates a request only — no access until a Super Admin approves it. */
export default function Register() {
  const { t } = useTranslation();
  const { platform, locale } = useApp();
  const plans = useLoader(() => api.get('/api/public/plans').then(r => r.plans), []);
  const [form, setForm] = useState({ companyName: '', businessType: '', country: '', companyPhone: '', ownerName: '', ownerEmail: '', ownerPhone: '', planId: '', website: '' });
  const [state, setState] = useState({ busy: false, error: null, done: false });
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));

  const heading = localizedText(platform.registrationHeading, locale) || t('register.defaultHeading');
  const sub = localizedText(platform.registrationSubheading, locale) || t('register.defaultSubheading');

  async function submit(e) {
    e.preventDefault();
    setState({ busy: true, error: null, done: false });
    try {
      await api.post('/api/public/register', { ...form, planId: form.planId || undefined, locale });
      setState({ busy: false, error: null, done: true });
    } catch (error) { setState({ busy: false, error, done: false }); }
  }

  if (!platform.registrationEnabled) {
    return <AuthShell heading={heading} subheading={sub}><div className="alert alert-info">{t('errors.registration.closed')}</div><Link to="/login">{t('recovery.backToSignIn')}</Link></AuthShell>;
  }

  return (
    <AuthShell heading={heading} subheading={sub}>
      {state.done ? (
        <div className="stack">
          <div className="alert alert-success"><CheckCircle2 size={16} aria-hidden />{t('register.submitted')}</div>
          <p className="muted">{t('register.nextSteps')}</p>
          <Link to="/login">{t('recovery.backToSignIn')}</Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="register-form">
          <h2>{t('register.title')}</h2>
          {state.error && !state.error.details && <div className="alert alert-error" role="alert">{errorMessage(t, state.error)}</div>}
          <fieldset>
            <legend>{t('register.company')}</legend>
            <Field label={t('company.name')} error={fieldError(t, state.error, 'companyName')}>{id => <input id={id} required maxLength={120} autoComplete="organization" value={form.companyName} onChange={set('companyName')} />}</Field>
            <div className="form-grid">
              <Field label={t('company.businessType')}>{id => <input id={id} maxLength={120} value={form.businessType} onChange={set('businessType')} />}</Field>
              <Field label={t('company.country')}>{id => <input id={id} maxLength={80} autoComplete="country-name" value={form.country} onChange={set('country')} />}</Field>
            </div>
          </fieldset>
          <fieldset>
            <legend>{t('register.owner')}</legend>
            <Field label={t('team.name')} error={fieldError(t, state.error, 'ownerName')}>{id => <input id={id} required maxLength={120} autoComplete="name" value={form.ownerName} onChange={set('ownerName')} />}</Field>
            <div className="form-grid">
              <Field label={t('auth.email')} error={fieldError(t, state.error, 'ownerEmail')}>{id => <input id={id} type="email" dir="ltr" required autoComplete="email" value={form.ownerEmail} onChange={set('ownerEmail')} />}</Field>
              <Field label={t('team.phone')} error={fieldError(t, state.error, 'ownerPhone')}>{id => <input id={id} type="tel" dir="ltr" required autoComplete="tel" value={form.ownerPhone} onChange={set('ownerPhone')} />}</Field>
            </div>
          </fieldset>
          {plans.data?.length > 0 && (
            <fieldset>
              <legend>{t('register.plan')}</legend>
              <div className="plan-options">
                {plans.data.map(p => (
                  <label key={p.id} className={`plan-option ${form.planId === p.id ? 'selected' : ''}`}>
                    <input type="radio" name="plan" value={p.id} checked={form.planId === p.id} onChange={set('planId')} />
                    <strong>{localized(p.name, locale)}</strong>
                    <span className="plan-price">{fmtMoney(p.price, p.currency, locale)} <small>/ {t(`plans.per.${p.interval}`, { days: p.durationDays })}</small></span>
                    {p.maxEmployees && <small className="muted">{t('plans.seats', { count: p.maxEmployees })}</small>}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {/* Honeypot for bots: hidden from people and assistive tech. */}
          <input className="hp" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" value={form.website} onChange={set('website')} />
          <p className="hint">{t('register.reviewNote')}</p>
          <Button variant="primary" type="submit" loading={state.busy} className="btn-block">{t('register.submit')}</Button>
          <div className="auth-links"><span>{t('register.haveAccount')} <Link to="/login">{t('auth.signIn')}</Link></span></div>
        </form>
      )}
    </AuthShell>
  );
}
