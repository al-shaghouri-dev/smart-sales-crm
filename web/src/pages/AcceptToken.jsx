import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, LinkIcon } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, Field, Spinner, fieldError, useLoader } from '../components/ui';
import { AuthShell } from './Login';

/** Accept an invitation or complete a password reset from a one-time link. */
export default function AcceptToken() {
  const { t } = useTranslation();
  const { token } = useParams();
  const { pathname } = useLocation();
  const { me, signOut } = useApp();
  const invite = pathname.startsWith('/invite/');
  const { data, loading, error } = useLoader(() => api.get(`/api/auth/token/${encodeURIComponent(token)}`), [token]);
  const [form, setForm] = useState({ name: '', password: '', confirm: '' });
  const [state, setState] = useState({ busy: false, error: null, done: false });

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) return setState(s => ({ ...s, error: { code: 'validation.password_mismatch', details: { field: 'confirm' } } }));
    setState({ busy: true, error: null, done: false });
    try {
      await api.post(`/api/auth/token/${encodeURIComponent(token)}/accept`, { password: form.password, ...(invite && form.name ? { name: form.name } : {}) });
      if (me) await signOut();
      setState({ busy: false, error: null, done: true });
    } catch (err) { setState({ busy: false, error: err, done: false }); }
  }

  const heading = invite ? t('accept.inviteHeading') : t('accept.resetHeading');
  return (
    <AuthShell heading={heading} subheading={invite ? t('accept.inviteSubheading') : t('accept.resetSubheading')}>
      {loading ? <Spinner /> : error ? (
        <div className="stack">
          <div className="alert alert-error" role="alert"><LinkIcon size={16} aria-hidden />{errorMessage(t, error)}</div>
          <p className="muted">{t('accept.askNewLink')}</p>
          <Link to="/login">{t('recovery.backToSignIn')}</Link>
        </div>
      ) : state.done ? (
        <div className="stack">
          <div className="alert alert-success"><CheckCircle2 size={16} aria-hidden />{invite ? t('accept.inviteDone') : t('accept.resetDone')}</div>
          <Link className="btn btn-primary btn-block" to="/login">{t('auth.signIn')}</Link>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          <h2>{invite ? t('accept.inviteTitle', { company: data.companyName || '' }) : t('accept.resetTitle')}</h2>
          <p className="muted form-intro" dir="ltr">{data.email}</p>
          {state.error && !state.error.details && <div className="alert alert-error" role="alert">{errorMessage(t, state.error)}</div>}
          {invite && (
            <Field label={t('team.name')}>{id => <input id={id} autoComplete="name" maxLength={120} placeholder={data.name} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />}</Field>
          )}
          <Field label={t('account.newPassword')} hint={t('errors.validation.password')} error={fieldError(t, state.error, 'password')}>
            {id => <input id={id} type="password" dir="ltr" autoComplete="new-password" minLength={8} required value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />}
          </Field>
          <Field label={t('accept.confirmPassword')} error={fieldError(t, state.error, 'confirm')}>
            {id => <input id={id} type="password" dir="ltr" autoComplete="new-password" required value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} />}
          </Field>
          <Button variant="primary" type="submit" loading={state.busy} disabled={form.password.length < 8} className="btn-block">
            {invite ? t('accept.activate') : t('accept.savePassword')}
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
