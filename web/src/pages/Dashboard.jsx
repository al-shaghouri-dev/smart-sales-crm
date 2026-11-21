import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Activity, ArrowLeft, ArrowRight, BarChart3, CalendarClock, CheckCircle2, Circle, Contact, Inbox, ListTodo, MessageSquare, MessagesSquare,
  PieChart, Plug, ShoppingBag, ShoppingCart, Target, Trophy, UserPlus, Users, XCircle
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { Badge, Card, ErrorState, useLoader } from '../components/ui';
import { AreaChart, Donut, Sparkline, Trend, fmtDateTime, money, timeAgo } from '../components/crm';

const RANGES = [30, 90, 365];
const SOURCE_COLORS = { whatsapp: 'var(--c-green)', instagram: 'var(--c-purple)', messenger: 'var(--c-blue)', telegram: 'var(--c-cyan)', manual: 'var(--c-orange)' };
const ACTIVITY = {
  customer: { icon: UserPlus, tone: 'var(--c-purple)' },
  deal_won: { icon: Trophy, tone: 'var(--c-green)' },
  deal_lost: { icon: XCircle, tone: 'var(--muted)' },
  order: { icon: ShoppingCart, tone: 'var(--c-orange)' },
  conversation: { icon: MessageSquare, tone: 'var(--c-blue)' }
};

function activityLink(e) {
  if (e.type === 'customer') return `/customers/${e.id}`;
  if (e.type === 'order') return `/orders?open=${e.id}`;
  if (e.type === 'conversation') return `/inbox?c=${e.id}`;
  return '/pipeline';
}

function KpiCard({ tone, icon: Icon, label, value, to, series, trend }) {
  const body = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" dir="ltr">{value}</span>
      <span className="kpi-icon"><Icon size={24} aria-hidden /></span>
      <span className="kpi-foot">
        <span className="kpi-spark">{series && <Sparkline values={series} color={`var(--c-${tone})`} />}</span>
        {trend}
      </span>
    </>
  );
  return to ? <Link to={to} className={`kpi tone-${tone} fade-in`}>{body}</Link> : <div className={`kpi tone-${tone} fade-in`}>{body}</div>;
}

function Skeleton() {
  return (
    <>
      <div className="kpis">{[0, 1, 2, 3].map(i => <div key={i} className="skeleton" style={{ height: 136 }} />)}</div>
      <div className="dash-grid"><div className="skeleton" style={{ height: 330 }} /><div className="skeleton" style={{ height: 330 }} /></div>
    </>
  );
}

