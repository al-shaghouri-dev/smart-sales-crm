import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlarmClock, Building2, CircleDollarSign, Inbox, MessagesSquare, PauseCircle, UserCheck, Users } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { Badge, Card, ErrorState, PageHeader, Spinner, fmtDate, fmtMoney, useLoader } from '../../components/ui';

const COMPANY_TONES = { active: 'success', pending: 'warning', suspended: 'danger' };

/** Platform-wide statistics, all computed by the server from real records. */
export default function AdminOverview() {
  const { t } = useTranslation();
  const { locale, me } = useApp();
  const { data, loading, error, reload } = useLoader(() => api.get('/api/platform/overview'), []);
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const mrr = Object.entries(data.mrr);
  const stats = [
    { icon: Building2, label: t('admin.stats.companies'), value: data.companies.total, sub: t('admin.stats.companiesBreakdown', data.companies), to: '/admin/companies' },
    { icon: UserCheck, label: t('admin.stats.activeCompanies'), value: data.companies.active, to: '/admin/companies?status=active' },
    { icon: PauseCircle, label: t('admin.stats.suspended'), value: data.companies.suspended, to: '/admin/companies?status=suspended' },
    { icon: Inbox, label: t('admin.stats.pendingRegistrations'), value: data.registrations.pending, to: '/admin/registrations', highlight: data.registrations.pending > 0 },
    { icon: CircleDollarSign, label: t('admin.stats.activeSubscriptions'), value: data.subscriptions.active, sub: t('admin.stats.trials', { count: data.subscriptions.trial }) },
    { icon: AlarmClock, label: t('admin.stats.expiringSoon'), value: data.subscriptions.expiringIn7Days, sub: t('admin.stats.expired', { count: data.subscriptions.expired }), to: '/admin/companies?subscription=expired' },
    { icon: Users, label: t('admin.stats.users'), value: data.users.total, sub: t('admin.stats.employees', { count: data.users.employees }) },
    { icon: MessagesSquare, label: t('admin.stats.channels'), value: data.channels ?? '—', sub: data.channels === null ? t('admin.stats.channelsLater') : null }
  ];

  return (
    <>
      <PageHeader title={t('admin.overviewTitle', { name: me.user.name.split(' ')[0] })} subtitle={t('admin.overviewSubtitle')} />
      <div className="stats">
        {stats.map(s => {
          const body = (
            <>
              <span className="stat-icon"><s.icon size={18} aria-hidden /></span>
              <span className="stat-label">{s.label}</span>
              <span className="stat-value">{s.value}</span>
              {s.sub && <span className="stat-sub">{s.sub}</span>}
            </>
          );
          return s.to
            ? <Link key={s.label} to={s.to} className={`stat stat-link ${s.highlight ? 'stat-highlight' : ''}`}>{body}</Link>
            : <div key={s.label} className="stat">{body}</div>;
        })}
      </div>
      <div className="grid-2">
        <Card title={t('admin.stats.mrr')}>
          {mrr.length === 0 ? <p className="muted">{t('admin.stats.noRevenue')}</p> : (
            <ul className="mrr-list">
              {mrr.map(([cur, value]) => <li key={cur}><span className="mrr-value" dir="ltr">{fmtMoney(value, cur, locale)}</span><small className="muted">{cur}</small></li>)}
            </ul>
          )}
          <p className="hint">{t('admin.stats.mrrHint')}</p>
        </Card>
        <Card title={t('admin.recentCompanies')} actions={<Link to="/admin/companies">{t('admin.viewAll')}</Link>}>
          {data.recentCompanies.length === 0 ? <p className="muted">{t('platform.noCompanies')}</p> : (
            <ul className="simple-list">
              {data.recentCompanies.map(c => (
                <li key={c.id}>
                  <Link to={`/admin/companies/${c.id}`}>{c.name}</Link>
                  <Badge tone={COMPANY_TONES[c.status]}>{t(`platform.status.${c.status}`)}</Badge>
                  <small className="muted">{fmtDate(c.created_at, locale)}</small>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

export { COMPANY_TONES };
