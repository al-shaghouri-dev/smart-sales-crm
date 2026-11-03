import { useTranslation } from 'react-i18next';
import { Bell, CreditCard, Receipt } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Spinner, fmtDate, fmtMoney, localized, useLoader } from '../components/ui';

export const SUB_TONES = { active: 'success', pending: 'warning', expired: 'danger', suspended: 'danger', cancelled: 'neutral' };

/** Read-only subscription & payment history for owners/admins (billing.view). Changes are made by the platform team. */
export default function Billing() {
  const { t } = useTranslation();
  const { locale, platform, reloadMe } = useApp();
  const billing = useLoader(() => api.get('/api/billing'), []);
  const notes = useLoader(() => api.get('/api/notifications'), []);

  if (billing.loading) return <Spinner />;
  if (billing.error) return <ErrorState error={billing.error} onRetry={billing.reload} />;
  const { subscription: s, usage, payments } = billing.data;
  const contact = platform.supportEmail || platform.supportPhone;

  return (
    <>
      <PageHeader title={t('billing.title')} subtitle={t('billing.subtitle')} />
      <div className="grid-2">
        <Card title={t('billing.plan')}>
          {!s ? <EmptyState icon={CreditCard}>{t('billing.noSubscription')}</EmptyState> : (
            <dl className="facts">
              <div><dt>{t('billing.plan')}</dt><dd><strong>{localized(s.plan?.name, locale)}</strong>{s.isTrial && <Badge tone="primary">{t('billing.trial')}</Badge>}</dd></div>
              <div><dt>{t('common.status')}</dt><dd><Badge tone={SUB_TONES[s.status]}>{t(`subscriptionStatus.${s.status}`)}</Badge></dd></div>
              <div><dt>{t('billing.price')}</dt><dd>{fmtMoney(s.price, s.currency, locale)} / {t(`plans.per.${s.interval}`, { days: '' })}</dd></div>
              <div><dt>{t('billing.period')}</dt><dd>{fmtDate(s.startsAt, locale)} → {fmtDate(s.endsAt, locale)}</dd></div>
              {s.daysLeft !== null && s.status === 'active' && <div><dt>{t('billing.daysLeft')}</dt><dd>{Math.max(s.daysLeft, 0)}</dd></div>}
              <div><dt>{t('billing.seats')}</dt><dd>{s.plan?.maxEmployees ? t('billing.seatsUsed', { used: usage.members, max: s.plan.maxEmployees }) : `${usage.members} · ${t('plans.unlimited')}`}</dd></div>
            </dl>
          )}
          {contact && <p className="hint">{t('billing.renewContact', { contact })}</p>}
        </Card>
        <Card title={t('billing.notifications')} actions={notes.data?.unread > 0 && (
          <Button size="sm" variant="ghost" onClick={async () => { await api.post('/api/notifications/read-all'); notes.reload(); reloadMe(); }}>{t('billing.markRead')}</Button>
        )}>
          {notes.loading ? <Spinner /> : !notes.data?.notifications.length ? <EmptyState icon={Bell}>{t('billing.noNotifications')}</EmptyState> : (
            <ul className="notice-list">
              {notes.data.notifications.map(n => (
                <li key={n.id} className={n.read_at ? '' : 'unread'}>
                  <span>{t(`notifications.${n.type}`, { count: n.data.daysLeft, date: fmtDate(n.data.endsAt, locale) })}</span>
                  <small className="muted">{fmtDate(n.created_at, locale, { dateStyle: 'medium', timeStyle: 'short' })}</small>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title={t('billing.payments')} className="mt">
        {!payments.length ? <EmptyState icon={Receipt}>{t('billing.noPayments')}</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('billing.paidAt')}</th><th>{t('billing.amount')}</th><th>{t('billing.method')}</th><th>{t('billing.reference')}</th><th>{t('billing.coveredPeriod')}</th></tr></thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paidAt, locale)}</td>
                    <td dir="ltr">{fmtMoney(p.amount, p.currency, locale)}</td>
                    <td>{t(`paymentMethods.${p.method}`)}</td>
                    <td className="small" dir="ltr">{p.reference || '—'}</td>
                    <td className="small">{p.periodEnd ? `${fmtDate(p.periodStart, locale)} → ${fmtDate(p.periodEnd, locale)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
