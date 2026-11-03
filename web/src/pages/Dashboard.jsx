import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, Clock3, ShieldCheck, Users, UserCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { Card, PageHeader, useLoader } from '../components/ui';

/** All figures come from the database; nothing on this page is placeholder data. */
export default function Dashboard() {
  const { t } = useTranslation();
  const { me, can } = useApp();
  const canTeam = can('users.view') || can('users.manage');
  const canSettings = can('company.settings.view') || can('company.settings.manage');
  const { data } = useLoader(async () => {
    const [team, roles, company] = await Promise.all([
      canTeam ? api.get('/api/team') : null,
      canTeam || can('roles.manage') ? api.get('/api/roles') : null,
      canSettings ? api.get('/api/company') : null
    ]);
    return { team: team?.members, roles: roles?.roles, company };
  }, [canTeam, canSettings]);

  const members = data?.team;
  const stats = [
    members && { icon: Users, label: t('dashboard.teamMembers'), value: members.length },
    members && { icon: UserCheck, label: t('dashboard.activeMembers'), value: members.filter(m => m.status === 'active').length },
    data?.roles && { icon: ShieldCheck, label: t('dashboard.roles'), value: data.roles.length },
    { icon: Clock3, label: t('dashboard.timezone'), value: me.company.timezone, small: true }
  ].filter(Boolean);

  const c = data?.company;
  const checklist = c ? [
    { done: Boolean(c.branding.logoUrl || c.branding.primaryColor), label: t('dashboard.setupBranding'), to: '/settings?tab=branding' },
    { done: c.profile.timezone !== 'UTC', label: t('dashboard.setupRegion'), to: '/settings?tab=regional' },
    { done: (members?.length || 0) > 1, label: t('dashboard.setupTeam'), to: '/team' },
    can('roles.manage') && { done: Boolean(data.roles?.some(r => !r.isSystem)), label: t('dashboard.setupRoles'), to: '/roles' }
  ].filter(Boolean) : [];

  return (
    <>
      <PageHeader title={t('dashboard.greeting', { name: me.user.name.split(' ')[0] })} subtitle={t('dashboard.subtitle', { company: me.company.branding?.displayName || me.company.name })} />
      <div className="stats">
        {stats.map(s => (
          <div key={s.label} className="stat">
            <span className="stat-icon"><s.icon size={18} aria-hidden /></span>
            <span className="stat-label">{s.label}</span>
            <span className={`stat-value ${s.small ? 'small' : ''}`} dir={s.small ? 'ltr' : undefined}>{s.value}</span>
          </div>
        ))}
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
        <Card title={t('dashboard.roadmapTitle')}>
          <p className="muted">{t('dashboard.roadmapBody')}</p>
        </Card>
      </div>
    </>
  );
}
