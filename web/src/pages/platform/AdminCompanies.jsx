import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, Plus } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/i18n';
import { Badge, Button, EmptyState, ErrorState, Field, LinkDialog, Modal, PageHeader, Spinner, fieldError, fmtDate, localized, useLoader, useToast } from '../../components/ui';
import { TIMEZONES } from '../../components/ui';
import { SUB_TONES } from '../Billing';
import { COMPANY_TONES } from './AdminOverview';


export function CreateCompanyModal({ plans, currencies, onClose, onCreated }) {
  const { t } = useTranslation();
  const { locale } = useApp();
  const toast = useToast();
  const [f, setF] = useState({
    name: '', email: '', phone: '', country: '', businessType: '', timezone: 'UTC', currency: 'USD', defaultLocale: locale, status: 'active',
    ownerName: '', ownerEmail: '', ownerPhone: '', planId: '', periods: 1, trial: false
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const plan = plans.find(p => p.id === f.planId);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await api.post('/api/platform/companies', {
        name: f.name, email: f.email || undefined, phone: f.phone, country: f.country, businessType: f.businessType,
        timezone: f.timezone, currency: f.currency, defaultLocale: f.defaultLocale, status: f.status,
        owner: { name: f.ownerName, email: f.ownerEmail, phone: f.ownerPhone },
        subscription: f.planId ? { planId: f.planId, periods: Number(f.periods) || 1, trial: f.trial } : undefined
      });
      toast.success(t('admin.companyCreated'));
      onCreated(res);
    } catch (err) { setError(err); if (!err.details?.field) toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }

  return (
    <Modal size="lg" title={t('admin.newCompany')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="company-form" loading={busy}>{t('admin.createCompany')}</Button></>}>
      <form id="company-form" onSubmit={submit} noValidate>
        <h3 className="form-section">{t('register.company')}</h3>
        <div className="form-grid">
          <Field label={t('company.name')} error={fieldError(t, error, 'name')} full>{id => <input id={id} required maxLength={120} value={f.name} onChange={set('name')} />}</Field>
          <Field label={t('company.email')} error={fieldError(t, error, 'email')}>{id => <input id={id} type="email" dir="ltr" value={f.email} onChange={set('email')} />}</Field>
          <Field label={t('company.phone')}>{id => <input id={id} type="tel" dir="ltr" value={f.phone} onChange={set('phone')} />}</Field>
          <Field label={t('company.country')}>{id => <input id={id} value={f.country} onChange={set('country')} />}</Field>
          <Field label={t('company.businessType')}>{id => <input id={id} value={f.businessType} onChange={set('businessType')} />}</Field>
          <Field label={t('company.timezone')}>{id => <select id={id} dir="ltr" value={f.timezone} onChange={set('timezone')}>{TIMEZONES.map(z => <option key={z}>{z}</option>)}</select>}</Field>
          <Field label={t('company.currency')}>{id => <select id={id} dir="ltr" value={f.currency} onChange={set('currency')}>{currencies.map(c => <option key={c}>{c}</option>)}</select>}</Field>
          <Field label={t('company.defaultLocale')}>{id => <select id={id} value={f.defaultLocale} onChange={set('defaultLocale')}><option value="ar">{t('common.arabic')}</option><option value="en">{t('common.english')}</option></select>}</Field>
          <Field label={t('common.status')}>{id => <select id={id} value={f.status} onChange={set('status')}><option value="active">{t('platform.status.active')}</option><option value="pending">{t('platform.status.pending')}</option></select>}</Field>
        </div>
        <h3 className="form-section">{t('register.owner')}</h3>
        <div className="form-grid">
          <Field label={t('team.name')} error={fieldError(t, error, 'owner.name')}>{id => <input id={id} required value={f.ownerName} onChange={set('ownerName')} />}</Field>
          <Field label={t('auth.email')} error={fieldError(t, error, 'owner.email')}>{id => <input id={id} type="email" dir="ltr" required value={f.ownerEmail} onChange={set('ownerEmail')} />}</Field>
          <Field label={t('team.phone')}>{id => <input id={id} type="tel" dir="ltr" value={f.ownerPhone} onChange={set('ownerPhone')} />}</Field>
        </div>
        <p className="hint">{t('admin.ownerInviteHint')}</p>
        <h3 className="form-section">{t('admin.subscription')}</h3>
        <div className="form-grid">
          <Field label={t('billing.plan')}>{id => (
            <select id={id} value={f.planId} onChange={set('planId')}>
              <option value="">{t('admin.noPlanYet')}</option>
              {plans.map(p => <option key={p.id} value={p.id}>{localized(p.name, locale)}{p.isActive ? '' : ` (${t('plans.inactive')})`}</option>)}
            </select>
          )}</Field>
          {plan && <Field label={t('admin.periods', { unit: t(`plans.unit.${plan.interval}`) })}>{id => <input id={id} type="number" min="1" max="120" value={f.periods} onChange={set('periods')} />}</Field>}
          {plan?.trialDays > 0 && <label className="check full"><input type="checkbox" checked={f.trial} onChange={set('trial')} /><span>{t('admin.startTrial', { count: plan.trialDays })}</span></label>}
        </div>
      </form>
    </Modal>
  );
}

export default function AdminCompanies() {
  const { t } = useTranslation();
  const { locale } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => Object.fromEntries([...params].filter(([, v]) => v)), [params]);
  const qs = new URLSearchParams(query).toString();
  const list = useLoader(() => api.get(`/api/platform/companies${qs ? `?${qs}` : ''}`).then(r => r.companies), [qs]);
  const plans = useLoader(() => api.get('/api/platform/plans'), []);
  const [creating, setCreating] = useState(false);
  const [invitation, setInvitation] = useState(null);
  const [search, setSearch] = useState(query.search || '');
  const update = (k, v) => { const next = new URLSearchParams(params); v ? next.set(k, v) : next.delete(k); setParams(next); };

  return (
    <>
      <PageHeader title={t('platform.companiesTitle')} subtitle={t('admin.companiesSubtitle')}
        actions={<Button variant="primary" onClick={() => setCreating(true)} disabled={!plans.data}><Plus size={16} aria-hidden />{t('admin.newCompany')}</Button>} />
      <div className="card">
        <form className="toolbar wrap" onSubmit={e => { e.preventDefault(); update('search', search.trim()); }}>
          <input type="search" className="search" placeholder={t('admin.searchCompanies')} aria-label={t('common.search')} value={search} onChange={e => setSearch(e.target.value)} onBlur={() => update('search', search.trim())} />
          <select aria-label={t('common.status')} value={query.status || ''} onChange={e => update('status', e.target.value)}>
            <option value="">{t('admin.allStatuses')}</option>
            {['active', 'pending', 'suspended'].map(s => <option key={s} value={s}>{t(`platform.status.${s}`)}</option>)}
          </select>
          <select aria-label={t('admin.subscription')} value={query.subscription || ''} onChange={e => update('subscription', e.target.value)}>
            <option value="">{t('admin.allSubscriptions')}</option>
            {['active', 'pending', 'expired', 'suspended', 'cancelled', 'none'].map(s => <option key={s} value={s}>{t(`subscriptionStatus.${s}`)}</option>)}
          </select>
          {plans.data && (
            <select aria-label={t('billing.plan')} value={query.plan || ''} onChange={e => update('plan', e.target.value)}>
              <option value="">{t('admin.allPlans')}</option>
              {plans.data.plans.map(p => <option key={p.id} value={p.id}>{localized(p.name, locale)}</option>)}
            </select>
          )}
        </form>
        {list.loading ? <Spinner /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.data.length === 0 ? <EmptyState icon={Building2}>{t('admin.noCompaniesMatch')}</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('platform.company')}</th><th>{t('common.status')}</th><th>{t('admin.subscription')}</th><th>{t('platform.members')}</th><th>{t('platform.created')}</th></tr></thead>
              <tbody>
                {list.data.map(c => (
                  <tr key={c.id} className="row-link" onClick={() => navigate(`/admin/companies/${c.id}`)}>
                    <td><Link to={`/admin/companies/${c.id}`} onClick={e => e.stopPropagation()}><strong>{c.name}</strong></Link><div className="muted small" dir="ltr">{c.email || c.slug}</div></td>
                    <td><Badge tone={COMPANY_TONES[c.status]}>{t(`platform.status.${c.status}`)}</Badge></td>
                    <td>{c.subscription ? <><Badge tone={SUB_TONES[c.subscription.status]}>{t(`subscriptionStatus.${c.subscription.status}`)}</Badge><div className="muted small">{localized(c.subscription.planName, locale)} · {fmtDate(c.subscription.endsAt, locale)}</div></> : <span className="muted small">{t('subscriptionStatus.none')}</span>}</td>
                    <td>{c.members}</td>
                    <td className="small">{fmtDate(c.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <CreateCompanyModal plans={plans.data.plans} currencies={plans.data.currencies} onClose={() => setCreating(false)}
        onCreated={res => { setCreating(false); list.reload(); if (res.invitation) setInvitation({ ...res.invitation, companyId: res.companyId }); else navigate(`/admin/companies/${res.companyId}`); }} />}
      {invitation && <LinkDialog result={invitation} title={t('admin.ownerInvitation')} onClose={() => { const id = invitation.companyId; setInvitation(null); navigate(`/admin/companies/${id}`); }} />}
    </>
  );
}
