import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MailCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, Field } from '../components/ui';
import { AuthShell } from './Login';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const { locale } = useApp();
  const [email, setEmail] = useState('');
  const [state, setState] = useState({ busy: false, done: null, error: null });

  async function submit(e) {
    e.preventDefault();
    setState({ busy: true, done: null, error: null });
    try {
      const r = await api.post('/api/auth/forgot-password', { email, locale });
      setState({ busy: false, done: r, error: null });
    } catch (error) { setState({ busy: false, done: null, error }); }
  }

  return (
    <AuthShell heading={t('recovery.heading')} subheading={t('recovery.subheading')}>
      <h2>{t('recovery.title')}</h2>
      {state.done ? (
        <div className="stack">
          <div className="alert alert-success"><MailCheck size={16} aria-hidden />{state.done.emailEnabled ? t('recovery.sent') : t('recovery.noEmail')}</div>
          <Link to="/login">{t('recovery.backToSignIn')}</Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <p className="muted form-intro">{t('recovery.intro')}</p>
          {state.error && <div className="alert alert-error" role="alert">{errorMessage(t, state.error)}</div>}
          <Field label={t('auth.email')}>{id => <input id={id} type="email" dir="ltr" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />}</Field>
          <Button variant="primary" type="submit" loading={state.busy} className="btn-block">{t('recovery.send')}</Button>
          <div className="auth-links"><Link to="/login">{t('recovery.backToSignIn')}</Link></div>
        </form>
      )}
    </AuthShell>
  );
}
