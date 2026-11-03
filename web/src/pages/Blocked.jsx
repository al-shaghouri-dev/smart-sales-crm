import { useTranslation } from 'react-i18next';
import { Ban, Clock, UserX, Building2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { Button } from '../components/ui';

const VARIANTS = {
  pending: { icon: Clock, title: 'blocked.pendingTitle', body: 'blocked.pendingBody' },
  suspended: { icon: Ban, title: 'blocked.suspendedTitle', body: 'blocked.suspendedBody' },
  membership_inactive: { icon: UserX, title: 'blocked.membershipInactiveTitle', body: 'blocked.membershipInactiveBody' },
  none: { icon: Building2, title: 'blocked.noWorkspaceTitle', body: 'blocked.noWorkspaceBody' }
};

/** Shown when the signed-in user has no usable workspace (pending, suspended, deactivated or none). */
export default function Blocked() {
  const { t } = useTranslation();
  const { me, signOut } = useApp();
  const v = VARIANTS[me.companyAccess] || VARIANTS.none;
  return (
    <div className="blocked">
      <v.icon size={36} aria-hidden />
      <h1>{t(v.title)}</h1>
      <p>{t(v.body, { company: me.company?.name || '' })}</p>
      {me.user.isPlatformAdmin && <p className="muted">{t('blocked.platformHint')}</p>}
      <Button onClick={signOut}>{t('auth.signOut')}</Button>
    </div>
  );
}
