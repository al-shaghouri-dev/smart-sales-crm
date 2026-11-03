import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarPlus, Link2, PauseCircle, PlayCircle, Receipt } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/i18n';
import { roleLabel } from '../../components/Layout';
import { Badge, Button, Card, EmptyState, ErrorState, Field, LinkDialog, Modal, PageHeader, Spinner, fieldError, fmtDate, fmtMoney, localized, useLoader, useToast } from '../../components/ui';
import { TIMEZONES } from '../../components/ui';
import { SUB_TONES } from '../Billing';
import { COMPANY_TONES } from './AdminOverview';

const toInputDate = v => (v ? new Date(v).toISOString().slice(0, 10) : '');

function useAction(after) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = async (key, fn, success) => {
    setBusy(key); setError(null);
    try { const r = await fn(); if (success) toast.success(success); await after?.(r); return r; }
    catch (err) { setError(err); toast.error(errorMessage(t, err)); return null; }
    finally { setBusy(null); }
  };
  return { busy, error, run };
}

function SuspendModal({ company, onClose, onDone }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction(onDone);
  return (
    <Modal title={t('admin.suspendTitle', { name: company.name })} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="danger" loading={busy === 's'} disabled={!reason.trim()}
        onClick={async () => { if (await run('s', () => api.post(`/api/platform/companies/${company.id}/suspend`, { reason }), t('admin.suspended'))) onClose(); }}>{t('admin.suspend')}</Button></>}>
      <p className="muted">{t('admin.suspendBody')}</p>
      <Field label={t('admin.suspendReason')} error={fieldError(t, error, 'reason')}>{id => <textarea id={id} rows={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />}</Field>
    </Modal>
  );
}

function ProfileCard({ company, onSaved }) {
  const { t } = useTranslation();
  const [f, setF] = useState({ name: company.name, email: company.email || '', phone: company.phone || '', country: company.country || '', address: company.address || '', businessType: company.businessType || '', timezone: company.timezone, currency: company.currency, defaultLocale: company.defaultLocale });
  const { busy, error, run } = useAction(onSaved);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  return (
    <Card title={t('company.tabs.profile')} actions={<Button variant="primary" loading={busy === 'p'} onClick={() => run('p', () => api.patch(`/api/platform/companies/${company.id}`, f), t('common.saved'))}>{t('common.save')}</Button>}>
      <div className="form-grid">
        <Field label={t('company.name')} error={fieldError(t, error, 'name')} full>{id => <input id={id} value={f.name} onChange={set('name')} />}</Field>
        <Field label={t('company.email')} error={fieldError(t, error, 'email')}>{id => <input id={id} type="email" dir="ltr" value={f.email} onChange={set('email')} />}</Field>
        <Field label={t('company.phone')}>{id => <input id={id} dir="ltr" value={f.phone} onChange={set('phone')} />}</Field>
        <Field label={t('company.country')}>{id => <input id={id} value={f.country} onChange={set('country')} />}</Field>
        <Field label={t('company.businessType')}>{id => <input id={id} value={f.businessType} onChange={set('businessType')} />}</Field>
        <Field label={t('company.timezone')} error={fieldError(t, error, 'timezone')}>{id => <select id={id} dir="ltr" value={f.timezone} onChange={set('timezone')}>{TIMEZONES.map(z => <option key={z}>{z}</option>)}</select>}</Field>
        <Field label={t('company.defaultLocale')}>{id => <select id={id} value={f.defaultLocale} onChange={set('defaultLocale')}><option value="ar">{t('common.arabic')}</option><option value="en">{t('common.english')}</option></select>}</Field>
        <Field label={t('company.address')} full>{id => <textarea id={id} rows={2} value={f.address} onChange={set('address')} />}</Field>
      </div>
    </Card>
  );
}

