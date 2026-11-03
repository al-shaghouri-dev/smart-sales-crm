import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useApp } from './context/AppContext';
import Layout from './components/Layout';
import { ErrorState, Spinner } from './components/ui';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Team from './pages/Team';
import Roles from './pages/Roles';
import CompanySettings from './pages/CompanySettings';
import Account from './pages/Account';
import AuditLog from './pages/AuditLog';
import Blocked from './pages/Blocked';
import PlatformBranding from './pages/platform/PlatformBranding';
import PlatformCompanies from './pages/platform/PlatformCompanies';

function Guard({ when, children }) {
  return when ? children : <Navigate to="/" replace />;
}

export default function App() {
  const { t } = useTranslation();
  const { ready, me, platform, bootError, boot, can } = useApp();

  if (!ready) return <div className="center-page"><Spinner /></div>;
  if (bootError || !platform) return <div className="center-page"><ErrorState error={bootError} onRetry={boot} /></div>;
  if (!me) return <Login />;

  const workspace = me.companyAccess === 'active';
  const admin = me.user.isPlatformAdmin;
  const home = workspace ? <Dashboard /> : admin ? <Navigate to="/platform/companies" replace /> : <Blocked />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={home} />
        <Route path="team" element={<Guard when={workspace && (can('users.view') || can('users.manage'))}><Team /></Guard>} />
        <Route path="roles" element={<Guard when={workspace && can('roles.manage')}><Roles /></Guard>} />
        <Route path="settings" element={<Guard when={workspace && (can('company.settings.view') || can('company.settings.manage') || can('company.branding.manage'))}><CompanySettings /></Guard>} />
        <Route path="audit" element={<Guard when={workspace && can('audit.view')}><AuditLog /></Guard>} />
        <Route path="account" element={<Account />} />
        <Route path="platform/branding" element={<Guard when={admin}><PlatformBranding /></Guard>} />
        <Route path="platform/companies" element={<Guard when={admin}><PlatformCompanies /></Guard>} />
        <Route path="*" element={<div className="empty"><strong>404</strong><p>{t('errors.common.not_found')}</p></div>} />
      </Route>
    </Routes>
  );
}
