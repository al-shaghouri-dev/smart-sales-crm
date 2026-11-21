import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Contact, Download, Plus, Search } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Spinner, fieldError, useLoader, useToast } from '../components/ui';
import { CustomerStatus, Pager, fmtDay, initials } from '../components/crm';
import { ProviderBadge } from './Inbox';

const STATUSES = ['new', 'lead', 'customer', 'inactive'];

export function CustomerForm({ customer, onClose, onSaved }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({
    displayName: customer?.displayName || '', phone: customer?.phone || '', email: customer?.email || '',
    companyName: customer?.companyName || '', status: customer?.status || 'lead', tags: (customer?.tags || []).join(', '), notes: customer?.notes || ''
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = { ...f, tags: f.tags.split(/[,،]/).map(s => s.trim()).filter(Boolean) };
    try {
      const r = customer ? await api.patch(`/api/customers/${customer.id}`, body) : await api.post('/api/customers', body);
      toast.success(t('common.saved'));
      onSaved(r.customer);
    } catch (err) { setError(err); if (!err.details?.field) toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }
  return (
    <Modal title={customer ? t('customers.edit') : t('customers.add')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="customer-form" loading={busy}>{t('common.save')}</Button></>}>
      <form id="customer-form" className="form-grid" onSubmit={submit} noValidate>
        <Field label={t('customers.name')} error={fieldError(t, error, 'displayName')} full>{id => <input id={id} dir="auto" required maxLength={120} value={f.displayName} onChange={set('displayName')} />}</Field>
        <Field label={t('customers.phone')} error={fieldError(t, error, 'phone')}>{id => <input id={id} type="tel" dir="ltr" value={f.phone} onChange={set('phone')} />}</Field>
        <Field label={t('customers.email')} error={fieldError(t, error, 'email')}>{id => <input id={id} type="email" dir="ltr" value={f.email} onChange={set('email')} />}</Field>
        <Field label={t('customers.companyName')}>{id => <input id={id} dir="auto" value={f.companyName} onChange={set('companyName')} />}</Field>
        <Field label={t('customers.statusLabel')}>{id => <select id={id} value={f.status} onChange={set('status')}>{STATUSES.map(s => <option key={s} value={s}>{t(`customers.status.${s}`)}</option>)}</select>}</Field>
        <Field label={t('customers.tags')} hint={t('customers.tagsHint')} full>{id => <input id={id} dir="auto" value={f.tags} onChange={set('tags')} />}</Field>
        <Field label={t('customers.about')} full>{id => <textarea id={id} dir="auto" rows={3} value={f.notes} onChange={set('notes')} />}</Field>
      </form>
    </Modal>
  );
}

export default function Customers() {
  const { t, i18n } = useTranslation();
  const { can } = useApp();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [urlParams] = useSearchParams();
  const urlSearch = urlParams.get('search') || '';
  const [search, setSearch] = useState(urlSearch);
  const [query, setQuery] = useState(urlSearch);
  useEffect(() => { setSearch(urlSearch); setQuery(urlSearch); setPage(1); }, [urlSearch]);
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  useEffect(() => { const h = setTimeout(() => { setQuery(search); setPage(1); }, 300); return () => clearTimeout(h); }, [search]);
  const params = new URLSearchParams({ page: String(page), ...(status && { status }), ...(tag && { tag }), ...(query && { search: query }) });
  const data = useLoader(() => api.get(`/api/customers?${params}`), [params.toString()]);
  const tags = useLoader(() => api.get('/api/customers/tags'), []);
  const manage = can('customers.manage');

  return (
    <>
      <PageHeader title={t('customers.title')} subtitle={t('customers.subtitle')} actions={<>
        {can('customers.export') && <a className="btn btn-secondary" href={`/api/customers/export.csv?${new URLSearchParams({ ...(status && { status }), ...(tag && { tag }), ...(query && { search: query }) })}`}><Download size={16} aria-hidden />{t('customers.export')}</a>}
        {manage && <Button variant="primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />{t('customers.add')}</Button>}
      </>} />
      <div className="chips">
        {['', ...STATUSES].map(s => (
          <button key={s || 'all'} type="button" className={`chip ${status === s ? 'active' : ''}`} onClick={() => { setStatus(s); setPage(1); }}>
            {s ? t(`customers.status.${s}`) : t('customers.all')}
            {data.data?.counts && <span className="chip-count">{s ? data.data.counts[s] : Object.values(data.data.counts).reduce((a, b) => a + b, 0)}</span>}
          </button>
        ))}
      </div>
      <Card>
        <div className="toolbar wrap">
          <div className="search-box grow">
            <Search size={16} aria-hidden />
            <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('customers.searchPlaceholder')} aria-label={t('common.search')} />
          </div>
          {tags.data?.tags?.length > 0 && (
            <select value={tag} onChange={e => { setTag(e.target.value); setPage(1); }} aria-label={t('customers.tags')}>
              <option value="">{t('customers.allTags')}</option>
              {tags.data.tags.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
          )}
        </div>
        {data.loading && !data.data ? <Spinner /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.data.customers.length ? (
          <EmptyState icon={Contact} title={t('customers.emptyTitle')}>{t('customers.emptyBody')}</EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table clickable">
                <thead><tr>
                  <th>{t('customers.name')}</th><th>{t('customers.statusLabel')}</th><th className="hide-sm">{t('customers.tags')}</th>
                  <th className="hide-sm">{t('customers.source')}</th><th className="hide-xs">{t('customers.lastContact')}</th>
                </tr></thead>
                <tbody>{data.data.customers.map(c => (
                  <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                    <td>
                      <Link to={`/customers/${c.id}`} className="person" onClick={e => e.stopPropagation()}>
                        <span className="avatar sm" aria-hidden>{initials(c.displayName)}</span>
                        <span className="person-main"><strong dir="auto">{c.displayName}</strong><small className="muted" dir="ltr">{c.phone || c.email || c.companyName || ''}</small></span>
                      </Link>
                    </td>
                    <td><CustomerStatus status={c.status} />{c.openDeals > 0 && <span className="muted small nowrap"> · {t('customers.openDealsCount', { count: c.openDeals })}</span>}</td>
                    <td className="hide-sm"><div className="tag-list">{c.tags.slice(0, 3).map(x => <span key={x} className="tag">{x}</span>)}</div></td>
                    <td className="hide-sm">{c.source && c.source !== 'manual' ? <ProviderBadge provider={c.source} /> : <span className="muted small">{t('customers.manual')}</span>}</td>
                    <td className="muted small hide-xs">{fmtDay(c.lastContactAt || c.createdAt, i18n.language)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <Pager page={data.data.page} pages={data.data.pages} onPage={setPage} />
          </>
        )}
      </Card>
      {adding && <CustomerForm onClose={() => setAdding(false)} onSaved={c => { setAdding(false); navigate(`/customers/${c.id}`); }} />}
    </>
  );
}