function SubscriptionCard({ companyId, sub, plans, currencies, onChanged }) {
  const { t } = useTranslation();
  const { locale } = useApp();
  const { busy, error, run } = useAction(onChanged);
  const [assign, setAssign] = useState({ planId: sub?.plan?.id || plans.find(p => p.isActive)?.id || plans[0]?.id || '', status: 'active', periods: 1, trial: false, startsAt: '', endsAt: '', price: '' });
  const [pay, setPay] = useState({ amount: sub?.price || '', currency: sub?.currency || 'USD', method: 'bank_transfer', paidAt: toInputDate(new Date()), reference: '', notes: '', extend: true, periods: 1 });
  const [statusEdit, setStatusEdit] = useState({ status: sub?.status || 'active', endsAt: toInputDate(sub?.endsAt), notes: sub?.notes || '' });
  const [panel, setPanel] = useState(sub ? null : 'assign');
  const plan = plans.find(p => p.id === assign.planId);

  return (
    <Card title={t('admin.subscription')} actions={sub && (
      <div className="row wrap">
        <Button size="sm" onClick={() => setPanel(panel === 'pay' ? null : 'pay')}><Receipt size={14} aria-hidden />{t('admin.recordPayment')}</Button>
        <Button size="sm" onClick={() => run('ext', () => api.post(`/api/platform/companies/${companyId}/subscription/extend`, { periods: 1 }), t('admin.extended'))} loading={busy === 'ext'}><CalendarPlus size={14} aria-hidden />{t('admin.extendOne', { unit: t(`plans.unit.${sub.interval}`) })}</Button>
        <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'status' ? null : 'status')}>{t('admin.changeStatus')}</Button>
        <Button size="sm" variant="ghost" onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>{t('admin.changePlan')}</Button>
      </div>
    )}>
      {sub ? (
        <dl className="facts">
          <div><dt>{t('billing.plan')}</dt><dd><strong>{localized(sub.plan?.name, locale)}</strong>{sub.isTrial && <Badge tone="primary">{t('billing.trial')}</Badge>}</dd></div>
          <div><dt>{t('common.status')}</dt><dd><Badge tone={SUB_TONES[sub.status]}>{t(`subscriptionStatus.${sub.status}`)}</Badge> {sub.access !== 'full' && <Badge tone="danger">{t(`admin.access.${sub.access}`)}</Badge>}</dd></div>
          <div><dt>{t('billing.price')}</dt><dd>{fmtMoney(sub.price, sub.currency, locale)} / {t(`plans.unit.${sub.interval}`)}</dd></div>
          <div><dt>{t('billing.period')}</dt><dd>{fmtDate(sub.startsAt, locale)} → {fmtDate(sub.endsAt, locale)}{sub.daysLeft !== null && sub.status === 'active' && <small className="muted"> · {t('admin.daysLeft', { count: Math.max(sub.daysLeft, 0) })}</small>}</dd></div>
          {sub.notes && <div><dt>{t('admin.notes')}</dt><dd>{sub.notes}</dd></div>}
        </dl>
      ) : <p className="muted">{t('admin.noSubscription')}</p>}

      {panel === 'assign' && (
        <form className="subpanel" onSubmit={async e => { e.preventDefault();
          const body = { planId: assign.planId, status: assign.status, periods: Number(assign.periods) || 1, trial: assign.trial };
          if (assign.startsAt) body.startsAt = assign.startsAt;
          if (assign.endsAt) body.endsAt = assign.endsAt;
          if (assign.price !== '') body.price = Number(assign.price);
          if (await run('assign', () => api.put(`/api/platform/companies/${companyId}/subscription`, body), t('admin.subscriptionSaved'))) setPanel(null); }}>
          <h3 className="form-section">{sub ? t('admin.changePlan') : t('admin.assignPlan')}</h3>
          {plans.length === 0 ? <p className="muted">{t('admin.createPlansFirst')} <Link to="/admin/plans">{t('nav.plans')}</Link></p> : (
            <div className="form-grid three">
              <Field label={t('billing.plan')} error={fieldError(t, error, 'planId')}>{id => <select id={id} value={assign.planId} onChange={e => setAssign(a => ({ ...a, planId: e.target.value }))}>{plans.map(p => <option key={p.id} value={p.id}>{localized(p.name, locale)} · {fmtMoney(p.price, p.currency, locale)}{p.isActive ? '' : ` (${t('plans.inactive')})`}</option>)}</select>}</Field>
              <Field label={t('common.status')}>{id => <select id={id} value={assign.status} onChange={e => setAssign(a => ({ ...a, status: e.target.value }))}>{['active', 'pending'].map(s => <option key={s} value={s}>{t(`subscriptionStatus.${s}`)}</option>)}</select>}</Field>
              {plan && <Field label={t('admin.periods', { unit: t(`plans.unit.${plan.interval}`) })}>{id => <input id={id} type="number" min="1" max="120" value={assign.periods} onChange={e => setAssign(a => ({ ...a, periods: e.target.value }))} />}</Field>}
              <Field label={t('admin.startsAt')} hint={t('admin.defaultToday')}>{id => <input id={id} type="date" value={assign.startsAt} onChange={e => setAssign(a => ({ ...a, startsAt: e.target.value }))} />}</Field>
              <Field label={t('admin.endsAtOptional')} error={fieldError(t, error, 'endsAt')}>{id => <input id={id} type="date" value={assign.endsAt} onChange={e => setAssign(a => ({ ...a, endsAt: e.target.value }))} />}</Field>
              <Field label={t('admin.customPrice')} hint={plan ? fmtMoney(plan.price, plan.currency, locale) : ''}>{id => <input id={id} type="number" min="0" step="0.01" dir="ltr" value={assign.price} onChange={e => setAssign(a => ({ ...a, price: e.target.value }))} />}</Field>
              {plan?.trialDays > 0 && <label className="check full"><input type="checkbox" checked={assign.trial} onChange={e => setAssign(a => ({ ...a, trial: e.target.checked }))} /><span>{t('admin.startTrial', { count: plan.trialDays })}</span></label>}
            </div>
          )}
          {plans.length > 0 && <Button variant="primary" type="submit" loading={busy === 'assign'}>{t('common.save')}</Button>}
        </form>
      )}

      {panel === 'status' && sub && (
        <form className="subpanel" onSubmit={async e => { e.preventDefault();
          if (await run('status', () => api.patch(`/api/platform/companies/${companyId}/subscription`, { status: statusEdit.status, endsAt: statusEdit.endsAt || undefined, notes: statusEdit.notes }), t('admin.subscriptionSaved'))) setPanel(null); }}>
          <h3 className="form-section">{t('admin.changeStatus')}</h3>
          <div className="form-grid three">
            <Field label={t('common.status')}>{id => <select id={id} value={statusEdit.status} onChange={e => setStatusEdit(s => ({ ...s, status: e.target.value }))}>{['pending', 'active', 'expired', 'suspended', 'cancelled'].map(s => <option key={s} value={s}>{t(`subscriptionStatus.${s}`)}</option>)}</select>}</Field>
            <Field label={t('admin.endsAt')} error={fieldError(t, error, 'endsAt')}>{id => <input id={id} type="date" value={statusEdit.endsAt} onChange={e => setStatusEdit(s => ({ ...s, endsAt: e.target.value }))} />}</Field>
            <Field label={t('admin.notes')}>{id => <input id={id} maxLength={1000} value={statusEdit.notes} onChange={e => setStatusEdit(s => ({ ...s, notes: e.target.value }))} />}</Field>
          </div>
          <p className="hint">{t('admin.dataPreserved')}</p>
          <Button variant="primary" type="submit" loading={busy === 'status'}>{t('common.save')}</Button>
        </form>
      )}

      {panel === 'pay' && sub && (
        <form className="subpanel" onSubmit={async e => { e.preventDefault();
          const body = { amount: Number(pay.amount), currency: pay.currency, method: pay.method, paidAt: pay.paidAt, reference: pay.reference, notes: pay.notes };
          if (pay.extend) body.extend = { periods: Number(pay.periods) || 1 };
          if (await run('pay', () => api.post(`/api/platform/companies/${companyId}/payments`, body), t('admin.paymentRecorded'))) setPanel(null); }}>
          <h3 className="form-section">{t('admin.recordPayment')}</h3>
          <div className="form-grid three">
            <Field label={t('billing.amount')} error={fieldError(t, error, 'amount')}>{id => <input id={id} type="number" min="0.01" step="0.01" dir="ltr" required value={pay.amount} onChange={e => setPay(p => ({ ...p, amount: e.target.value }))} />}</Field>
            <Field label={t('company.currency')}>{id => <select id={id} dir="ltr" value={pay.currency} onChange={e => setPay(p => ({ ...p, currency: e.target.value }))}>{currencies.map(c => <option key={c}>{c}</option>)}</select>}</Field>
            <Field label={t('billing.method')}>{id => <select id={id} value={pay.method} onChange={e => setPay(p => ({ ...p, method: e.target.value }))}>{['bank_transfer', 'cash', 'card', 'mobile_wallet', 'other'].map(m => <option key={m} value={m}>{t(`paymentMethods.${m}`)}</option>)}</select>}</Field>
            <Field label={t('billing.paidAt')} error={fieldError(t, error, 'paidAt')}>{id => <input id={id} type="date" value={pay.paidAt} onChange={e => setPay(p => ({ ...p, paidAt: e.target.value }))} />}</Field>
            <Field label={t('billing.reference')}>{id => <input id={id} dir="ltr" maxLength={120} value={pay.reference} onChange={e => setPay(p => ({ ...p, reference: e.target.value }))} />}</Field>
            <Field label={t('admin.internalNotes')}>{id => <input id={id} maxLength={1000} value={pay.notes} onChange={e => setPay(p => ({ ...p, notes: e.target.value }))} />}</Field>
          </div>
          <label className="check"><input type="checkbox" checked={pay.extend} onChange={e => setPay(p => ({ ...p, extend: e.target.checked }))} />
            <span>{t('admin.extendWithPayment')}</span>
            {pay.extend && <input className="inline-number" type="number" min="1" max="120" value={pay.periods} aria-label={t('admin.periods', { unit: t(`plans.unit.${sub.interval}`) })} onChange={e => setPay(p => ({ ...p, periods: e.target.value }))} />}
            {pay.extend && <span>{t(`plans.unit.${sub.interval}`)}</span>}
          </label>
          <Button variant="primary" type="submit" loading={busy === 'pay'}>{t('admin.confirmPayment')}</Button>
        </form>
      )}
    </Card>
  );
}

