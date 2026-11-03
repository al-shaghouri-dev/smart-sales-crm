import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/i18n';
import { Badge, Button, EmptyState, ErrorState, Field, LinkDialog, Modal, PageHeader, Spinner, fmtDate, localized, useLoader, useToast } from '../../components/ui';
import { TIMEZONES } from '../../components/ui';

const TONES = { pending: 'warning', info_requested: 'primary', approved: 'success', rejected: 'neutral' };

function ReviewModal({ request: r, plans, onClose, onDone }) {
  const { t } = useTranslation();
  const { locale } = useApp();
  const toast = useToast();
  const [action, setAction] = useState('approve');
  const [f, setF] = useState({ planId: r.planId || '', periods: 1, trial: false, timezone: 'UTC', status: 'active', message: '', internalNote: r.internalNote || '' });
  const [busy, setBusy] = useState(false);
  const open = ['pending', 'info_requested'].includes(r.status);
  const plan = plans.find(p => p.id === f.planId);

  async function submit() {
    setBusy(true);
    try {
      let res;
      if (action === 'approve') {
        res = await api.post(`/api/platform/registrations/${r.id}/approve`, {
          timezone: f.timezone, status: f.status, internalNote: f.internalNote,
          subscription: f.planId ? { planId: f.planId, periods: Number(f.periods) || 1, trial: f.trial } : undefined
        });
        toast.success(t('admin.registrationApproved'));
      } else {
        res = await api.post(`/api/platform/registrations/${r.id}/${action === 'reject' ? 'reject' : 'request-info'}`, { message: f.message });
        toast.success(action === 'reject' ? t('admin.registrationRejected') : t('admin.infoRequested'));
      }
      onDone(action, res);
    } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }

  return (
    <Modal size="lg" title={r.companyName} onClose={onClose}
      footer={open ? <><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant={action === 'reject' ? 'danger' : 'primary'} loading={busy}
        disabled={action !== 'approve' && !f.message.trim()} onClick={submit}>{t(`admin.reviewAction.${action}`)}</Button></> : null}>
      <dl className="facts">
        <div><dt>{t('register.owner')}</dt><dd>{r.ownerName} · <span dir="ltr">{r.ownerEmail}</span> · <span dir="ltr">{r.ownerPhone}</span></dd></div>
        <div><dt>{t('company.businessType')}</dt><dd>{r.businessType || '—'}</dd></div>
        <div><dt>{t('company.country')}</dt><dd>{r.country || '—'}</dd></div>
        <div><dt>{t('register.plan')}</dt><dd>{r.planName ? localized(r.planName, locale) : '—'}</dd></div>
        <div><dt>{t('common.language')}</dt><dd>{r.locale === 'ar' ? t('common.arabic') : t('common.english')}</dd></div>
        <div><dt>{t('admin.submitted')}</dt><dd>{fmtDate(r.createdAt, locale, { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>
        {r.messageToApplicant && <div><dt>{t('admin.lastMessage')}</dt><dd>{r.messageToApplicant}</dd></div>}
      </dl>
      {open && (
        <>
          <div className="segmented" role="radiogroup">
            {['approve', 'info', 'reject'].map(a => <label key={a} className={action === a ? 'active' : ''}><input type="radio" checked={action === a} onChange={() => setAction(a)} />{t(`admin.reviewTab.${a}`)}</label>)}
          </div>
          {action === 'approve' ? (
            <div className="form-grid">
              <Field label={t('billing.plan')}>{id => <select id={id} value={f.planId} onChange={e => setF(x => ({ ...x, planId: e.target.value }))}><option value="">{t('admin.noPlanYet')}</option>{plans.map(p => <option key={p.id} value={p.id}>{localized(p.name, locale)}</option>)}</select>}</Field>
              {plan && <Field label={t('admin.periods', { unit: t(`plans.unit.${plan.interval}`) })}>{id => <input id={id} type="number" min="1" max="120" value={f.periods} onChange={e => setF(x => ({ ...x, periods: e.target.value }))} />}</Field>}
              <Field label={t('company.timezone')}>{id => <select id={id} dir="ltr" value={f.timezone} onChange={e => setF(x => ({ ...x, timezone: e.target.value }))}>{TIMEZONES.map(z => <option key={z}>{z}</option>)}</select>}</Field>
              <Field label={t('admin.companyStatusAfter')}>{id => <select id={id} value={f.status} onChange={e => setF(x => ({ ...x, status: e.target.value }))}><option value="active">{t('platform.status.active')}</option><option value="pending">{t('platform.status.pending')}</option></select>}</Field>
              {plan?.trialDays > 0 && <label className="check full"><input type="checkbox" checked={f.trial} onChange={e => setF(x => ({ ...x, trial: e.target.checked }))} /><span>{t('admin.startTrial', { count: plan.trialDays })}</span></label>}
              <Field label={t('admin.internalNotes')} full>{id => <textarea id={id} rows={2} value={f.internalNote} onChange={e => setF(x => ({ ...x, internalNote: e.target.value }))} />}</Field>
              <p className="hint full">{t('admin.approveHint')}</p>
            </div>
          ) : (
            <Field label={action === 'reject' ? t('admin.rejectMessage') : t('admin.infoMessage')} hint={t('admin.messageHint')}>
              {id => <textarea id={id} rows={3} maxLength={1000} value={f.message} onChange={e => setF(x => ({ ...x, message: e.target.value }))} />}
            </Field>
          )}
        </>
      )}
    </Modal>
  );
}

export default function AdminRegistrations() {
  const { t } = useTranslation();
  const { locale } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'pending';
  const list = useLoader(() => api.get(`/api/platform/registrations${status === 'all' ? '' : `?status=${status}`}`).then(r => r.requests), [status]);
  const plans = useLoader(() => api.get('/api/platform/plans').then(r => r.plans), []);
  const [selected, setSelected] = useState(null);
  const [invitation, setInvitation] = useState(null);

  return (
    <>
      <PageHeader title={t('admin.registrationsTitle')} subtitle={t('admin.registrationsSubtitle')} />
      <div className="tabs" role="tablist">
        {['pending', 'info_requested', 'approved', 'rejected', 'all'].map(s => (
          <button key={s} role="tab" type="button" aria-selected={s === status} className={`tab ${s === status ? 'active' : ''}`} onClick={() => setParams({ status: s })}>{t(`registrationStatus.${s}`)}</button>
        ))}
      </div>
      <div className="card">
        {list.loading ? <Spinner /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.data.length === 0 ? <EmptyState icon={Inbox}>{t('admin.noRegistrations')}</EmptyState> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('platform.company')}</th><th>{t('register.owner')}</th><th>{t('register.plan')}</th><th>{t('common.status')}</th><th>{t('admin.submitted')}</th></tr></thead>
              <tbody>
                {list.data.map(r => (
                  <tr key={r.id} className="row-link" onClick={() => setSelected(r)}>
                    <td><button type="button" className="link-btn" onClick={e => { e.stopPropagation(); setSelected(r); }}><strong>{r.companyName}</strong></button><div className="muted small">{r.businessType || ''}</div></td>
                    <td>{r.ownerName}<div className="muted small" dir="ltr">{r.ownerEmail}</div></td>
                    <td>{r.planName ? localized(r.planName, locale) : '—'}</td>
                    <td><Badge tone={TONES[r.status]}>{t(`registrationStatus.${r.status}`)}</Badge></td>
                    <td className="small">{fmtDate(r.createdAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selected && plans.data && <ReviewModal request={selected} plans={plans.data} onClose={() => setSelected(null)}
        onDone={(action, res) => { setSelected(null); list.reload(); if (action === 'approve') setInvitation({ ...(res.invitation || { emailSent: false }), companyId: res.companyId }); }} />}
      {invitation && <LinkDialog result={invitation} title={t('admin.ownerInvitation')} onClose={() => { const id = invitation.companyId; setInvitation(null); navigate(`/admin/companies/${id}`); }} />}
    </>
  );
}
