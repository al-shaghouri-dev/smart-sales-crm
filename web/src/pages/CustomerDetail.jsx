import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Building, CalendarClock, CheckCircle2, Circle, Kanban, Mail, MessageSquare, Pencil, Phone, Plus, ShoppingBag, StickyNote, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Badge, Button, Card, ConfirmDialog, ErrorState, IconButton, Spinner, useLoader, useToast } from '../components/ui';
import { CustomerStatus, ORDER_TONES, fmtDateTime, fmtDay, initials, money } from '../components/crm';
import { CustomerForm } from './Customers';
import { DealForm } from './Pipeline';
import { OrderForm } from './Orders';
import { TaskForm } from './Tasks';
import { ProviderBadge } from './Inbox';

export default function CustomerDetail() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const { can } = useApp();
  const toast = useToast();
  const navigate = useNavigate();
  const data = useLoader(() => api.get(`/api/customers/${id}`), [id]);
  const [modal, setModal] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const Back = i18n.dir() === 'rtl' ? ArrowRight : ArrowLeft;
  const locale = i18n.language;

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const { customer: c, identities, conversations, deals, orders, tasks, notes } = data.data;
  const manage = can('customers.manage');
  const contactRef = { id: c.id, displayName: c.displayName };

  async function addNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setBusy(true);
    try { await api.post(`/api/customers/${c.id}/notes`, { body: note }); setNote(''); data.reload(); } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  async function toggleTask(task) {
    try { await api.patch(`/api/tasks/${task.id}`, { done: !task.doneAt }); data.reload(); } catch (err) { toast.error(errorMessage(t, err)); }
  }

  return (
    <>
      <Link to="/customers" className="back-link"><Back size={16} aria-hidden />{t('customers.title')}</Link>
      <div className="profile-head card">
        <span className="avatar xl" aria-hidden>{initials(c.displayName)}</span>
        <div className="profile-main">
          <h1 dir="auto">{c.displayName}</h1>
          <div className="profile-meta">
            <CustomerStatus status={c.status} />
            {c.companyName && <span className="meta-item"><Building size={14} aria-hidden />{c.companyName}</span>}
            {c.phone && <a className="meta-item" href={`tel:${c.phone}`} dir="ltr"><Phone size={14} aria-hidden />{c.phone}</a>}
            {c.email && <a className="meta-item" href={`mailto:${c.email}`} dir="ltr"><Mail size={14} aria-hidden />{c.email}</a>}
          </div>
          {c.tags.length > 0 && <div className="tag-list">{c.tags.map(x => <span key={x} className="tag">{x}</span>)}</div>}
        </div>
        <div className="profile-actions">
          {manage && <Button onClick={() => setModal('edit')}><Pencil size={15} aria-hidden />{t('common.edit')}</Button>}
          {manage && <Button onClick={() => setModal('deal')}><Kanban size={15} aria-hidden />{t('pipeline.newDeal')}</Button>}
          {can('orders.manage') && <Button onClick={() => setModal('order')}><ShoppingBag size={15} aria-hidden />{t('orders.new')}</Button>}
          <Button onClick={() => setModal('task')}><CalendarClock size={15} aria-hidden />{t('tasks.new')}</Button>
          {manage && !conversations.length && <IconButton label={t('common.delete')} onClick={() => setModal('delete')}><Trash2 size={16} /></IconButton>}
        </div>
      </div>

      <div className="grid-2 wide-first mt">
        <div className="stack">
          <Card title={t('customers.notes')}>
            <form className="note-form" onSubmit={addNote}>
              <textarea dir="auto" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={t('customers.notePlaceholder')} aria-label={t('customers.notes')} />
              <Button variant="primary" type="submit" loading={busy} disabled={!note.trim()}><Plus size={15} aria-hidden />{t('customers.addNote')}</Button>
            </form>
            {c.notes && <p className="about" dir="auto">{c.notes}</p>}
            {!notes.length ? <p className="muted small">{t('customers.noNotes')}</p> : (
              <ul className="timeline">
                {notes.map(n => (
                  <li key={n.id}>
                    <StickyNote size={15} aria-hidden />
                    <div><p dir="auto">{n.body}</p><small className="muted">{n.authorName || '—'} · {fmtDateTime(n.createdAt, locale)}</small></div>
                    {(n.mine || manage) && <IconButton label={t('common.delete')} onClick={async () => { await api.del(`/api/customers/${c.id}/notes/${n.id}`); data.reload(); }}><Trash2 size={14} /></IconButton>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('customers.conversations')}>
            {!conversations.length ? <p className="muted small">{t('customers.noConversations')}</p> : (
              <ul className="link-list">
                {conversations.map(cv => (
                  <li key={cv.id}><Link to={`/inbox?c=${cv.id}`}>
                    <MessageSquare size={16} aria-hidden /><ProviderBadge provider={cv.provider} />
                    <span className="grow ellipsis" dir="auto">{cv.preview || '—'}</span>
                    <small className="muted nowrap">{fmtDay(cv.lastMessageAt, locale)}</small>
                  </Link></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title={t('customers.tasks')}>
            {!tasks.length ? <p className="muted small">{t('tasks.empty')}</p> : (
              <ul className="task-list compact">
                {tasks.map(task => (
                  <li key={task.id} className={task.doneAt ? 'done' : ''}>
                    <button type="button" className="check-btn" onClick={() => toggleTask(task)} aria-label={t('tasks.toggle')}>{task.doneAt ? <CheckCircle2 size={18} /> : <Circle size={18} />}</button>
                    <span className="grow" dir="auto">{task.title}</span>
                    {task.dueAt && <small className="muted nowrap">{fmtDay(task.dueAt, locale)}</small>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title={t('customers.deals')}>
            {!deals.length ? <p className="muted small">{t('pipeline.noDeals')}</p> : (
              <ul className="link-list">
                {deals.map(d => (
                  <li key={d.id}><Link to="/pipeline"><span className="grow" dir="auto">{d.title}</span>
                    <Badge tone={d.status === 'won' ? 'success' : d.status === 'lost' ? 'neutral' : 'primary'}>{d.stageName}</Badge>
                    <strong className="nowrap">{money(d.value, d.currency, locale)}</strong></Link></li>
                ))}
              </ul>
            )}
          </Card>
          {(can('orders.view') || can('orders.manage')) && (
            <Card title={t('customers.orders')}>
              {!orders.length ? <p className="muted small">{t('orders.empty')}</p> : (
                <ul className="link-list">
                  {orders.map(o => (
                    <li key={o.id}><Link to={`/orders?open=${o.id}`}><span className="grow">#{o.number}</span>
                      <Badge tone={ORDER_TONES[o.status]}>{t(`orders.status.${o.status}`)}</Badge>
                      <strong className="nowrap">{money(o.total, o.currency, locale)}</strong></Link></li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          <Card title={t('customers.details')}>
            <dl className="details-list">
              <dt>{t('customers.source')}</dt><dd>{c.source && c.source !== 'manual' ? <ProviderBadge provider={c.source} /> : t('customers.manual')}</dd>
              <dt>{t('customers.owner')}</dt><dd>{c.ownerName || '—'}</dd>
              <dt>{t('customers.firstContact')}</dt><dd>{fmtDay(c.firstContactAt || c.createdAt, locale)}</dd>
              <dt>{t('customers.lastContact')}</dt><dd>{fmtDay(c.lastContactAt, locale)}</dd>
              {identities.map(idn => <Fragment key={idn.id}><dt>{idn.channelName}</dt><dd dir="ltr">{idn.username ? `@${idn.username}` : idn.externalUserId}</dd></Fragment>)}
            </dl>
          </Card>
        </div>
      </div>

      {modal === 'edit' && <CustomerForm customer={c} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal === 'deal' && <DealForm contact={contactRef} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal === 'order' && <OrderForm contact={contactRef} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal === 'task' && <TaskForm contact={contactRef} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal === 'delete' && <ConfirmDialog title={t('customers.deleteTitle')} body={t('customers.deleteBody', { name: c.displayName })} danger confirmLabel={t('common.delete')}
        onClose={() => setModal(null)} onConfirm={async () => { await api.del(`/api/customers/${c.id}`); navigate('/customers'); }} />}
    </>
  );
}
