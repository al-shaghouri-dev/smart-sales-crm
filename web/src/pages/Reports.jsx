import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Clock3, Contact, MessagesSquare, ShoppingBag, Trophy, Wallet } from 'lucide-react';
import { api } from '../lib/api';
import { Card, ErrorState, PageHeader, Spinner, useLoader } from '../components/ui';
import { BarChart, HBars, money } from '../components/crm';

const RANGES = [7, 30, 90];

export default function Reports() {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState(30);
  const data = useLoader(() => api.get(`/api/reports/summary?days=${days}`), [days]);
  const locale = i18n.language;
  const num = n => new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(n || 0);

  const header = (
    <PageHeader title={t('reports.title')} subtitle={t('reports.subtitle')} actions={
      <div className="segmented" role="group" aria-label={t('reports.range')}>
        {RANGES.map(d => <button key={d} type="button" className={days === d ? 'active' : ''} onClick={() => setDays(d)}>{t('reports.lastDays', { count: d })}</button>)}
      </div>
    } />
  );
  if (data.loading && !data.data) return <>{header}<Spinner /></>;
  if (data.error) return <>{header}<ErrorState error={data.error} onRetry={data.reload} /></>;
  const r = data.data;
  const cur = r.currency;
  const kpis = [
    { icon: ArrowDownLeft, label: t('reports.inbound'), value: num(r.totals.inbound) },
    { icon: ArrowUpRight, label: t('reports.outbound'), value: num(r.totals.outbound) },
    { icon: Contact, label: t('reports.newContacts'), value: num(r.totals.newContacts) },
    { icon: MessagesSquare, label: t('reports.newConversations'), value: num(r.totals.newConversations) },
    { icon: Clock3, label: t('reports.firstResponse'), value: r.totals.medianFirstResponseMinutes === null ? '—' : t('reports.minutes', { count: r.totals.medianFirstResponseMinutes }) },
    { icon: Trophy, label: t('reports.dealsWon'), value: `${num(r.totals.dealsWon)} / ${num(r.totals.dealsWon + r.totals.dealsLost)}` },
    r.financial && { icon: Wallet, label: t('reports.revenue'), value: money(r.totals.revenue, cur, locale) },
    r.financial && { icon: ShoppingBag, label: t('reports.orders'), value: num(r.totals.orders) }
  ].filter(Boolean);

  return (
    <>
      {header}
      <div className="stats">
        {kpis.map(k => (
          <div key={k.label} className="stat">
            <span className="stat-icon"><k.icon size={18} aria-hidden /></span>
            <span className="stat-label">{k.label}</span>
            <span className="stat-value">{k.value}</span>
          </div>
        ))}
      </div>
      <div className="grid-2">
        <Card title={t('reports.messagesChart')}>
          <BarChart labels={r.labels} series={[
            { label: t('reports.inbound'), values: r.series.inbound, color: 'var(--primary)' },
            { label: t('reports.outbound'), values: r.series.outbound, color: 'var(--chart-2)' }
          ]} />
        </Card>
        {r.financial ? (
          <Card title={t('reports.revenueChart')}>
            <BarChart labels={r.labels} series={[{ label: t('reports.revenue'), values: r.series.revenue, color: 'var(--chart-3)' }]} format={v => money(v, cur, locale)} />
          </Card>
        ) : (
          <Card title={t('reports.contactsChart')}>
            <BarChart labels={r.labels} series={[{ label: t('reports.newContacts'), values: r.series.contacts, color: 'var(--chart-3)' }]} />
          </Card>
        )}
        <Card title={t('reports.pipeline')}>
          {!r.pipeline.length ? <p className="muted small">{t('pipeline.noDeals')}</p> : (
            <HBars rows={r.pipeline.map(s => ({ label: s.name, value: r.financial ? s.value : s.count, sub: r.financial ? `${s.count} · ${money(s.value, cur, locale)}` : num(s.count) }))} />
          )}
        </Card>
        <Card title={t('reports.customersByStatus')}>
          <HBars color="var(--chart-2)" rows={['new', 'lead', 'customer', 'inactive'].map(s => ({ label: t(`customers.status.${s}`), value: r.contactsByStatus[s] || 0, sub: num(r.contactsByStatus[s] || 0) }))} />
        </Card>
        {r.financial && r.ordersByStatus && (
          <Card title={t('reports.ordersByStatus')}>
            <HBars color="var(--chart-3)" rows={['new', 'confirmed', 'shipped', 'delivered', 'cancelled'].map(s => ({ label: t(`orders.status.${s}`), value: r.ordersByStatus[s] || 0, sub: num(r.ordersByStatus[s] || 0) }))} />
          </Card>
        )}
        <Card title={t('reports.conversationsByStatus')}>
          <HBars color="var(--chart-4)" rows={['open', 'pending', 'closed'].map(s => ({ label: t(`inbox.status.${s}`), value: r.conversationsByStatus[s] || 0, sub: num(r.conversationsByStatus[s] || 0) }))} />
        </Card>
      </div>
      <Card title={t('reports.team')} className="mt">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>{t('reports.member')}</th><th>{t('reports.replies')}</th><th>{t('reports.openAssigned')}</th><th>{t('reports.dealsWon')}</th><th>{t('reports.tasksDone')}</th></tr></thead>
            <tbody>{r.team.map(m => <tr key={m.membershipId}><td dir="auto"><strong>{m.name}</strong></td><td>{num(m.replies)}</td><td>{num(m.openAssigned)}</td><td>{num(m.dealsWon)}</td><td>{num(m.tasksDone)}</td></tr>)}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
