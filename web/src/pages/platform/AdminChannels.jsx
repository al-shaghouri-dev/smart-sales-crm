import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity, AlertTriangle, Plug, Send } from 'lucide-react';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/i18n';
import { Badge, Button, Card, EmptyState, ErrorState, Field, PageHeader, Spinner, fmtDate, useLoader, useToast } from '../../components/ui';
import { ProviderBadge } from '../Inbox';

export const CHANNEL_TONES = { active: 'success', connecting: 'neutral', needs_reconnect: 'warning', error: 'danger', disconnected: 'neutral' };

/** Per-company outbound kill switch and daily cap (used in the company detail page). */
export function OutboundControls({ companyId }) {
  const { t } = useTranslation();
  const toast = useToast();
  const data = useLoader(() => api.get(`/api/platform/channels/outbound/${companyId}`), [companyId]);
  const [limit, setLimit] = useState(null);
  const [busy, setBusy] = useState(false);
  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const s = data.data;
  const save = async body => {
    setBusy(true);
    try { data.setData(await api.patch(`/api/platform/channels/outbound/${companyId}`, body)); toast.success(t('common.saved')); setLimit(null); }
    catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  };
  return (
    <Card title={t('adminChannels.outbound')}>
      <div className="stats">
        <div className="stat"><span className="stat-icon"><Send size={18} aria-hidden /></span><span className="stat-label">{t('adminChannels.sentToday')}</span><span className="stat-value">{s.sentToday}{s.dailyLimit ? ` / ${s.dailyLimit}` : ''}</span></div>
        <div className="stat"><span className="stat-icon"><AlertTriangle size={18} aria-hidden /></span><span className="stat-label">{t('adminChannels.failedToday')}</span><span className="stat-value">{s.failedToday}</span></div>
      </div>
      {s.paused && <div className="alert alert-error"><AlertTriangle size={16} aria-hidden />{t('adminChannels.pausedNotice')}</div>}
      <div className="row wrap">
        <Button variant={s.paused ? 'primary' : 'danger'} loading={busy} onClick={() => save({ paused: !s.paused })}>{s.paused ? t('adminChannels.resume') : t('adminChannels.pause')}</Button>
      </div>
      <div className="form-grid mt">
        <Field label={t('adminChannels.dailyLimit')} hint={t('plans.emptyUnlimited')}>
          {id => <input id={id} type="number" min="1" value={limit ?? (s.dailyLimit || '')} onChange={e => setLimit(e.target.value)} />}
        </Field>
        <div className="field"><span className="label">&nbsp;</span><Button loading={busy} disabled={limit === null} onClick={() => save({ dailyLimit: limit === '' ? null : Number(limit) })}>{t('common.save')}</Button></div>
      </div>
    </Card>
  );
}

export function ChannelTable({ channels, showCompany = true }) {
  const { t, i18n } = useTranslation();
  const when = v => (v ? fmtDate(v, i18n.language, { dateStyle: 'short', timeStyle: 'short' }) : '—');
  if (!channels.length) return <EmptyState icon={Plug}>{t('adminChannels.none')}</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th>{t('adminChannels.channel')}</th>{showCompany && <th>{t('adminChannels.company')}</th>}<th>{t('common.status')}</th>
          <th>{t('adminChannels.traffic')}</th><th>{t('adminChannels.lastActivity')}</th><th>{t('adminChannels.token')}</th>
        </tr></thead>
        <tbody>{channels.map(c => (
          <tr key={c.id}>
            <td><ProviderBadge provider={c.provider} /> <strong dir="auto">{c.displayName}</strong><div className="muted small" dir="ltr">{c.externalAccountId}</div></td>
            {showCompany && <td><Link to={`/admin/companies/${c.company.id}?tab=channels`}>{c.company.name}</Link>{c.company.outboundPaused && <Badge tone="danger">{t('adminChannels.paused')}</Badge>}</td>}
            <td><Badge tone={CHANNEL_TONES[c.status]}>{t(`channels.status.${c.status}`)}</Badge>
              {c.lastError && c.status !== 'active' && <div className="small field-error">{t(`errors.${c.lastError}`, { defaultValue: c.lastError })}</div>}</td>
            <td className="small nowrap">↓ {c.last24h.inbound} · ↑ {c.last24h.outbound}{c.last24h.failed > 0 && <span className="field-error"> · ✕ {c.last24h.failed}</span>}</td>
            <td className="small">{when(c.lastInboundAt)}<div className="muted">{when(c.lastOutboundAt)}</div></td>
            <td className="small">{c.tokenExpiresAt ? when(c.tokenExpiresAt) : t('adminChannels.noExpiry')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function AdminChannels() {
  const { t } = useTranslation();
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const data = useLoader(() => api.get(`/api/platform/channels?${new URLSearchParams({ ...(status && { status }), ...(provider && { provider }) })}`), [status, provider]);
  return (
    <>
      <PageHeader title={t('adminChannels.title')} subtitle={t('adminChannels.subtitle')} />
      {data.data && (
        <div className="stats">
          <div className="stat"><span className="stat-icon"><Plug size={18} aria-hidden /></span><span className="stat-label">{t('channels.status.active')}</span><span className="stat-value">{data.data.summary.active || 0}</span></div>
          <div className="stat"><span className="stat-icon"><AlertTriangle size={18} aria-hidden /></span><span className="stat-label">{t('adminChannels.attention')}</span><span className="stat-value">{(data.data.summary.needs_reconnect || 0) + (data.data.summary.error || 0)}</span></div>
          <div className="stat"><span className="stat-icon"><Activity size={18} aria-hidden /></span><span className="stat-label">{t('adminChannels.queued')}</span><span className="stat-value">{data.data.queued}</span></div>
          <div className="stat"><span className="stat-icon"><Send size={18} aria-hidden /></span><span className="stat-label">{t('adminChannels.enabledProviders')}</span><span className="stat-value small">{data.data.providers.map(p => t(`channels.providers.${p}`)).join('، ') || '—'}</span></div>
        </div>
      )}
      <Card>
        <div className="toolbar">
          <select value={status} onChange={e => setStatus(e.target.value)} aria-label={t('common.status')}>
            <option value="">{t('adminChannels.allLive')}</option>
            <option value="attention">{t('adminChannels.attention')}</option>
            {['active', 'needs_reconnect', 'error', 'disconnected'].map(s => <option key={s} value={s}>{t(`channels.status.${s}`)}</option>)}
          </select>
          <select value={provider} onChange={e => setProvider(e.target.value)} aria-label={t('adminChannels.provider')}>
            <option value="">{t('adminChannels.allProviders')}</option>
            {['telegram', 'messenger', 'instagram', 'whatsapp'].map(p => <option key={p} value={p}>{t(`channels.providers.${p}`)}</option>)}
          </select>
        </div>
        {data.loading && !data.data ? <Spinner /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : <ChannelTable channels={data.data.channels} />}
      </Card>
    </>
  );
}
