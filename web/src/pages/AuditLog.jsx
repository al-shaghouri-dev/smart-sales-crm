import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardList } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { Button, EmptyState, ErrorState, PageHeader, Spinner, useLoader } from '../components/ui';

function summarize(entry) {
  const after = entry.after || {};
  const keys = Object.keys(after).filter(k => !['id', 'userId', 'roleId', 'createdAt'].includes(k)).slice(0, 4);
  return keys.map(k => `${k}: ${typeof after[k] === 'object' ? JSON.stringify(after[k]) : after[k]}`).join(' · ');
}

export default function AuditLog() {
  const { t } = useTranslation();
  const { locale, me } = useApp();
  const { data, loading, error, reload, setData } = useLoader(() => api.get('/api/audit?limit=50').then(r => r.entries), []);
  const [more, setMore] = useState(true);
  const fmt = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: me.company.timezone });

  async function loadMore() {
    const last = data[data.length - 1];
    const res = await api.get(`/api/audit?limit=50&before=${last.id}`);
    setData([...data, ...res.entries]);
    if (res.entries.length < 50) setMore(false);
  }

  return (
    <>
      <PageHeader title={t('audit.title')} subtitle={t('audit.subtitle')} />
      <div className="card">
        {loading ? <Spinner /> : error ? <ErrorState error={error} onRetry={reload} /> : data.length === 0 ? <EmptyState icon={ClipboardList}>{t('audit.empty')}</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('audit.when')}</th><th>{t('audit.who')}</th><th>{t('audit.action')}</th><th>{t('audit.details')}</th></tr></thead>
              <tbody>
                {data.map(e => (
                  <tr key={e.id}>
                    <td className="nowrap small">{fmt.format(new Date(e.created_at))}</td>
                    <td className="small" dir="ltr">{e.actor_email || t('audit.system')}</td>
                    <td>{t(`audit.actions.${e.action}`, { defaultValue: e.action })}</td>
                    <td className="muted small details-cell" dir="auto">{summarize(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.length >= 50 && more && <div className="toolbar"><Button onClick={loadMore}>{t('audit.loadMore')}</Button></div>}
      </div>
    </>
  );
}
