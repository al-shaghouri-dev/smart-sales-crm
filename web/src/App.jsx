import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useApp } from './context/AppContext';
import Layout from './components/Layout';
import { ErrorState, Spinner } from './components/ui';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import AcceptToken from './pages/AcceptToken';
import Dashboard from './pages/Dashboard';
import Team from './pages/Team';
import Roles from './pages/Roles';
import CompanySettings from './pages/CompanySettings';
import Account from './pages/Account';
import AuditLog from './pages/AuditLog';
import Billing from './pages/Billing';
import Blocked, { SubscriptionBlocked } from './pages/Blocked';
import PlatformBranding from './pages/platform/PlatformBranding';
import AdminOverview from './pages/platform/AdminOverview';
import AdminCompanies from './pages/platform/AdminCompanies';
import AdminCompanyDetail from './pages/platform/AdminCompanyDetail';
import AdminRegistrations from './pages/platform/AdminRegistrations';
import AdminPlans from './pages/platform/AdminPlans';

function Guard({ when, to = '/', children }) {
  return when ? children : <Navigate to={to} replace />;
}

const NotFound = () => {
  const { t } = useTranslation();
  return <div className="empty"><strong>404</strong><p>{t('errors.common.not_found')}</p></div>;
};

/** Pages reachable without a session (also while signed in, for links opened from email). */
function publicRoutes() {
  return [
    <Route key="inv" path="/invite/:token" element={<AcceptToken />} />,
    <Route key="rst" path="/reset-password/:token" element={<AcceptToken />} />
  ];
}

export default function App() {
  const { ready, me, platform, bootError, boot, can } = useApp();
  const location = useLocation();

  if (!ready) return <div className="center-page"><Spinner /></div>;
  if (bootError || !platform) return <div className="center-page"><ErrorState error={bootError} onRetry={boot} /></div>;

  if (!me) {
    const adminArea = location.pathname.startsWith('/admin');
    return (
      <Routes>
        {publicRoutes()}
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="*" element={<Login kind={adminArea ? 'platform' : 'company'} />} />
      </Routes>
    );
  }

  // ---- Super Admin console: a separate area; never shows workspace pages ----
  if (me.sessionKind === 'platform') {
    return (
      <Routes>
        {publicRoutes()}
        <Route path="/admin" element={<Layout />}>
          <Route index element={<AdminOverview />} />
          <Route path="companies" element={<AdminCompanies />} />
          <Route path="companies/:id" element={<AdminCompanyDetail />} />
          <Route path="registrations" element={<AdminRegistrations />} />
          <Route path="plans" element={<AdminPlans />} />
          <Route path="settings" element={<PlatformBranding />} />
          <Route path="account" element={<Account />} />
          <Route path="login" element={<Navigate to="/admin" replace />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    );
  }

  // ---- Workspace ----
  const workspace = me.companyAccess === 'active';
  const blocked = workspace && me.subscription?.access === 'blocked';
  const page = (allowed, element) => <Guard when={workspace && allowed}>{blocked ? <SubscriptionBlocked /> : element}</Guard>;

  return (
    <Routes>
      {publicRoutes()}
      <Route path="/admin/*" element={<Navigate to="/" replace />} />
      <Route element={<Layout />}>
        <Route index element={workspace ? (blocked ? <SubscriptionBlocked /> : <Dashboard />) : <Blocked />} />
        <Route path="team" element={page(can('users.view') || can('users.manage'), <Team />)} />
        <Route path="roles" element={page(can('roles.manage'), <Roles />)} />
        <Route path="settings" element={page(can('company.settings.view') || can('company.settings.manage') || can('company.branding.manage'), <CompanySettings />)} />
        <Route path="audit" element={page(can('audit.view'), <AuditLog />)} />
        <Route path="billing" element={<Guard when={workspace && can('billing.view')}><Billing /></Guard>} />
        <Route path="account" element={<Account />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
