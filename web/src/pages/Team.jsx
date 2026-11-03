import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Link2, Pencil, Trash2, UserPlus, Users } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { roleLabel } from '../components/Layout';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, LinkDialog, Modal, PageHeader, Spinner, fieldError, useLoader, useToast } from '../components/ui';

function formatDate(value, locale) {
  if (!value) return null;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function MemberModal({ member, roles, onClose, onSaved, onInvited }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useApp();
  const isEdit = Boolean(member);
  const isSelf = member?.userId === me.user.id;
  const [form, setForm] = useState({
    name: member?.name || '', email: member?.email || '', phone: member?.phone || '', jobTitle: member?.jobTitle || '',
    roleId: member?.roleId || roles.find(r => r.key === 'employee')?.id || roles[0]?.id, status: member?.status || 'active', password: ''
  });
  const [mode, setMode] = useState('invite');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = key => e => setForm(f => ({ ...f, [key]: e.target.value }));
  const assignable = roles.filter(r => !r.isOwner || me.membership?.isOwner);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isEdit) {
        const body = { jobTitle: form.jobTitle, roleId: form.roleId, status: form.status };
        if (form.name !== member.name) body.name = form.name;
        if (form.phone !== (member.phone || '')) body.phone = form.phone;
        await api.patch(`/api/team/${member.id}`, body);
        toast.success(t('team.updated'));
      } else {
        const body = { ...form };
        if (mode === 'invite') delete body.password;
        const res = await api.post('/api/team', body);
        toast.success(mode === 'invite' ? t('team.invited') : t('team.added'));
        if (mode === 'invite') onInvited(res);
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
      if (!err.details?.field) toast.error(errorMessage(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={isEdit ? t('team.editTitle') : t('team.addTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="member-form" loading={busy}>{isEdit ? t('common.save') : t('team.add')}</Button></>}>
      <form id="member-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label={t('team.name')} error={fieldError(t, error, 'name')} full>
          {id => <input id={id} required maxLength={120} value={form.name} onChange={set('name')} />}
        </Field>
        <Field label={t('team.email')} error={fieldError(t, error, 'email')}>
          {id => <input id={id} type="email" dir="ltr" required disabled={isEdit} value={form.email} onChange={set('email')} />}
        </Field>
        <Field label={t('team.phone')} error={fieldError(t, error, 'phone')}>
          {id => <input id={id} type="tel" dir="ltr" value={form.phone} onChange={set('phone')} />}
        </Field>
        <Field label={t('team.role')} error={fieldError(t, error, 'roleId')}>
          {id => (
            <select id={id} value={form.roleId} onChange={set('roleId')} disabled={isSelf}>
              {assignable.map(r => <option key={r.id} value={r.id}>{roleLabel(t, r)}</option>)}
            </select>
          )}
        </Field>
        <Field label={t('team.jobTitle')}>
          {id => <input id={id} maxLength={120} value={form.jobTitle} onChange={set('jobTitle')} />}
        </Field>
        <Field label={t('common.status')}>
          {id => (
            <select id={id} value={form.status} onChange={set('status')} disabled={isSelf}>
              <option value="active">{t('common.active')}</option>
              <option value="inactive">{t('common.inactive')}</option>
            </select>
          )}
        </Field>
        {!isEdit && (
          <div className="field full">
            <span className="label">{t('team.accessSetup')}</span>
            <div className="segmented" role="radiogroup">
              <label className={mode === 'invite' ? 'active' : ''}><input type="radio" checked={mode === 'invite'} onChange={() => setMode('invite')} />{t('team.sendInvite')}</label>
              <label className={mode === 'password' ? 'active' : ''}><input type="radio" checked={mode === 'password'} onChange={() => setMode('password')} />{t('team.setPassword')}</label>
            </div>
            <small className="hint">{mode === 'invite' ? t('team.inviteHint') : t('team.passwordHint')}</small>
          </div>
        )}
        {!isEdit && mode === 'password' && (
          <Field label={t('team.password')} error={fieldError(t, error, 'password')} full>
            {id => <input id={id} type="password" dir="ltr" autoComplete="new-password" minLength={8} required value={form.password} onChange={set('password')} />}
          </Field>
        )}
      </form>
    </Modal>
  );
}

function PasswordModal({ member, onClose }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/team/${member.id}/password`, { password });
      toast.success(t('team.resetDone'));
      onClose();
    } catch (err) { setError(err); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('team.resetPasswordTitle', { name: member.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="pw-form" loading={busy}>{t('common.save')}</Button></>}>
      <form id="pw-form" onSubmit={submit}>
        {error && !error.details && <div className="alert alert-error">{errorMessage(t, error)}</div>}
        <Field label={t('team.newPassword')} hint={t('team.passwordHint')} error={fieldError(t, error, 'password')}>
          {id => <input id={id} type="password" dir="ltr" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} />}
        </Field>
      </form>
    </Modal>
  );
}

export default function Team() {
  const { t } = useTranslation();
  const { me, can, locale } = useApp();
  const toast = useToast();
  const manage = can('users.manage');
  const { data, loading, error, reload } = useLoader(async () => {
    const [team, roles] = await Promise.all([api.get('/api/team'), api.get('/api/roles')]);
    return { members: team.members, roles: roles.roles };
  }, []);
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.members || []).filter(m => !q || [m.name, m.email, m.jobTitle, roleLabel(t, m)].join(' ').toLowerCase().includes(q));
  }, [data, query, t]);

  return (
    <>
      <PageHeader title={t('team.title')} subtitle={t('team.subtitle')}
        actions={manage && <Button variant="primary" onClick={() => setModal({ type: 'add' })}><UserPlus size={16} aria-hidden />{t('team.add')}</Button>} />
      <div className="card">
        <div className="toolbar">
          <input type="search" className="search" placeholder={t('team.searchPlaceholder')} aria-label={t('common.search')} value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        {loading ? <Spinner /> : error ? <ErrorState error={error} onRetry={reload} /> : rows.length === 0 ? <EmptyState icon={Users}>{t('team.empty')}</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('team.name')}</th><th>{t('team.role')}</th><th>{t('common.status')}</th><th>{t('team.lastLogin')}</th>
                  {manage && <th className="actions-col"><span className="sr-only">{t('common.actions')}</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(m => (
                  <tr key={m.id}>
                    <td>
                      <div className="person">
                        <span className="avatar sm" aria-hidden>{(m.name || '?')[0]}</span>
                        <div>
                          <strong>{m.name}</strong>{m.userId === me.user.id && <Badge>{t('team.you')}</Badge>}{m.invitationPending && <Badge tone="warning">{t('team.invitationPending')}</Badge>}
                          <div className="muted small" dir="ltr">{m.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>{roleLabel(t, m)}{m.jobTitle && <div className="muted small">{m.jobTitle}</div>}</td>
                    <td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{t(`common.${m.status}`)}</Badge></td>
                    <td className="muted small">{formatDate(m.lastLoginAt, locale) || t('common.never')}</td>
                    {manage && (
                      <td className="actions-col">
                        <div className="row-actions">
                          <IconButton label={t('common.edit')} onClick={() => setModal({ type: 'edit', member: m })}><Pencil size={16} /></IconButton>
                          {m.userId !== me.user.id && <IconButton label={m.invitationPending ? t('team.resendInvite') : t('team.sendResetLink')} onClick={async () => {
                            try { const r = await api.post(`/api/team/${m.id}/link`); setModal({ type: 'link', result: r, title: m.invitationPending ? t('team.resendInvite') : t('team.sendResetLink') }); }
                            catch (err) { toast.error(errorMessage(t, err)); }
                          }}><Link2 size={16} /></IconButton>}
                          {m.userId !== me.user.id && !m.invitationPending && <IconButton label={t('team.resetPassword')} onClick={() => setModal({ type: 'password', member: m })}><KeyRound size={16} /></IconButton>}
                          {m.userId !== me.user.id && <IconButton label={t('common.remove')} onClick={() => setModal({ type: 'remove', member: m })}><Trash2 size={16} /></IconButton>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal?.type === 'add' && <MemberModal roles={data.roles} onClose={() => setModal(m => (m?.type === 'add' ? null : m))} onSaved={reload} onInvited={r => setModal({ type: 'link', result: r, title: t('team.invitationLink') })} />}
      {modal?.type === 'link' && <LinkDialog result={modal.result} title={modal.title} onClose={() => setModal(null)} />}
      {modal?.type === 'edit' && <MemberModal member={modal.member} roles={data.roles} onClose={() => setModal(null)} onSaved={reload} />}
      {modal?.type === 'password' && <PasswordModal member={modal.member} onClose={() => setModal(null)} />}
      {modal?.type === 'remove' && (
        <ConfirmDialog danger title={t('team.removeTitle', { name: modal.member.name })} body={t('team.removeBody')} confirmLabel={t('common.remove')}
          onClose={() => setModal(null)} onConfirm={async () => { await api.del(`/api/team/${modal.member.id}`); toast.success(t('team.removed')); reload(); }} />
      )}
    </>
  );
}
