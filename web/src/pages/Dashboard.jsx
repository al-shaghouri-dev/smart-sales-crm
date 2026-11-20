import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Clock3, Inbox, MailWarning, MessageSquare, Plug, ShieldCheck, Users, UserCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { Badge, Card, PageHeader, useLoader } from '../components/ui';

/** All figures come from the database; nothing on this page is placeholder data. */
export default function Dashboard() {
  const { t } = useTranslation();
  const { me, can } = useApp();
  const canTeam = can('users.view') || can('users.manage');
  const canSettings = can('company.settings.view') || can('company.settings.manage');
  const canInbox = can('conversations.view_all') || can('conversations.view_assigned');
  const canChannels = can('channels.manage');
  const { i18n } = useTranslation();
  const Arrow = i18n.dir() === 'rtl' ? ChevronLeft : ChevronRight;
  const { data } = useLoader(async () => {
    const [team, roles, company, inbox, channels] = await Promise.all([
      canTeam ? api.get('/api/team') : null,
      canTeam || can('roles.manage') ? api.get('/api/roles') : null,
      canSettings ? api.get('/api/company') : null,
      canInbox ? api.get('/api/conversations?status=open&limit=1').catch(() => null) : null,
      canInbox || canChannels ? api.get('/api/channels').catch(() => null) : null
    ]);
    return { team: team?.members, roles: roles?.roles, company, inbox: inbox?.counts, channels: channels?.channels };
  }, [canTeam, canSettings, canInbox, canChannels]);

  const members = data?.team;
  const stats = [
    data?.inbox && { icon: MessageSquare, label: t('dashboard.openConversations'), value: data.inbox.open, to: '/inbox' },
    data?.inbox && { icon: MailWarning, label: t('dashboard.unread'), value: data.inbox.unread, to: '/inbox' },
    data?.channels && { icon: Plug, label: t('dashboard.channelsConnected'), value: data.channels.filter(ch => ch.status === 'active').length, to: canChannels ? '/channels' : null },
    members && { icon: Users, label: t('dashboard.teamMembers'), value: members.length },
    members && { icon: UserCheck, label: t('dashboard.activeMembers'), value: members.filter(m => m.status === 'active').length },
    data?.roles && { icon: ShieldCheck, label: t('dashboard.roles'), value: data.roles.length },
    { icon: Clock3, label: t('dashboard.timezone'), value: me.company.timezone, small: true }
  ].filter(Boolean);

  const c = data?.company;
  const checklist = c ? [
    (!me.planFeatures || me.planFeatures.includes('branding.custom')) && { done: Boolean(c.branding.logoUrl || c.branding.primaryColor), label: t('dashboard.setupBranding'), to: '/settings?tab=branding' },
    { done: c.profile.timezone !== 'UTC', label: t('dashboard.setupRegion'), to: '/settings?tab=regional' },
    { done: (members?.length || 0) > 1, label: t('dashboard.setupTeam'), to: '/team' },
    can('roles.manage') && { done: Boolean(data.roles?.some(r => !r.isSystem)), label: t('dashboard.setupRoles'), to: '/roles' }
  ].filter(Boolean) : [];

  return (
    <>
      <PageHeader title={t('dashboard.greeting', { name: me.user.name.split(' ')[0] })} subtitle={t('dashboard.subtitle', { company: me.company.branding?.displayName || me.company.name })} />
      <div className="stats">
        {stats.map(s => {
          const box = (
            <div className="stat">
              <span className="stat-icon"><s.icon size={18} aria-hidden /></span>
              <span className="stat-label">{s.label}</span>
              <span className={`stat-value ${s.small ? 'small' : ''}`} dir={s.small ? 'ltr' : undefined}>{s.value}</span>
            </div>
          );
          return s.to ? <Link key={s.label} to={s.to} className="stat-link">{box}</Link> : <div key={s.label}>{box}</div>;
        })}
      </div>
      <div className="grid-2">
        {checklist.length > 0 && (
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
        {(canInbox || canChannels || canTeam) && (
          <Card title={t('dashboard.quickTitle')}>
            <div className="quick-links">
              {canInbox && <Link to="/inbox" className="quick-link"><Inbox size={18} aria-hidden /><span className="ql-label">{t('dashboard.goInbox')}</span>{data?.inbox?.unread > 0 && <Badge tone="primary">{data.inbox.unread}</Badge>}<Arrow size={16} aria-hidden /></Link>}
              {canChannels && <Link to="/channels" className="quick-link"><Plug size={18} aria-hidden /><span className="ql-label">{data?.channels?.length ? t('dashboard.manageChannels') : t('dashboard.connectFirstChannel')}</span><Arrow size={16} aria-hidden /></Link>}
              {canTeam && <Link to="/team" className="quick-link"><Users size={18} aria-hidden /><span className="ql-label">{t('dashboard.manageTeam')}</span><Arrow size={16} aria-hidden /></Link>}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
