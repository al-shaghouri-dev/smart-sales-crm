import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, LinkIcon } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, Field, Spinner, fieldError, useLoader } from '../components/ui';
import { AuthShell } from './Login';

const STORE_KEY = 'sscrm.pendingToken';
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * Read the one-time token from the URL fragment (#token) — fragments are never sent to servers —
 * then remove it from the address bar and history right away. It is kept only in this tab's
 * sessionStorage so a reload still works, and is cleared after use. Older path-style links
 * (/invite/<token>) are accepted and cleaned the same way.
 */
function takeToken(pathToken, base) {
  const fromHash = window.location.hash.slice(1);
  const candidate = TOKEN_RE.test(fromHash) ? fromHash : TOKEN_RE.test(pathToken || '') ? pathToken : null;
  try {
    if (candidate) sessionStorage.setItem(STORE_KEY, JSON.stringify({ base, token: candidate }));
    if (candidate || window.location.hash) window.history.replaceState(window.history.state, '', base);
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    return saved && saved.base === base ? saved.token : candidate;
  } catch {
    return candidate;
  }
}
const forgetToken = () => { try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ } };

/**
 * Opening another link while this page is already open only changes the #fragment (same-document
 * navigation, no reload). Re-mount the form whenever a new token arrives in the fragment.
 */
export default function AcceptToken() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const onHash = () => { if (TOKEN_RE.test(window.location.hash.slice(1))) setGeneration(g => g + 1); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return <AcceptTokenForm key={generation} />;
}

/** Accept an invitation or complete a password reset from a one-time link. */
function AcceptTokenForm() {
  const { t } = useTranslation();
  const { token: pathToken } = useParams();
  const { pathname } = useLocation();
  const { me, signOut } = useApp();
  const invite = pathname.startsWith('/invite');
  const base = invite ? '/invite' : '/reset-password';
  const [token] = useState(() => takeToken(pathToken, base));
  const { data, loading, error } = useLoader(
    () => (token ? api.post('/api/auth/token/inspect', { token }) : Promise.reject({ code: 'token.invalid' })),
    [token]
  );
  const [form, setForm] = useState({ name: '', password: '', confirm: '' });
  const [state, setState] = useState({ busy: false, error: null, done: false });

  async function submit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) return setState(s => ({ ...s, error: { code: 'validation.password_mismatch', details: { field: 'confirm' } } }));
    setState({ busy: true, error: null, done: false });
    try {
      await api.post('/api/auth/token/accept', { token, password: form.password, ...(invite && form.name ? { name: form.name } : {}) });
      forgetToken();
      if (me) await signOut();
      setState({ busy: false, error: null, done: true });
    } catch (err) {
      if (err.code === 'token.invalid') forgetToken();
      setState({ busy: false, error: err, done: false });
    }
  }

  return (
    <AuthShell heading={invite ? t('accept.inviteHeading') : t('accept.resetHeading')} subheading={invite ? t('accept.inviteSubheading') : t('accept.resetSubheading')}>
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