export default function AdminCompanyDetail() {
  const { t } = useTranslation();
  const { locale } = useApp();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'subscription';
  const detail = useLoader(() => api.get(`/api/platform/companies/${id}`), [id]);
  const plans = useLoader(() => api.get('/api/platform/plans'), []);
  const [modal, setModal] = useState(null);
  const { busy, run } = useAction(() => detail.reload());

  if (detail.loading || plans.loading) return <Spinner />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  const { company, members, subscription, payments, activity } = detail.data;

  return (
    <>
      <Link to="/admin/companies" className="back-link"><ArrowLeft size={14} aria-hidden className="flip-rtl" />{t('platform.companiesTitle')}</Link>
      <PageHeader title={<>{company.name} <Badge tone={COMPANY_TONES[company.status]}>{t(`platform.status.${company.status}`)}</Badge></>}
        subtitle={`${company.slug} · ${t('platform.created')} ${fmtDate(company.createdAt, locale)}`}
        actions={<>
          <Button onClick={async () => { const r = await run('link', () => api.post(`/api/platform/companies/${company.id}/owner-link`)); if (r) setModal({ type: 'link', result: r }); }} loading={busy === 'link'}><Link2 size={16} aria-hidden />{t('admin.ownerLink')}</Button>
          {company.status === 'pending' && <Button variant="primary" loading={busy === 'act'} onClick={() => run('act', () => api.post(`/api/platform/companies/${company.id}/activate`), t('admin.activated'))}><PlayCircle size={16} aria-hidden />{t('admin.activate')}</Button>}
          {company.status === 'suspended' && <Button variant="primary" loading={busy === 'react'} onClick={() => run('react', () => api.post(`/api/platform/companies/${company.id}/reactivate`), t('admin.reactivated'))}><PlayCircle size={16} aria-hidden />{t('admin.reactivate')}</Button>}
          {company.status !== 'suspended' && <Button variant="danger" onClick={() => setModal({ type: 'suspend' })}><PauseCircle size={16} aria-hidden />{t('admin.suspend')}</Button>}
        </>} />
      {company.status === 'suspended' && <div className="banner banner-danger">{t('admin.suspendedNotice', { date: fmtDate(company.suspendedAt, locale), reason: company.suspensionReason || '—' })}</div>}

      <div className="tabs" role="tablist">
        {['subscription', 'profile', 'members', 'activity'].map(x => (
          <button key={x} role="tab" type="button" aria-selected={x === tab} className={`tab ${x === tab ? 'active' : ''}`} onClick={() => setParams({ tab: x })}>{t(`admin.tabs.${x}`)}</button>
        ))}
      </div>

      {tab === 'subscription' && (
        <div className="stack">
          <SubscriptionCard key={JSON.stringify(subscription)} companyId={company.id} sub={subscription} plans={plans.data.plans} currencies={plans.data.currencies} onChanged={detail.reload} />
          <Card title={t('billing.payments')}>
            {!payments.length ? <EmptyState icon={Receipt}>{t('billing.noPayments')}</EmptyState> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>{t('billing.paidAt')}</th><th>{t('billing.amount')}</th><th>{t('billing.method')}</th><th>{t('billing.reference')}</th><th>{t('billing.coveredPeriod')}</th></tr></thead>
                  <tbody>{payments.map(p => (
                    <tr key={p.id}><td>{fmtDate(p.paidAt, locale)}</td><td dir="ltr">{fmtMoney(p.amount, p.currency, locale)}</td><td>{t(`paymentMethods.${p.method}`)}</td>
                      <td className="small" dir="ltr">{p.reference || '—'}{p.notes && <div className="muted">{p.notes}</div>}</td>
                      <td className="small">{p.periodEnd ? `${fmtDate(p.periodStart, locale)} → ${fmtDate(p.periodEnd, locale)}` : '—'}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
      {tab === 'profile' && <ProfileCard company={company} onSaved={detail.reload} />}
      {tab === 'members' && (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('team.name')}</th><th>{t('team.role')}</th><th>{t('common.status')}</th><th>{t('team.lastLogin')}</th><th className="actions-col"><span className="sr-only">{t('common.actions')}</span></th></tr></thead>
              <tbody>{members.map(m => (
                <tr key={m.id}>
                  <td><strong>{m.name}</strong>{m.invitationPending && <Badge tone="warning">{t('team.invitationPending')}</Badge>}<div className="muted small" dir="ltr">{m.email}</div></td>
                  <td>{roleLabel(t, m)}</td>
                  <td><Badge tone={m.status === 'active' ? 'success' : 'neutral'}>{t(`common.${m.status}`)}</Badge></td>
                  <td className="small">{m.lastLoginAt ? fmtDate(m.lastLoginAt, locale, { dateStyle: 'medium', timeStyle: 'short' }) : t('common.never')}</td>
                  <td className="actions-col">
                    {m.accountStatus !== 'disabled' && (
                      <Button size="sm" variant="ghost" loading={busy === `m-${m.id}`} onClick={async () => {
                        const r = await run(`m-${m.id}`, () => api.post(`/api/platform/companies/${company.id}/members/${m.id}/link`));
                        if (r) setModal({ type: 'link', result: r });
                      }}><Link2 size={14} aria-hidden />{m.invitationPending ? t('team.resendInvite') : t('team.sendResetLink')}</Button>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
      {tab === 'activity' && (
        <Card>
          {!activity.length ? <EmptyState>{t('audit.empty')}</EmptyState> : (
            <ul className="simple-list">
              {activity.map(a => <li key={a.id}><span>{t(`audit.actions.${a.action}`, { defaultValue: a.action })}</span><small className="muted" dir="ltr">{a.actor_email || t('audit.system')}</small><small className="muted">{fmtDate(a.created_at, locale, { dateStyle: 'medium', timeStyle: 'short' })}</small></li>)}
            </ul>
          )}
        </Card>
      )}

      {modal?.type === 'suspend' && <SuspendModal company={company} onClose={() => setModal(null)} onDone={detail.reload} />}
      {modal?.type === 'link' && <LinkDialog result={modal.result} title={modal.result.purpose === 'invite' ? t('admin.ownerInvitation') : t('admin.ownerResetLink')} onClose={() => setModal(null)} />}
    </>
  );
}
