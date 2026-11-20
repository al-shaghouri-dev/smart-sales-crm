import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Plus, Search, ShoppingBag, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Modal, PageHeader, Spinner, useLoader, useToast } from '../components/ui';
import { CustomerPicker, ORDER_TONES, Pager, fmtDateTime, fmtDay, money } from '../components/crm';

const STATUSES = ['new', 'confirmed', 'shipped', 'delivered', 'cancelled'];
const emptyItem = () => ({ name: '', quantity: 1, unitPrice: '' });

export function OrderForm({ order, contact, onClose, onSaved }) {
  const { t, i18n } = useTranslation();
  const { me } = useApp();
  const toast = useToast();
  const [customer, setCustomer] = useState(order?.contactId ? { id: order.contactId, displayName: order.contactName } : contact || null);
  const [items, setItems] = useState(order?.items?.length ? order.items.map(i => ({ name: i.name, quantity: i.quantity, unitPrice: i.unitPrice })) : [emptyItem()]);
  const [f, setF] = useState({ discount: order?.discount ?? '', shipping: order?.shipping ?? '', notes: order?.notes || '', shippingAddress: order?.shippingAddress || '', status: order?.status || 'new' });
  const [busy, setBusy] = useState(false);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  const setItem = (i, k) => e => setItems(list => list.map((it, j) => (j === i ? { ...it, [k]: e.target.value } : it)));
  const subtotal = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0), 0);
  const currency = order?.currency || me.company.currency;
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const body = {
      contactId: customer?.id || null, status: f.status, notes: f.notes, shippingAddress: f.shippingAddress,
      items: items.filter(it => it.name.trim()).map(it => ({ name: it.name, quantity: Number(it.quantity) || 1, unitPrice: Number(it.unitPrice) || 0 })),
      ...(f.discount !== '' ? { discount: Number(f.discount) } : {}), ...(f.shipping !== '' ? { shipping: Number(f.shipping) } : {})
    };
    try {
      const r = order ? await api.patch(`/api/orders/${order.id}`, body) : await api.post('/api/orders', body);
      toast.success(t('common.saved'));
      onSaved(r.order);
    } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal size="lg" title={order ? t('orders.editTitle', { number: order.number }) : t('orders.new')} onClose={onClose}
      footer={<><span className="muted small grow">{t('orders.totalsNote')}</span><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="order-form" loading={busy}>{t('common.save')}</Button></>}>
      <form id="order-form" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label={t('orders.customer')}>{id => <CustomerPicker id={id} value={customer} onChange={setCustomer} />}</Field>
          <Field label={t('orders.statusLabel')}>{id => <select id={id} value={f.status} onChange={set('status')}>{STATUSES.map(s => <option key={s} value={s}>{t(`orders.status.${s}`)}</option>)}</select>}</Field>
        </div>
        <div className="items-editor">
          <div className="items-head muted small"><span>{t('orders.item')}</span><span>{t('orders.qty')}</span><span>{t('orders.price')}</span><span /></div>
          {items.map((it, i) => (
            <div key={i} className="items-row">
              <input dir="auto" value={it.name} onChange={setItem(i, 'name')} placeholder={t('orders.itemPlaceholder')} aria-label={t('orders.item')} />
              <input type="number" min="0.001" step="any" dir="ltr" value={it.quantity} onChange={setItem(i, 'quantity')} aria-label={t('orders.qty')} />
              <input type="number" min="0" step="0.01" dir="ltr" value={it.unitPrice} onChange={setItem(i, 'unitPrice')} aria-label={t('orders.price')} />
              <IconButton label={t('common.remove')} disabled={items.length === 1} onClick={() => setItems(list => list.filter((_, j) => j !== i))}><Trash2 size={15} /></IconButton>
            </div>
          ))}
          <Button size="sm" type="button" onClick={() => setItems(list => [...list, emptyItem()])}><Plus size={14} aria-hidden />{t('orders.addItem')}</Button>
        </div>
        <div className="form-grid three mt">
          <Field label={t('orders.discount')}>{id => <input id={id} type="number" min="0" step="0.01" dir="ltr" value={f.discount} onChange={set('discount')} />}</Field>
          <Field label={t('orders.shipping')} hint={t('orders.shippingHint')}>{id => <input id={id} type="number" min="0" step="0.01" dir="ltr" value={f.shipping} onChange={set('shipping')} />}</Field>
          <div className="field"><span className="label">{t('orders.subtotal')}</span><strong className="big-number">{money(subtotal, currency, i18n.language)}</strong></div>
          <Field label={t('orders.shippingAddress')} full>{id => <textarea id={id} dir="auto" rows={2} value={f.shippingAddress} onChange={set('shippingAddress')} />}</Field>
          <Field label={t('orders.notes')} full>{id => <textarea id={id} dir="auto" rows={2} value={f.notes} onChange={set('notes')} />}</Field>
        </div>
      </form>
    </Modal>
  );
}

