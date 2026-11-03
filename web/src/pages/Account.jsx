import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, Card, Field, PageHeader, useToast } from '../components/ui';

export default function Account() {
  const { t } = useTranslation();
  const toast = useToast();
  const { me, reloadMe, locale, setLocale, themePref, setTheme } = useApp();
  const [profile, setProfile] = useState({ name: me.user.name, phone: me.user.phone || '' });
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState(null);

  async function act(key, fn, success) {
    setBusy(key);
    try { await fn(); toast.success(success); } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title={t('account.title')} subtitle={t('account.subtitle')} />
      <div className="grid-2">
        <Card title={t('account.profile')} actions={<Button variant="primary" loading={busy === 'profile'} onClick={() => act('profile', async () => { await api.patch('/api/me', profile); await reloadMe(); }, t('common.saved'))}>{t('common.save')}</Button>}>
          <Field label={t('team.name')}>{id => <input id={id} maxLength={120} value={profile.name} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))} />}</Field>
          <Field label={t('team.email')}>{id => <input id={id} dir="ltr" value={me.user.email} disabled />}</Field>
          <Field label={t('team.phone')}>{id => <input id={id} type="tel" dir="ltr" value={profile.phone} onChange={e => setProfile(p => ({ ...p, phone: e.target.value }))} />}</Field>
        </Card>

        <Card title={t('account.preferences')}>
          <Field label={t('common.language')} hint={t('account.languageHint')}>
            {id => (
              <select id={id} value={locale} onChange={e => setLocale(e.target.value)}>
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </select>
            )}
          </Field>
          <Field label={t('common.theme')} hint={t('account.themeHint')}>
            {id => (
              <select id={id} value={themePref} onChange={e => setTheme(e.target.value)}>
                <option value="light">{t('common.light')}</option>
                <option value="dark">{t('common.dark')}</option>
                <option value="system">{t('common.system')}</option>
              </select>
            )}
          </Field>
        </Card>

        <Card title={t('account.security')}>
          <form onSubmit={e => { e.preventDefault(); act('pw', async () => { await api.post('/api/auth/change-password', pw); setPw({ currentPassword: '', newPassword: '' }); }, t('account.passwordChanged')); }}>
            <Field label={t('account.currentPassword')}>{id => <input id={id} type="password" dir="ltr" autoComplete="current-password" value={pw.currentPassword} onChange={e => setPw(p => ({ ...p, currentPassword: e.target.value }))} />}</Field>
            <Field label={t('account.newPassword')} hint={t('errors.validation.password')}>{id => <input id={id} type="password" dir="ltr" autoComplete="new-password" minLength={8} value={pw.newPassword} onChange={e => setPw(p => ({ ...p, newPassword: e.target.value }))} />}</Field>
            <Button type="submit" variant="primary" loading={busy === 'pw'} disabled={!pw.currentPassword || pw.newPassword.length < 8}>{t('account.changePassword')}</Button>
          </form>
        </Card>
      </div>
    </>
  );
}
