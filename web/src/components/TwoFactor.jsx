import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, KeyRound, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../context/AppContext';
import { errorMessage } from '../lib/i18n';
import { Badge, Button, Card, Field, Modal, Spinner, fieldError, useLoader, useToast } from './ui';

function RecoveryCodes({ codes, onDone }) {
  const { t } = useTranslation();
  const toast = useToast();
  const text = codes.join('\n');
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`${t('twoFactor.recoveryFileTitle')}\n\n${text}\n`], { type: 'text/plain' }));
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <Modal title={t('twoFactor.recoveryTitle')} onClose={onDone}
      footer={<Button variant="primary" onClick={onDone}>{t('twoFactor.savedThem')}</Button>}>
      <div className="alert alert-info"><ShieldAlert size={16} aria-hidden />{t('twoFactor.recoveryHelp')}</div>
      <ul className="recovery-grid" dir="ltr">{codes.map(c => <li key={c}><code>{c}</code></li>)}</ul>
      <div className="row wrap">
        <Button size="sm" onClick={() => navigator.clipboard?.writeText(text).then(() => toast.success(t('twoFactor.copied')))}><Copy size={14} aria-hidden />{t('twoFactor.copy')}</Button>
        <Button size="sm" onClick={download}><Download size={14} aria-hidden />{t('twoFactor.download')}</Button>
      </div>
    </Modal>
  );
}

/** Account → two-factor authentication (authenticator app + recovery codes). */
export default function TwoFactorCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const { reloadMe } = useApp();
  const status = useLoader(() => api.get('/api/auth/mfa'), []);
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState(null); // 'disable' | 'regenerate'
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function run(fn) {
    setBusy(true); setError(null);
    try { await fn(); } catch (err) { setError(err); if (!err.details?.field) toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  const start = () => run(async () => { setSetup(await api.post('/api/auth/mfa/setup')); setCode(''); });
  const confirm = e => { e.preventDefault(); run(async () => { const r = await api.post('/api/auth/mfa/enable', { code }); setSetup(null); setCode(''); setCodes(r.recoveryCodes); status.reload(); reloadMe(); }); };
  const submitMode = e => {
    e.preventDefault();
    run(async () => {
      if (mode === 'disable') { await api.post('/api/auth/mfa/disable', { password, code }); toast.success(t('twoFactor.disabled')); }
      else { const r = await api.post('/api/auth/mfa/recovery-codes', { code }); setCodes(r.recoveryCodes); }
      setMode(null); setCode(''); setPassword(''); status.reload(); reloadMe();
    });
  };

  const s = status.data;
  return (
    <Card title={<><KeyRound size={17} aria-hidden />{t('twoFactor.title')}</>} actions={s && (s.enabled ? <Badge tone="success">{t('twoFactor.on')}</Badge> : <Badge tone="warning">{t('twoFactor.off')}</Badge>)}>
      {!s ? <Spinner /> : s.enabled ? (
        <>
          <p className="muted">{t('twoFactor.enabledBody', { count: s.recoveryCodesLeft })}</p>
          <div className="row wrap mt">
            <Button size="sm" onClick={() => { setMode('regenerate'); setCode(''); setError(null); }}>{t('twoFactor.newRecovery')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setMode('disable'); setCode(''); setError(null); }}>{t('twoFactor.disable')}</Button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">{t('twoFactor.intro')}</p>
          <Button variant="primary" className="mt" loading={busy && !setup} onClick={start}><ShieldCheck size={16} aria-hidden />{t('twoFactor.enable')}</Button>
        </>
      )}

      {setup && (
        <Modal title={t('twoFactor.setupTitle')} onClose={() => setSetup(null)}
          footer={<><Button onClick={() => setSetup(null)}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="mfa-setup" loading={busy} disabled={code.length !== 6}>{t('twoFactor.confirm')}</Button></>}>
          <ol className="steps">
            <li>{t('twoFactor.step1')}</li>
            <li>{t('twoFactor.step2')}
              <div className="qr-box"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`} alt={t('twoFactor.qrAlt')} width="184" height="184" /></div>
              <small className="muted">{t('twoFactor.manual')}</small>
              <code className="secret" dir="ltr">{setup.secret.match(/.{1,4}/g).join(' ')}</code>
            </li>
            <li>{t('twoFactor.step3')}</li>
          </ol>
          <form id="mfa-setup" onSubmit={confirm} noValidate>
            <Field label={t('auth.mfaCode')} error={fieldError(t, error, 'code')}>
              {id => <input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="otp-input" placeholder="000000"
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />}
            </Field>
          </form>
        </Modal>
      )}

      {mode && (
        <Modal title={mode === 'disable' ? t('twoFactor.disable') : t('twoFactor.newRecovery')} onClose={() => setMode(null)}
          footer={<><Button onClick={() => setMode(null)}>{t('common.cancel')}</Button><Button variant={mode === 'disable' ? 'danger' : 'primary'} type="submit" form="mfa-mode" loading={busy}>{t('common.confirm')}</Button></>}>
          <form id="mfa-mode" onSubmit={submitMode} noValidate>
            {mode === 'disable' && <p className="muted form-intro">{t('twoFactor.disableWarning')}</p>}
            {mode === 'disable' && <Field label={t('account.currentPassword')} error={fieldError(t, error, 'password')}>{id => <input id={id} type="password" dir="ltr" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />}</Field>}
            <Field label={t('twoFactor.codeOrRecovery')} error={fieldError(t, error, 'code')}>{id => <input id={id} dir="ltr" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} />}</Field>
          </form>
        </Modal>
      )}
      {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
    </Card>
  );
}
