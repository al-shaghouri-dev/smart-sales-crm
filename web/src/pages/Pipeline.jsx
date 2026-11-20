import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, CalendarClock, Kanban, Plus, Settings2, Trash2, UserRound } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Modal, PageHeader, Spinner, fieldError, useLoader, useToast } from '../components/ui';
import { CustomerPicker, fmtDay, money } from '../components/crm';

export function DealForm({ deal, contact, stages, onClose, onSaved, onDelete }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({ title: deal?.title || '', value: deal?.value ?? '', expectedClose: deal?.expectedClose || '', stageId: deal?.stageId || '' });
  const [customer, setCustomer] = useState(deal?.contactId ? { id: deal.contactId, displayName: deal.contactName } : contact || null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { title: f.title, value: f.value === '' ? 0 : Number(f.value), expectedClose: f.expectedClose || null, contactId: customer?.id || null, ...(f.stageId ? { stageId: f.stageId } : {}) };
    try {
      const r = deal ? await api.patch(`/api/deals/${deal.id}`, body) : await api.post('/api/deals', body);
      toast.success(t('common.saved'));
      onSaved(r.deal);
    } catch (err) { setError(err); if (!err.details?.field) toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={deal ? t('pipeline.editDeal') : t('pipeline.newDeal')} onClose={onClose}
      footer={<>{onDelete && <Button variant="ghost" onClick={onDelete}><Trash2 size={14} aria-hidden />{t('common.delete')}</Button>}<span className="grow" /><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="deal-form" loading={busy}>{t('common.save')}</Button></>}>
      <form id="deal-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label={t('pipeline.dealTitle')} error={fieldError(t, error, 'title')} full>{id => <input id={id} dir="auto" required maxLength={160} value={f.title} onChange={set('title')} />}</Field>
        <Field label={t('pipeline.value')} error={fieldError(t, error, 'value')}>{id => <input id={id} type="number" min="0" step="0.01" dir="ltr" value={f.value} onChange={set('value')} />}</Field>
        <Field label={t('pipeline.expectedClose')}>{id => <input id={id} type="date" dir="ltr" value={f.expectedClose} onChange={set('expectedClose')} />}</Field>
        {stages && <Field label={t('pipeline.stage')}>{id => <select id={id} value={f.stageId} onChange={set('stageId')}><option value="">{t('pipeline.firstStage')}</option>{stages.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}</Field>}
        <Field label={t('pipeline.customer')} full>{id => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}</Field>
      </form>
    </Modal>
  );
}

function StagesModal({ stages, onClose, onSaved }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [list, setList] = useState(stages.map(s => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const move = (i, d) => setList(l => { const n = l.slice(); const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  async function save() {
    setBusy(true);
    try { await api.put('/api/deals/stages', { stages: list.map(s => ({ id: s.id, name: s.name, kind: s.kind })) }); toast.success(t('common.saved')); onSaved(); }
    catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('pipeline.editStages')} onClose={onClose} footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button></>}>
      <ul className="stage-editor">
        {list.map((s, i) => (
          <li key={s.id || `n${i}`}>
            <input dir="auto" value={s.name} maxLength={60} onChange={e => setList(l => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label={t('pipeline.stageName')} />
            <select value={s.kind} onChange={e => setList(l => l.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))} aria-label={t('pipeline.stageKind')}>
              {['open', 'won', 'lost'].map(k => <option key={k} value={k}>{t(`pipeline.kind.${k}`)}</option>)}
            </select>
            <IconButton label={t('pipeline.moveUp')} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={15} /></IconButton>
            <IconButton label={t('pipeline.moveDown')} disabled={i === list.length - 1} onClick={() => move(i, 1)}><ArrowDown size={15} /></IconButton>
            <IconButton label={t('common.delete')} onClick={() => setList(l => l.filter((_, j) => j !== i))}><Trash2 size={15} /></IconButton>
          </li>
        ))}
      </ul>
      <Button size="sm" onClick={() => setList(l => [...l, { name: t('pipeline.newStage'), kind: 'open' }])}><Plus size={14} aria-hidden />{t('pipeline.addStage')}</Button>
    </Modal>
  );
}

export default function Pipeline() {
  const { t, i18n } = useTranslation();
  const { can } = useApp();
  const toast = useToast();
  const [mine, setMine] = useState(false);
  const data = useLoader(() => api.get(`/api/deals${mine ? '?owner=me' : ''}`), [mine]);
  const [modal, setModal] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overStage, setOverStage] = useState(null);
  const manage = can('customers.manage');
  const locale = i18n.language;

  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const { stages, deals, currency } = data.data;
  const openValue = deals.filter(d => d.status === 'open').reduce((s, d) => s + d.value, 0);

  async function moveDeal(dealId, stageId) {
    const deal = deals.find(d => d.id === dealId);
    if (!deal || deal.stageId === stageId) return;
    data.setData({ ...data.data, deals: deals.map(d => (d.id === dealId ? { ...d, stageId } : d)) });
    try { await api.patch(`/api/deals/${dealId}`, { stageId }); data.reload(); } catch (err) { toast.error(errorMessage(t, err)); data.reload(); }
  }

  return (
    <>
      <PageHeader title={t('pipeline.title')} subtitle={t('pipeline.subtitle', { value: money(openValue, currency, locale), count: deals.filter(d => d.status === 'open').length })} actions={<>
        <label className="check inline"><input type="checkbox" checked={mine} onChange={e => setMine(e.target.checked)} /><span>{t('pipeline.onlyMine')}</span></label>
        {manage && <Button onClick={() => setModal({ type: 'stages' })}><Settings2 size={16} aria-hidden />{t('pipeline.editStages')}</Button>}
        {manage && <Button variant="primary" onClick={() => setModal({ type: 'new' })}><Plus size={16} aria-hidden />{t('pipeline.newDeal')}</Button>}
      </>} />
      {!deals.length && <EmptyState icon={Kanban} title={t('pipeline.emptyTitle')}>{t('pipeline.emptyBody')}</EmptyState>}
      <div className="board" role="list">
        {stages.map(s => {
          const list = deals.filter(d => d.stageId === s.id);
          const total = list.reduce((sum, d) => sum + d.value, 0);
          return (
            <section key={s.id} className={`board-col kind-${s.kind} ${overStage === s.id ? 'over' : ''}`} role="listitem"
              onDragOver={e => { if (manage) { e.preventDefault(); setOverStage(s.id); } }} onDragLeave={() => setOverStage(null)}
              onDrop={e => { e.preventDefault(); setOverStage(null); if (dragId) moveDeal(dragId, s.id); setDragId(null); }}>
              <header className="board-head">
                <strong dir="auto">{s.name}</strong>
                <span className="muted small">{list.length} · {money(total, currency, locale)}</span>
              </header>
              <div className="board-cards">
                {list.map(d => (
                  <article key={d.id} className="deal-card" draggable={manage} onDragStart={() => setDragId(d.id)} onDragEnd={() => setDragId(null)}>
                    <button type="button" className="deal-open" onClick={() => manage && setModal({ type: 'edit', deal: d })}>
                      <strong dir="auto">{d.title}</strong>
                      <span className="deal-value">{money(d.value, d.currency, locale)}</span>
                    </button>
                    <div className="deal-meta muted small">
                      {d.contactName && <Link to={`/customers/${d.contactId}`} dir="auto"><UserRound size={13} aria-hidden />{d.contactName}</Link>}
                      {d.expectedClose && <span><CalendarClock size={13} aria-hidden />{fmtDay(d.expectedClose, locale)}</span>}
                    </div>
                    {manage && (
                      <select className="deal-stage" value={d.stageId} onChange={e => moveDeal(d.id, e.target.value)} aria-label={t('pipeline.stage')}>
                        {stages.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {modal?.type === 'new' && <DealForm stages={stages} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
      {modal?.type === 'edit' && (
        <DealForm deal={modal.deal} stages={stages} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} onDelete={() => setModal({ type: 'delete', deal: modal.deal })} />
      )}
      {modal?.type === 'delete' && <ConfirmDialog title={t('pipeline.deleteDeal')} body={t('pipeline.deleteBody', { title: modal.deal.title })} danger confirmLabel={t('common.delete')}
        onClose={() => setModal(null)} onConfirm={async () => { await api.del(`/api/deals/${modal.deal.id}`); data.reload(); }} />}
      {modal?.type === 'stages' && <StagesModal stages={stages} onClose={() => setModal(null)} onSaved={() => { setModal(null); data.reload(); }} />}
    </>
  );
}