/** Workspace dashboard. Every figure comes from /api/dashboard (real data, permission-scoped). */
export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const { me, can } = useApp();
  const [days, setDays] = useState(30);
  const locale = i18n.language;
  const Arrow = i18n.dir() === 'rtl' ? ArrowLeft : ArrowRight;
  const canTeam = can('users.view') || can('users.manage');
  const canSettings = can('company.settings.view') || can('company.settings.manage');
  const canInbox = can('conversations.view_all') || can('conversations.view_assigned');
  const canChannels = can('channels.manage');
  const canCustomers = can('customers.view') || can('customers.manage');

  const dash = useLoader(() => api.get(`/api/dashboard?days=${days}`), [days]);
  const extra = useLoader(async () => {
    const [team, roles, company, inbox, channels] = await Promise.all([
      canTeam ? api.get('/api/team').catch(() => null) : null,
      can('roles.manage') ? api.get('/api/roles').catch(() => null) : null,
      canSettings ? api.get('/api/company').catch(() => null) : null,
      canInbox ? api.get('/api/conversations?status=open&limit=1').catch(() => null) : null,
      canInbox || canChannels ? api.get('/api/channels').catch(() => null) : null
    ]);
    return { team: team?.members, roles: roles?.roles, company, inbox: inbox?.counts, channels: channels?.channels };
  }, [canTeam, canSettings, canInbox, canChannels]);

  const d = dash.data;
  const x = extra.data;
  const num = n => (n ?? 0).toLocaleString('en');
  const dayFmt = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { month: 'short', day: 'numeric' });
  const monthFmt = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { month: 'short', year: '2-digit' });
  const formatLabel = l => (l.length === 7 ? monthFmt.format(new Date(`${l}-01T12:00:00`)) : dayFmt.format(new Date(`${l}T12:00:00`)));

  // Main chart: revenue when allowed, otherwise conversations, otherwise new customers.
  const chart = d && (d.kpis.sales ? { title: t('dashboard.salesChart'), values: d.kpis.sales.series, color: 'var(--c-blue)', format: v => money(v, d.currency, locale) }
    : d.kpis.conversations ? { title: t('dashboard.conversationsChart'), values: d.kpis.conversations.series, color: 'var(--c-cyan)', format: num }
      : d.kpis.customers ? { title: t('dashboard.customersChart'), values: d.kpis.customers.series, color: 'var(--c-purple)', format: num } : null);

  const c = x?.company;
  const checklist = c ? [
    (!me.planFeatures || me.planFeatures.includes('branding.custom')) && { done: Boolean(c.branding.logoUrl || c.branding.primaryColor), label: t('dashboard.setupBranding'), to: '/settings?tab=branding' },
    { done: c.profile.timezone !== 'UTC', label: t('dashboard.setupRegion'), to: '/settings?tab=regional' },
    canChannels && { done: Boolean(x.channels?.some(ch => ch.status === 'active')), label: t('dashboard.setupChannel'), to: '/channels' },
    { done: (x.team?.length || 0) > 1, label: t('dashboard.setupTeam'), to: '/team' },
    can('roles.manage') && { done: Boolean(x.roles?.some(r => !r.isSystem)), label: t('dashboard.setupRoles'), to: '/roles' }
  ].filter(Boolean) : [];
  const setupLeft = checklist.filter(i => !i.done).length;

  const sources = d?.sources?.map(s => ({ label: s.source === 'manual' ? t('customers.manual') : t(`channels.providers.${s.source}`, { defaultValue: s.source }), value: s.count, color: SOURCE_COLORS[s.source] || 'var(--c-pink)' }));

  const activityText = e => {
    const v = e.value !== undefined ? money(e.value, e.currency, locale) : null;
    if (e.type === 'customer') return t('dashboard.activity.customer', { name: e.title });
    if (e.type === 'deal_won') return v ? t('dashboard.activity.dealWonValue', { title: e.title, value: v }) : t('dashboard.activity.dealWon', { title: e.title });
    if (e.type === 'deal_lost') return t('dashboard.activity.dealLost', { title: e.title });
    if (e.type === 'order') return t('dashboard.activity.order', { number: e.number, status: t(`orders.status.${e.status}`) });
    return t('dashboard.activity.conversation', { name: e.title });
  };

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>{t('dashboard.welcome', { name: me.user.name.split(' ')[0] })} <span aria-hidden>👋</span></h1>
          <p>{t('dashboard.subtitle', { company: me.company.branding?.displayName || me.company.name })}</p>
        </div>
        <div className="segmented" role="group" aria-label={t('reports.range')}>
          {RANGES.map(r => <button key={r} type="button" className={days === r ? 'active' : ''} onClick={() => setDays(r)}>{t(`dashboard.range.d${r}`)}</button>)}
        </div>
      </div>

      {dash.error ? <ErrorState error={dash.error} onRetry={dash.reload} /> : !d ? <Skeleton /> : (
        <>
          <div className="kpis">
            {d.kpis.conversations && <KpiCard tone="orange" icon={MessagesSquare} label={t('dashboard.kpiConversations')} value={num(d.kpis.conversations.value)} to={canInbox ? '/inbox' : null}
              series={d.kpis.conversations.series} trend={<Trend current={d.kpis.conversations.value} previous={d.kpis.conversations.previous} />} />}
            {d.kpis.customers && <KpiCard tone="blue" icon={Users} label={t('dashboard.kpiCustomers')} value={num(d.kpis.customers.value)} to="/customers"
              series={d.kpis.customers.series} trend={<Trend current={d.kpis.customers.added} previous={d.kpis.customers.addedPrevious} />} />}
            {d.kpis.sales && <KpiCard tone="purple" icon={ShoppingCart} label={t('dashboard.kpiSales')} value={money(d.kpis.sales.value, d.currency, locale)} to="/orders"
              series={d.kpis.sales.series} trend={<Trend current={d.kpis.sales.value} previous={d.kpis.sales.previous} />} />}
            {d.kpis.conversion && <KpiCard tone="green" icon={Target} label={t('dashboard.kpiConversion')} value={d.kpis.conversion.value === null ? '—' : `${d.kpis.conversion.value}%`} to="/reports"
              trend={<Trend points current={d.kpis.conversion.value} previous={d.kpis.conversion.previous} />} />}
          </div>

          <div className="dash-grid">
            {chart && (
              <Card title={<><BarChart3 size={17} aria-hidden />{chart.title}</>}>
                <AreaChart labels={d.labels} values={chart.values} color={chart.color} format={chart.format} formatLabel={formatLabel} />
              </Card>
            )}
            {sources && (
              <Card title={<><PieChart size={17} aria-hidden />{t('dashboard.sources')}</>}>
                {sources.length ? <Donut rows={sources} centerLabel={t('dashboard.customersUnit')} />
                  : <div className="card-empty"><Contact size={30} aria-hidden />{t('dashboard.noCustomersYet')}</div>}
              </Card>
            )}
          </div>

          <div className="dash-grid-3">
            <Card title={<><CalendarClock size={17} aria-hidden />{t('dashboard.upcomingTasks')}</>}>
              {!d.tasks.length ? <div className="card-empty"><CheckCircle2 size={30} aria-hidden />{t('dashboard.noTasks')}</div> : (
                <ul className="feed">
                  {d.tasks.map(task => (
                    <li key={task.id}>
                      <Circle size={18} aria-hidden className="muted" />
                      <span className="feed-main"><strong dir="auto">{task.title}</strong>{task.contactName && <small dir="auto">{task.contactName}</small>}</span>
                      {task.dueAt ? <span className={`due-chip ${task.overdue ? 'late' : ''}`}>{task.overdue ? t('tasks.overdue') : fmtDateTime(task.dueAt, locale)}</span> : <span />}
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/tasks" className="card-link">{t('dashboard.viewAll')}<Arrow size={14} aria-hidden /></Link>
            </Card>

            {d.topCustomers && (
              <Card title={<><Trophy size={17} aria-hidden />{t('dashboard.topCustomers')}</>}>
                {!d.topCustomers.length ? <div className="card-empty"><ShoppingBag size={30} aria-hidden />{t('dashboard.noSalesYet')}</div> : (
                  <ul className="feed">
                    {d.topCustomers.map((cu, i) => (
                      <li key={cu.id}>
                        <span className={`rank r${i + 1}`}>{i + 1}</span>
                        <Link to={`/customers/${cu.id}`} className="feed-main" style={{ color: 'inherit' }}><strong dir="auto">{cu.name}</strong><small dir="auto">{cu.companyName || t('dashboard.ordersCount', { count: cu.orders })}</small></Link>
                        <span className="amount" dir="ltr">{money(cu.total, d.currency, locale)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to="/customers" className="card-link">{t('dashboard.viewAll')}<Arrow size={14} aria-hidden /></Link>
              </Card>
            )}

            <Card title={<><Activity size={17} aria-hidden />{t('dashboard.recentActivity')}</>}>
              {!d.activity.length ? <div className="card-empty"><Activity size={30} aria-hidden />{t('dashboard.noActivity')}</div> : (
                <ul className="feed">
                  {d.activity.map(e => {
                    const A = ACTIVITY[e.type];
                    return (
                      <li key={`${e.type}-${e.id}`}>
                        <span className="feed-icon" style={{ '--tone': A.tone }}><A.icon size={16} aria-hidden /></span>
                        <Link to={activityLink(e)} className="feed-main" style={{ color: 'inherit' }}><strong dir="auto">{activityText(e)}</strong></Link>
                        <small className="muted nowrap">{timeAgo(e.at, locale)}</small>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}

      <div className="grid-2">
        {checklist.length > 0 && setupLeft > 0 && (
          <Card title={t('dashboard.setupTitle')}>
            <ul className="checklist">
              {checklist.map(item => (
                <li key={item.label} className={item.done ? 'done' : ''}>
                  {item.done ? <CheckCircle2 size={18} aria-hidden /> : <Circle size={18} aria-hidden />}
                  <span>{item.label}</span>
                  {item.done ? <small className="muted">{t('dashboard.done')}</small> : <Link to={item.to}>{t('dashboard.open')}</Link>}
                </li>
              ))}
            </ul>
          </Card>
        )}
        {(canInbox || canChannels || canTeam || canCustomers) && (
          <Card title={t('dashboard.quickTitle')}>
            <div className="quick-links">
              {canInbox && <Link to="/inbox" className="quick-link"><Inbox size={18} aria-hidden /><span className="ql-label">{t('dashboard.goInbox')}</span>{x?.inbox?.unread > 0 && <Badge tone="primary">{x.inbox.unread}</Badge>}<Arrow size={16} aria-hidden /></Link>}
              {canCustomers && <Link to="/customers" className="quick-link"><Contact size={18} aria-hidden /><span className="ql-label">{t('dashboard.goCustomers')}</span><Arrow size={16} aria-hidden /></Link>}
              {can('orders.manage') && <Link to="/orders" className="quick-link"><ShoppingBag size={18} aria-hidden /><span className="ql-label">{t('dashboard.goOrders')}</span><Arrow size={16} aria-hidden /></Link>}
              <Link to="/tasks" className="quick-link"><ListTodo size={18} aria-hidden /><span className="ql-label">{t('dashboard.goTasks')}</span><Arrow size={16} aria-hidden /></Link>
              {canChannels && <Link to="/channels" className="quick-link"><Plug size={18} aria-hidden /><span className="ql-label">{x?.channels?.length ? t('dashboard.manageChannels') : t('dashboard.connectFirstChannel')}</span><Arrow size={16} aria-hidden /></Link>}
              {canTeam && <Link to="/team" className="quick-link"><Users size={18} aria-hidden /><span className="ql-label">{t('dashboard.manageTeam')}</span><Arrow size={16} aria-hidden /></Link>}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
