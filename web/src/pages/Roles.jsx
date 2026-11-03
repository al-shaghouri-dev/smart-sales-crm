import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { roleLabel } from '../components/Layout';
import { Badge, Button, Card, ConfirmDialog, ErrorState, Field, Modal, PageHeader, Spinner, useLoader, useToast } from '../components/ui';

function CreateRoleModal({ onClose, onCreated }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post('/api/roles', { name, description, permissions: [] });
      toast.success(t('roles.created'));
      onCreated(res.roles, name);
      onClose();
    } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('roles.createTitle')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="role-form" loading={busy}>{t('common.create')}</Button></>}>
      <form id="role-form" onSubmit={submit}>
        <Field label={t('roles.name')}>{id => <input id={id} required maxLength={60} value={name} onChange={e => setName(e.target.value)} />}</Field>
        <Field label={t('roles.description')}>{id => <textarea id={id} rows={2} maxLength={300} value={description} onChange={e => setDescription(e.target.value)} />}</Field>
      </form>
    </Modal>
  );
}

export default function Roles() {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useApp();
  const { data, loading, error, reload, setData } = useLoader(async () => {
    const [roles, perms] = await Promise.all([api.get('/api/roles'), api.get('/api/roles/permissions')]);
    return { roles: roles.roles, permissions: perms.permissions };
  }, []);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState(null);

  const selected = data?.roles.find(r => r.id === selectedId) || data?.roles[0];
  useEffect(() => { if (selected) setDraft(new Set(selected.permissions)); }, [selected]);

  const groups = useMemo(() => {
    const out = {};
    for (const p of data?.permissions || []) (out[p.category] ||= []).push(p.key);
    return out;
  }, [data]);

  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const locked = selected.isOwner;
  const ownRole = Boolean(me.membership && !me.membership.isOwner && selected.id === me.membership.roleId);
  const dirty = draft && (draft.size !== selected.permissions.length || selected.permissions.some(p => !draft.has(p)));
  const toggle = key => setDraft(d => { const n = new Set(d); n.has(key) ? n.delete(key) : n.add(key); return n; });

  async function save() {
    setSaving(true);
    try {
      const res = await api.patch(`/api/roles/${selected.id}`, { permissions: [...draft] });
      setData({ ...data, roles: res.roles });
      toast.success(t('roles.saved'));
    } catch (err) { toast.error(errorMessage(t, err)); } finally { setSaving(false); }
  }

  return (
    <>
      <PageHeader title={t('roles.title')} subtitle={t('roles.subtitle')}
        actions={<Button variant="primary" onClick={() => setModal('create')}><Plus size={16} aria-hidden />{t('roles.create')}</Button>} />
      <div className="roles-layout">
        <nav className="card role-list" aria-label={t('roles.title')}>
          {data.roles.map(r => (
            <button key={r.id} type="button" className={`role-item ${r.id === selected.id ? 'active' : ''}`} onClick={() => setSelectedId(r.id)} aria-current={r.id === selected.id}>
              <span>
                <strong>{roleLabel(t, r)}</strong>
                <small className="muted">{t('roles.members', { count: r.memberCount })}</small>
              </span>
              {r.isOwner ? <Lock size={14} aria-hidden /> : <Badge tone={r.isSystem ? 'neutral' : 'primary'}>{r.isSystem ? t('roles.builtIn') : t('roles.custom')}</Badge>}
            </button>
          ))}
        </nav>

        <Card title={roleLabel(t, selected)} actions={
          <div className="row">
            {!selected.isSystem && <Button variant="ghost" onClick={() => setModal('delete')}><Trash2 size={16} aria-hidden />{t('common.delete')}</Button>}
            {!locked && <Button variant="primary" disabled={!dirty || ownRole} loading={saving} onClick={save}>{t('common.save')}</Button>}
          </div>
        }>
          <p className="muted">{selected.description || (selected.isSystem ? t(`roles.systemDescription.${selected.key}`) : '')}</p>
          {locked && <div className="alert alert-info"><Lock size={16} aria-hidden />{t('roles.ownerLocked')}</div>}
          {ownRole && <div className="alert alert-info">{t('errors.roles.own_role')}</div>}
          <div className="perm-groups">
            {Object.entries(groups).map(([category, keys]) => (
              <fieldset key={category} className="perm-group">
                <legend>{t(`permissionCategories.${category}`)}</legend>
                {keys.map(key => (
                  <label key={key} className="check">
                    <input type="checkbox" checked={draft?.has(key) || false} disabled={locked || ownRole} onChange={() => toggle(key)} />
                    <span>{t(`permissions.${key}`)}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
        </Card>
      </div>

      {modal === 'create' && <CreateRoleModal onClose={() => setModal(null)} onCreated={(roles, name) => { setData({ ...data, roles }); setSelectedId(roles.find(r => r.name === name)?.id); }} />}
      {modal === 'delete' && (
        <ConfirmDialog danger title={t('roles.deleteTitle', { name: roleLabel(t, selected) })} body={t('roles.deleteBody')} confirmLabel={t('common.delete')}
          onClose={() => setModal(null)} onConfirm={async () => {
            const res = await api.del(`/api/roles/${selected.id}`);
            setData({ ...data, roles: res.roles });
            setSelectedId(null);
            toast.success(t('roles.deleted'));
          }} />
      )}
    </>
  );
}
