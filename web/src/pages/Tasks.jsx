import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Circle, ListTodo, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Modal, PageHeader, Spinner, fieldError, useLoader, useToast } from '../components/ui';
import { CustomerPicker, fmtDateTime } from '../components/crm';

const FILTERS = ['open', 'today', 'overdue', 'done', 'all'];

/** datetime-local value from an ISO string (local time). */
const toLocalInput = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function TaskForm({ task, contact, members, onClose, onSaved }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ title: task?.title || '', notes: task?.notes || '', dueAt: toLocalInput(task?.dueAt), assignee: task?.assigneeMembershipId || '' });
  const [customer, setCustomer] = useState(task?.contactId ? { id: task.contactId, displayName: task.contactName } : contact || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = {
      title: f.title, notes: f.notes, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null, contactId: customer?.id || null,
      ...(members && f.assignee ? { assigneeMembershipId: f.assignee } : {})
    };
    try {
      const r = task ? await api.patch(`/api/tasks/${task.id}`, body) : await api.post('/api/tasks', body);
      toast.success(t('common.saved'));
      onSaved(r.task);
    } catch (err) { setError(err); if (!err.details?.field) toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={task ? t('tasks.edit') : t('tasks.new')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="task-form" loading={busy}>{t('common.save')}</Button></>}>
      <form id="task-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label={t('tasks.taskTitle')} error={fieldError(t, error, 'title')} full>{id => <input id={id} dir="auto" required maxLength={200} value={f.title} onChange={set('title')} placeholder={t('tasks.titlePlaceholder')} />}</Field>
        <Field label={t('tasks.due')} error={fieldError(t, error, 'dueAt')}>{id => <input id={id} type="datetime-local" dir="ltr" value={f.dueAt} onChange={set('dueAt')} />}</Field>
        {members && (
          <Field label={t('tasks.assignee')}>{id => (
            <select id={id} value={f.assignee} onChange={set('assignee')}>
              <option value="">{t('tasks.me')}</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}</Field>
        )}
        <Field label={t('tasks.customer')} full>{id => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}</Field>
        <Field label={t('tasks.notes')} full>{id => <textarea id={id} dir="auto" rows={3} value={f.notes} onChange={set('notes')} />}</Field>
      </form>
    </Modal>
  );
}

export function TaskRow({ task, onToggle, onEdit, onDelete, locale }) {
  const { t } = useTranslation();
  return (
    <li className={`${task.doneAt ? 'done' : ''} ${task.overdue ? 'overdue' : ''}`}>
      <button type="button" className="check-btn" onClick={() => onToggle(task)} aria-label={t('tasks.toggle')}>{task.doneAt ? <CheckCircle2 size={20} /> : <Circle size={20} />}</button>
      <div className="task-main">
        <strong dir="auto">{task.title}</strong>
        <div className="task-meta muted small">
          {task.dueAt && <span className={task.overdue ? 'text-danger' : ''}>{fmtDateTime(task.dueAt, locale)}</span>}
          {task.contactName && <Link to={`/customers/${task.contactId}`} dir="auto"><UserRound size={13} aria-hidden />{task.contactName}</Link>}
          {task.assigneeName && <span>{t('tasks.assignedTo', { name: task.assigneeName })}</span>}
          {task.overdue && <Badge tone="danger">{t('tasks.overdue')}</Badge>}
        </div>
        {task.notes && <p className="muted small" dir="auto">{task.notes}</p>}
      </div>
      {onEdit && <IconButton label={t('common.edit')} onClick={() => onEdit(task)}><Pencil size={15} /></IconButton>}
      {onDelete && <IconButton label={t('common.delete')} onClick={() => onDelete(task)}><Trash2 size={15} /></IconButton>}
    </li>
  );
}

export default function Tasks() {
  const { t, i18n } = useTranslation();
  const { can } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('open');
  const [mine, setMine] = useState(true);
  const data = useLoader(() => api.get(`/api/tasks?filter=${filter}${mine ? '&mine=true' : ''}`), [filter, mine]);
  const canTeam = can('users.view') || can('users.manage');
  const team = useLoader(() => (canTeam ? api.get('/api/team') : Promise.resolve(null)), [canTeam]);
  const [modal, setModal] = useState(null);
  const manager = data.data?.canAssignOthers;
  const members = manager && team.data?.members ? team.data.members.filter(m => m.status === 'active') : null;

  async function toggle(task) {
    try { await api.patch(`/api/tasks/${task.id}`, { done: !task.doneAt }); data.reload(); } catch (err) { toast.error(errorMessage(t, err)); }
  }

  return (
    <>
      <PageHeader title={t('tasks.title')} subtitle={t('tasks.subtitle')} actions={<>
        {manager && <label className="check inline"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /><span>{t('tasks.onlyMine')}</span></label>}
        <Button variant="primary" onClick={() => setModal({ type: 'new' })}><Plus size={16} aria-hidden />{t('tasks.new')}</Button>
      </>} />
      <div className="chips">
        {FILTERS.map(x => <button key={x} type="button" className={`chip ${filter === x ? 'active' : ''}`} onClick={() => setFilter(x)}>{t(`tasks.filter.${x}`)}</button>)}
      </div>
      <Card>
        {data.loading && !data.data ? <Spinner /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.data.tasks.length ? (
          <EmptyState icon={ListTodo} title={t('tasks.emptyTitle')}>{t('tasks.emptyBody')}</EmptyState>
        ) : (
          <ul className="task-list">
            {data.data.tasks.map(task => (
              <TaskRow key={task.id} task={task} locale={i18n.language} onToggle={toggle} onEdit={x => setModal({ type: 'edit', task: x })} onDelete={x => setModal({ type: 'delete', task: x })} />
            ))}
          </ul>
        )}
      </Card>
      {modal?.type === 'new' && <TaskForm members={members} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal?.type === 'edit' && <TaskForm task={modal.task} members={members} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal?.type === 'delete' && <ConfirmDialog title={t('tasks.deleteTitle')} body={t('tasks.deleteBody', { title: modal.task.title })} danger confirmLabel={t('common.delete')}
        onClose={() => setModal(null)} onConfirm={async () => { await api.del(`/api/tasks/${modal.task.id}`); data.reload(); }} />}
    </>
  );
}
