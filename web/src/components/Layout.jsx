import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Building2, MessageSquare, Plug, ClipboardList, CreditCard, Inbox, Layers, LayoutDashboard, LogOut, Menu, Palette, Settings, ShieldCheck, UserCircle, Users, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { LanguageSwitcher, ThemeToggle } from './Preferences';
import { IconButton } from './ui';

/**
 * Display name for a role. Accepts a role ({ key, name }) or a member/membership ({ roleKey, roleName }).
 * Member objects also carry `name` (the person's name), so member fields are checked first.
 */
export function roleLabel(t, obj) {
  if (!obj) return '';
  const isMember = 'roleKey' in obj || 'roleName' in obj;
  const name = isMember ? obj.roleName : obj.name;
  const key = isMember ? obj.roleKey : obj.key;
  return name || (key ? t(`roles.system.${key}`, { defaultValue: key }) : '');
}

function initials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '•';
}

export function BrandMark({ logoUrl, name, size = 36 }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }}>
      {logoUrl ? <img src={logoUrl} alt="" /> : initials(name)}
    </span>
  );
}

/** Workspace notice when the subscription is ending, read-only or blocked. */
function SubscriptionBanner() {
  const { t } = useTranslation();
  const { me, can } = useApp();
  const sub = me.subscription;
  if (!sub) return null;
  const billing = can('billing.view');
  let tone = null, text = null;
  if (sub.access === 'blocked') { tone = 'danger'; text = t('subscriptionBanner.blocked'); }
  else if (sub.access === 'read_only') { tone = 'danger'; text = t('subscriptionBanner.readOnly'); }
  else if (billing && sub.status === 'active' && sub.daysLeft !== null && sub.daysLeft <= 7) { tone = 'warning'; text = t('subscriptionBanner.endingSoon', { count: Math.max(sub.daysLeft, 0) }); }
  else if (billing && sub.status === 'pending') { tone = 'warning'; text = t('subscriptionBanner.pending'); }
  if (!tone) return null;
  return (
    <div className={`banner banner-${tone}`} role="status">
      <AlertTriangle size={16} aria-hidden />
      <span>{text}</span>
      {billing && <Link to="/billing">{t('subscriptionBanner.viewBilling')}</Link>}
    </div>
  );
}

export default function Layout() {
  const { t } = useTranslation();
  const { me, platform, can, signOut, switchCompany } = useApp();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  const company = me.company;
  const isPlatform = me.sessionKind === 'platform';
  const hasWorkspace = !isPlatform && me.companyAccess === 'active';
  const brandName = company?.branding?.displayName || company?.name || platform.appName;
  const brandLogo = company?.branding?.logoUrl || platform.logoUrl;

  const workspaceItems = hasWorkspace ? [
    { to: '/', icon: LayoutDashboard, label: t('nav.dashboard'), end: true },
    can('conversations.view_all') || can('conversations.view_assigned') ? { to: '/inbox', icon: MessageSquare, label: t('nav.inbox') } : null,
    can('channels.manage') ? { to: '/channels', icon: Plug, label: t('nav.channels') } : null,
    can('users.view') || can('users.manage') ? { to: '/team', icon: Users, label: t('nav.team') } : null,
    can('roles.manage') ? { to: '/roles', icon: ShieldCheck, label: t('nav.roles') } : null,
    can('company.settings.view') || can('company.settings.manage') || can('company.branding.manage') ? { to: '/settings', icon: Settings, label: t('nav.companySettings') } : null,
    can('audit.view') ? { to: '/audit', icon: ClipboardList, label: t('nav.audit') } : null,
    can('billing.view') ? { to: '/billing', icon: CreditCard, label: t('nav.billing') } : null
  ].filter(Boolean) : [];
  // The Super Admin console is a separate area with its own session; it never mixes with workspace pages.
  const platformItems = isPlatform ? [
    { to: '/admin', icon: LayoutDashboard, label: t('nav.overview'), end: true },
    { to: '/admin/companies', icon: Building2, label: t('nav.platformCompanies') },
    { to: '/admin/registrations', icon: Inbox, label: t('nav.registrations') },
    { to: '/admin/plans', icon: Layers, label: t('nav.plans') },
    { to: '/admin/channels', icon: Plug, label: t('nav.channels') },
    { to: '/admin/settings', icon: Palette, label: t('nav.platformSettings') }
  ] : [];

  const usable = me.companies.filter(c => c.id !== company?.id);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={t('common.menu')}>
        <div className="sidebar-brand">
          <BrandMark logoUrl={brandLogo} name={brandName} />
          <div className="brand-text">
            <strong>{brandName}</strong>
            {company && !isPlatform && <small>{platform.appName}</small>}
            {isPlatform && <small className="console-tag">{t('auth.adminConsole')}</small>}
          </div>
          <IconButton label={t('common.close')} onClick={() => setOpen(false)} className="only-mobile"><X size={18} /></IconButton>
        </div>

        <nav className="nav">
          {workspaceItems.length > 0 && <div className="nav-label">{t('nav.workspace')}</div>}
          {workspaceItems.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-item"><item.icon size={18} aria-hidden />{item.label}</NavLink>
          ))}
          {platformItems.length > 0 && <div className="nav-label">{t('nav.platform')}</div>}
          {platformItems.map(item => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-item"><item.icon size={18} aria-hidden />{item.label}</NavLink>
          ))}
        </nav>

        {usable.length > 0 && (
          <div className="workspace-switch">
            <label htmlFor="ws-switch" className="nav-label">{t('nav.switchWorkspace')}</label>
            <select id="ws-switch" value="" onChange={e => e.target.value && switchCompany(e.target.value)}>
              <option value="">{company?.name || '—'}</option>
              {usable.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        <div className="sidebar-foot">
          <NavLink to={isPlatform ? '/admin/account' : '/account'} className="nav-item"><UserCircle size={18} aria-hidden />{t('nav.account')}</NavLink>
          <button type="button" className="nav-item" onClick={signOut}><LogOut size={18} aria-hidden />{t('auth.signOut')}</button>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <IconButton label={t('common.menu')} onClick={() => setOpen(true)} className="only-mobile"><Menu size={20} /></IconButton>
          <div className="topbar-spacer" />
          <LanguageSwitcher />
          <ThemeToggle />
          <div className="user-chip" title={me.user.email}>
            <span className="avatar" aria-hidden>{initials(me.user.name)}</span>
            <span className="user-meta">
              <strong>{me.user.name}</strong>
              <small>{isPlatform ? t('auth.superAdmin') : me.membership ? roleLabel(t, me.membership) : ''}</small>
            </span>
          </div>
        </header>
        <main className={`content ${location.pathname.startsWith('/inbox') ? 'content-full' : ''}`} id="main">
          {hasWorkspace && <SubscriptionBanner />}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