function OrderView({ id, onClose, onChanged }) {
  const { t, i18n } = useTranslation();
  const { can } = useApp();
  const toast = useToast();
  const data = useLoader(() => api.get(`/api/orders/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (editing && data.data) return <OrderForm order={data.data.order} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); data.reload(); onChanged(); }} />;
  const o = data.data?.order;
  const locale = i18n.language;
  const manage = can('orders.manage');
  async function setStatus(status) {
    try { await api.patch(`/api/orders/${id}`, { status }); data.reload(); onChanged(); } catch (err) { toast.error(errorMessage(t, err)); }
  }
  return (
    <Modal size="lg" title={o ? t('orders.orderNumber', { number: o.number }) : t('common.loading')} onClose={onClose}
      footer={o && <>{manage && <Button variant="ghost" onClick={() => setDeleting(true)}><Trash2 size={14} aria-hidden />{t('common.delete')}</Button>}<span className="grow" />
        <Button onClick={() => window.print()}>{t('orders.print')}</Button>{manage && <Button variant="primary" onClick={() => setEditing(true)}>{t('common.edit')}</Button>}</>}>
      {!o ? <Spinner /> : (
        <div className="order-view print-area">
          <div className="order-top">
            <div>
              <div className="muted small">{fmtDateTime(o.createdAt, locale)}</div>
              {o.contactName ? <Link to={`/customers/${o.contactId}`} dir="auto"><strong>{o.contactName}</strong></Link> : <span className="muted">{t('orders.noCustomer')}</span>}
              {o.contactPhone && <div className="muted small" dir="ltr">{o.contactPhone}</div>}
            </div>
            {manage ? (
              <select value={o.status} onChange={e => setStatus(e.target.value)} aria-label={t('orders.statusLabel')}>{STATUSES.map(s => <option key={s} value={s}>{t(`orders.status.${s}`)}</option>)}</select>
            ) : <Badge tone={ORDER_TONES[o.status]}>{t(`orders.status.${o.status}`)}</Badge>}
          </div>
          <table className="table compact">
            <thead><tr><th>{t('orders.item')}</th><th>{t('orders.qty')}</th><th>{t('orders.price')}</th><th>{t('orders.lineTotal')}</th></tr></thead>
            <tbody>{o.items.map(i => <tr key={i.id}><td dir="auto">{i.name}</td><td>{i.quantity}</td><td>{money(i.unitPrice, o.currency, locale)}</td><td>{money(i.lineTotal, o.currency, locale)}</td></tr>)}</tbody>
          </table>
          <dl className="totals">
            <dt>{t('orders.subtotal')}</dt><dd>{money(o.subtotal, o.currency, locale)}</dd>
            {o.discount > 0 && <><dt>{t('orders.discount')}</dt><dd>−{money(o.discount, o.currency, locale)}</dd></>}
            <dt>{t('orders.tax')}</dt><dd>{money(o.tax, o.currency, locale)}</dd>
            <dt>{t('orders.shipping')}</dt><dd>{money(o.shipping, o.currency, locale)}</dd>
            <dt className="grand">{t('orders.total')}</dt><dd className="grand">{money(o.total, o.currency, locale)}</dd>
          </dl>
          {o.shippingAddress && <p dir="auto"><strong>{t('orders.shippingAddress')}:</strong> {o.shippingAddress}</p>}
          {o.notes && <p className="muted" dir="auto">{o.notes}</p>}
        </div>
      )}
      {deleting && <ConfirmDialog title={t('orders.deleteTitle')} body={t('orders.deleteBody', { number: o?.number })} danger confirmLabel={t('common.delete')}
        onClose={() => setDeleting(false)} onConfirm={async () => { await api.del(`/api/orders/${id}`); onChanged(); onClose(); }} />}
    </Modal>
  );
}

export default function Orders() {
  const { t, i18n } = useTranslation();
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const openId = params.get('open');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => { const h = setTimeout(() => { setQuery(search); setPage(1); }, 300); return () => clearTimeout(h); }, [search]);
  const qs = new URLSearchParams({ page: String(page), ...(status && { status }), ...(query && { search: query }) });
  const data = useLoader(() => api.get(`/api/orders?${qs}`), [qs.toString()]);
  const locale = i18n.language;

  return (
    <>
      <PageHeader title={t('orders.title')} subtitle={t('orders.subtitle')} actions={<>
        {can('orders.export') && <a className="btn btn-secondary" href={`/api/orders/export.csv?${new URLSearchParams({ ...(status && { status }), ...(query && { search: query }) })}`}><Download size={16} aria-hidden />{t('orders.export')}</a>}
        {can('orders.manage') && <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden />{t('orders.new')}</Button>}
      </>} />
      <div className="chips">
        {['', ...STATUSES].map(s => (
          <button key={s || 'all'} type="button" className={`chip ${status === s ? 'active' : ''}`} onClick={() => { setStatus(s); setPage(1); }}>
            {s ? t(`orders.status.${s}`) : t('orders.all')}
            {data.data?.counts && <span className="chip-count">{s ? data.data.counts[s] : Object.values(data.data.counts).reduce((a, b) => a + b, 0)}</span>}
          </button>
        ))}
      </div>
      <Card>
        <div className="toolbar">
          <div className="search-box grow"><Search size={16} aria-hidden /><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('orders.searchPlaceholder')} aria-label={t('common.search')} /></div>
        </div>
        {data.loading && !data.data ? <Spinner /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.data.orders.length ? (
          <EmptyState icon={ShoppingBag} title={t('orders.emptyTitle')}>{t('orders.emptyBody')}</EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table clickable">
                <thead><tr><th>#</th><th>{t('orders.customer')}</th><th>{t('orders.statusLabel')}</th><th>{t('orders.total')}</th><th className="hide-xs">{t('orders.date')}</th></tr></thead>
                <tbody>{data.data.orders.map(o => (
                  <tr key={o.id} onClick={() => setParams({ open: o.id })}>
                    <td><strong>#{o.number}</strong></td>
                    <td dir="auto">{o.contactName || <span className="muted">—</span>}</td>
                    <td><Badge tone={ORDER_TONES[o.status]}>{t(`orders.status.${o.status}`)}</Badge></td>
                    <td className="nowrap"><strong>{money(o.total, o.currency, locale)}</strong></td>
                    <td className="muted small hide-xs">{fmtDay(o.createdAt, locale)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager page={data.data.page} pages={data.data.pages} onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <OrderForm onClose={() => setCreating(false)} onSaved={o => { setCreating(false); data.reload(); setParams({ open: o.id }); }} />}
      {openId && <OrderView id={openId} onClose={() => setParams({})} onChanged={data.reload} />}
    </>
  );
}
