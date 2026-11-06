import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, CheckCircle2, Link2, Plug, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Modal, PageHeader, Spinner, fmtDate, useLoader, useToast } from '../components/ui';
import { ProviderBadge } from './Inbox';

const STATUS_TONE = { active: 'success', connecting: 'neutral', needs_reconnect: 'warning', error: 'danger', disconnected: 'neutral' };

function ConnectModal({ provider, onClose, onDone }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api.post(`/api/channels/${provider.id}/connect`, form);
      toast.success(r.reconnected ? t('channels.reconnected') : t('channels.connectSuccess'));
      onDone(); onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('channels.connectTitle', { provider: t(`channels.providers.${provider.id}`, { defaultValue: provider.id }) })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="connect-form" loading={busy}>{t('channels.connect')}</Button></>}>
      <form id="connect-form" onSubmit={submit} noValidate autoComplete="off">
        <p className="muted connect-help">{t(`channels.help.${provider.id}`, { defaultValue: '' })}</p>
        {error && <div className="alert alert-error" role="alert">{errorMessage(t, error)}</div>}
        {provider.connectFields.map(f => (
          <Field key={f.name} label={t(`channels.fields.${f.name}`, { defaultValue: f.name })} hint={t(`channels.fieldHints.${f.name}`, { defaultValue: '' }) || undefined}>
            {id => <input id={id} dir="ltr" type={f.type === 'secret' ? 'password' : 'text'} autoComplete="off" spellCheck={false} required={f.required}
              value={form[f.name] || ''} onChange={e => setForm(x => ({ ...x, [f.name]: e.target.value }))} />}
          </Field>
        ))}
        {provider.connectFields.some(f => f.type === 'secret') && <small className="hint">{t('channels.secretNote')}</small>}
      </form>
    </Modal>
  );
}

export default function Channels() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const data = useLoader(async () => {
    const [ch, pr] = await Promise.all([api.get('/api/channels'), api.get('/api/channels/providers')]);
    return { channels: ch.channels, providers: pr.providers, usage: pr.usage };
  });
  const [connecting, setConnecting] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [testing, setTesting] = useState(null);

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const { channels, providers, usage } = data.data;
  const atLimit = usage.max !== null && usage.used >= usage.max;
  const when = v => (v ? fmtDate(v, i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  async function test(c) {
    setTesting(c.id);
    try {
      const r = await api.post(`/api/channels/${c.id}/test`);
      if (r.ok) toast.success(t('channels.testOk')); else toast.error(t(`errors.${r.code}`, { defaultValue: t('channels.testFailed') }));
      data.reload();
    } catch (err) { toast.error(errorMessage(t, err)); } finally { setTesting(null); }
  }

  return (
    <>
      <PageHeader title={t('channels.title')} subtitle={t('channels.subtitle')} />
      <div className="stats">
        <div className="stat"><span className="stat-icon"><Plug size={18} aria-hidden /></span><span className="stat-label">{t('channels.usage')}</span>
          <span className="stat-value">{usage.max === null ? t('channels.usageUnlimited', { used: usage.used }) : t('channels.usageOf', { used: usage.used, max: usage.max })}</span></div>
      </div>

      <Card title={t('channels.connected')}>
        {!channels.length ? <EmptyState icon={Link2} title={t('channels.noneTitle')}>{t('channels.noneBody')}</EmptyState> : (
          <ul className="channel-list">
            {channels.map(c => (
              <li key={c.id} className="channel-row">
                <div className="channel-main">
                  <div className="row"><ProviderBadge provider={c.provider} /><strong dir="auto">{c.displayName}</strong>
                    <Badge tone={STATUS_TONE[c.status]}>{t(`channels.status.${c.status}`)}</Badge>
                    {c.tokenExpiringSoon && <Badge tone="warning">{t('channels.tokenExpiring')}</Badge>}
                    {!c.providerEnabled && <Badge tone="danger">{t('channels.providerDisabled')}</Badge>}
                  </div>
                  <div className="channel-meta muted small">
                    <span>{t('channels.lastInbound')}: {when(c.lastInboundAt)}</span>
                    <span>{t('channels.lastOutbound')}: {when(c.lastOutboundAt)}</span>
                    <span>{t('channels.lastCheck')}: {when(c.lastHealthCheckAt)}</span>
                  </div>
                  {c.lastError && c.status !== 'active' && <div className="channel-error"><AlertTriangle size={14} aria-hidden />{t(`errors.${c.lastError}`, { defaultValue: c.lastError })} · {when(c.lastErrorAt)}</div>}
                </div>
                <div className="row-actions">
                  <Button size="sm" onClick={() => test(c)} loading={testing === c.id}><Activity size={14} aria-hidden />{t('channels.test')}</Button>
                  {c.status !== 'active' && providers.find(p => p.id === c.provider)?.enabled && (
                    <Button size="sm" onClick={() => setConnecting(providers.find(p => p.id === c.provider))}><RefreshCw size={14} aria-hidden />{t('channels.reconnect')}</Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}><Trash2 size={14} aria-hidden />{t('channels.disconnect')}</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('channels.addTitle')} className="mt">
        {atLimit && <div className="alert alert-info"><AlertTriangle size={16} aria-hidden />{t('channels.limitReached')}</div>}
        <div className="provider-grid">
          {providers.map(p => (
            <div key={p.id} className={`provider-card ${!p.enabled || !p.allowedByPlan ? 'disabled' : ''}`}>
              <ProviderBadge provider={p.id} />
              <p className="muted small">{t(`channels.descriptions.${p.id}`, { defaultValue: '' })}</p>
              {!p.enabled ? <span className="muted small">{t('channels.notAvailable')}</span>
                : !p.allowedByPlan ? <span className="muted small">{t('channels.notInPlan')}</span>
                  : p.connectMode === 'oauth' ? <a className="btn btn-primary btn-sm" href={`/api/channels/${p.id}/oauth/start`}>{t('channels.connect')}</a>
                    : <Button size="sm" variant="primary" disabled={atLimit} onClick={() => setConnecting(p)}><CheckCircle2 size={14} aria-hidden />{t('channels.connect')}</Button>}
            </div>
          ))}
        </div>
      </Card>

      {connecting && <ConnectModal provider={connecting} onClose={() => setConnecting(null)} onDone={data.reload} />}
      {removing && (
        <ConfirmDialog title={t('channels.disconnectTitle')} body={t('channels.disconnectBody', { name: removing.displayName })} danger confirmLabel={t('channels.disconnect')}
          onClose={() => setRemoving(null)} onConfirm={async () => { await api.del(`/api/channels/${removing.id}`); toast.success(t('channels.disconnected')); data.reload(); }} />
      )}
    </>
  );
}
