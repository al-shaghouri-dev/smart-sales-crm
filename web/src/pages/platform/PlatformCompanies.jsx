import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { Badge, EmptyState, ErrorState, PageHeader, Spinner, useLoader } from '../../components/ui';

const TONES = { active: 'success', pending: 'warning', suspended: 'danger' };

export default function PlatformCompanies() {
  const { t } = useTranslation();
  const { locale } = useApp();
  const { data, loading, error, reload } = useLoader(() => api.get('/api/platform/companies').then(r => r.companies), []);
  const fmt = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' });
  return (
    <>
      <PageHeader title={t('platform.companiesTitle')} subtitle={t('platform.companiesSubtitle')} />
      <div className="card">
        {loading ? <Spinner /> : error ? <ErrorState error={error} onRetry={reload} /> : data.length === 0 ? <EmptyState icon={Building2}>{t('platform.noCompanies')}</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('platform.company')}</th><th>{t('common.status')}</th><th>{t('platform.members')}</th><th>{t('platform.created')}</th></tr></thead>
              <tbody>
                {data.map(c => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong><div className="muted small" dir="ltr">{c.slug}</div></td>
                    <td><Badge tone={TONES[c.status]}>{t(`platform.status.${c.status}`)}</Badge></td>
                    <td>{c.members}</td>
                    <td className="small">{fmt.format(new Date(c.createdAt))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
