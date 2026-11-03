import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Layers, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/i18n';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, Modal, PageHeader, Spinner, fieldError, fmtMoney, localized, useLoader, useToast } from '../../components/ui';

function PlanModal({ plan, features, currencies, onClose, onSaved }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({
    nameEn: plan?.name?.en || '', nameAr: plan?.name?.ar || '', descEn: plan?.description?.en || '', descAr: plan?.description?.ar || '',
    interval: plan?.interval || 'month', durationDays: plan?.durationDays || '', price: plan?.price ?? '', currency: plan?.currency || 'USD',
    trialDays: plan?.trialDays ?? 0, maxEmployees: plan?.maxEmployees ?? '', maxChannels: plan?.maxChannels ?? '',
    features: new Set(plan?.features || []), isActive: plan?.isActive ?? true, isPublic: plan?.isPublic ?? true, sort: plan?.sort ?? 0
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = k => e => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const toggle = key => setF(x => { const s = new Set(x.features); s.has(key) ? s.delete(key) : s.add(key); return { ...x, features: s }; });

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const body = {
      name: { en: f.nameEn, ar: f.nameAr }, description: { en: f.descEn, ar: f.descAr }, interval: f.interval,
      durationDays: f.interval === 'custom' ? Number(f.durationDays) : null, price: Number(f.price || 0), currency: f.currency,
      trialDays: Number(f.trialDays || 0), maxEmployees: f.maxEmployees === '' ? null : Number(f.maxEmployees),
      maxChannels: f.maxChannels === '' ? null : Number(f.maxChannels), features: [...f.features], isActive: f.isActive, isPublic: f.isPublic, sort: Number(f.sort || 0)
    };
    try {
      if (plan) await api.patch(`/api/platform/plans/${plan.id}`, body); else await api.post('/api/platform/plans', body);
      toast.success(t('common.saved'));
      onSaved();
    } catch (err) { setError(err); toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }

  return (
    <Modal size="lg" title={plan ? t('plans.edit') : t('plans.create')} onClose={onClose}
      footer={<><Button onClick={onClose}>{t('common.cancel')}</Button><Button variant="primary" type="submit" form="plan-form" loading={busy}>{t('common.save')}</Button></>}>
      <form id="plan-form" onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label={`${t('plans.name')} · ${t('platform.inEnglish')}`} error={fieldError(t, error, 'name')}>{id => <input id={id} dir="ltr" maxLength={60} value={f.nameEn} onChange={set('nameEn')} />}</Field>
          <Field label={`${t('plans.name')} · ${t('platform.inArabic')}`}>{id => <input id={id} dir="rtl" maxLength={60} value={f.nameAr} onChange={set('nameAr')} />}</Field>
          <Field label={`${t('roles.description')} · ${t('platform.inEnglish')}`}>{id => <textarea id={id} dir="ltr" rows={2} value={f.descEn} onChange={set('descEn')} />}</Field>
          <Field label={`${t('roles.description')} · ${t('platform.inArabic')}`}>{id => <textarea id={id} dir="rtl" rows={2} value={f.descAr} onChange={set('descAr')} />}</Field>
        </div>
        <div className="form-grid three">
          <Field label={t('plans.interval')}>{id => <select id={id} value={f.interval} onChange={set('interval')}>{['month', 'year', 'custom'].map(i => <option key={i} value={i}>{t(`plans.intervals.${i}`)}</option>)}</select>}</Field>
          {f.interval === 'custom' && <Field label={t('plans.durationDays')} error={fieldError(t, error, 'durationDays')}>{id => <input id={id} type="number" min="1" value={f.durationDays} onChange={set('durationDays')} />}</Field>}
          <Field label={t('billing.price')} error={fieldError(t, error, 'price')}>{id => <input id={id} type="number" min="0" step="0.01" dir="ltr" value={f.price} onChange={set('price')} />}</Field>
          <Field label={t('company.currency')}>{id => <select id={id} dir="ltr" value={f.currency} onChange={set('currency')}>{currencies.map(c => <option key={c}>{c}</option>)}</select>}</Field>
          <Field label={t('plans.trialDays')}>{id => <input id={id} type="number" min="0" value={f.trialDays} onChange={set('trialDays')} />}</Field>
          <Field label={t('plans.maxEmployees')} hint={t('plans.emptyUnlimited')} error={fieldError(t, error, 'maxEmployees')}>{id => <input id={id} type="number" min="1" value={f.maxEmployees} onChange={set('maxEmployees')} />}</Field>
          <Field label={t('plans.maxChannels')} hint={t('plans.emptyUnlimited')}>{id => <input id={id} type="number" min="0" value={f.maxChannels} onChange={set('maxChannels')} />}</Field>
        </div>
        <fieldset className="perm-group">
          <legend>{t('plans.features')}</legend>
          {features.map(k => <label key={k} className="check"><input type="checkbox" checked={f.features.has(k)} onChange={() => toggle(k)} /><span>{t(`planFeatures.${k}`)}</span></label>)}
          <small className="hint">{t('plans.featuresHint')}</small>
        </fieldset>
        <div className="row wrap gap">
          <label className="check"><input type="checkbox" checked={f.isActive} onChange={set('isActive')} /><span>{t('plans.active')}</span></label>
          <label className="check"><input type="checkbox" checked={f.isPublic} onChange={set('isPublic')} /><span>{t('plans.public')}</span></label>
        </div>
        {plan && <p className="hint">{t('plans.editHint')}</p>}
      </form>
    </Modal>
  );
}

export default function AdminPlans() {
  const { t } = useTranslation();
  const { locale } = useApp();
  const toast = useToast();
  const { data, loading, error, reload } = useLoader(() => api.get('/api/platform/plans'), []);
  const [modal, setModal] = useState(null);

  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const hasTemplates = ['basic', 'pro', 'business'].every(k => data.plans.some(p => p.key === k));

  return (
    <>
      <PageHeader title={t('plans.title')} subtitle={t('plans.subtitle')} actions={<>
        {!hasTemplates && <Button onClick={async () => { try { const r = await api.post('/api/platform/plans/templates'); toast.success(t('plans.templatesCreated', { count: r.created.length })); reload(); } catch (e) { toast.error(errorMessage(t, e)); } }}><Sparkles size={16} aria-hidden />{t('plans.addTemplates')}</Button>}
        <Button variant="primary" onClick={() => setModal({ type: 'edit' })}><Plus size={16} aria-hidden />{t('plans.create')}</Button>
      </>} />
      {data.plans.length === 0 ? <div className="card"><EmptyState icon={Layers} title={t('plans.emptyTitle')}>{t('plans.emptyBody')}</EmptyState></div> : (
        <div className="plan-grid">
          {data.plans.map(p => (
            <article key={p.id} className={`plan-card ${p.isActive ? '' : 'inactive'}`}>
              <header>
                <div>
                  <h2>{localized(p.name, locale)}</h2>
                  <div className="row wrap">
                    <Badge tone={p.isActive ? 'success' : 'neutral'}>{p.isActive ? t('plans.activeShort') : t('plans.inactive')}</Badge>
                    {!p.isPublic && <Badge>{t('plans.private')}</Badge>}
                  </div>
                </div>
                <div className="row">
                  <IconButton label={t('common.edit')} onClick={() => setModal({ type: 'edit', plan: p })}><Pencil size={16} /></IconButton>
                  {p.companies === 0 && <IconButton label={t('common.delete')} onClick={() => setModal({ type: 'delete', plan: p })}><Trash2 size={16} /></IconButton>}
                </div>
              </header>
              <p className="plan-price-lg" dir="ltr">{fmtMoney(p.price, p.currency, locale)}<small> / {t(`plans.per.${p.interval}`, { days: p.durationDays })}</small></p>
              {localized(p.description, locale) && <p className="muted">{localized(p.description, locale)}</p>}
              <ul className="plan-limits">
                <li><Check size={14} aria-hidden />{p.maxEmployees ? t('plans.seats', { count: p.maxEmployees }) : t('plans.unlimitedSeats')}</li>
                <li><Check size={14} aria-hidden />{p.maxChannels === null ? t('plans.unlimitedChannels') : t('plans.channels', { count: p.maxChannels })}</li>
                {p.trialDays > 0 && <li><Check size={14} aria-hidden />{t('plans.trial', { count: p.trialDays })}</li>}
                {p.features.map(k => <li key={k}><Check size={14} aria-hidden />{t(`planFeatures.${k}`)}</li>)}
              </ul>
              <footer className="muted small">{t('plans.usedBy', { count: p.companies })}</footer>
            </article>
          ))}
        </div>
      )}
      {modal?.type === 'edit' && <PlanModal plan={modal.plan} features={data.features} currencies={data.currencies} onClose={() => setModal(null)} onSaved={() => { setModal(null); reload(); }} />}
      {modal?.type === 'delete' && <ConfirmDialog danger title={t('plans.deleteTitle', { name: localized(modal.plan.name, locale) })} body={t('roles.deleteBody')} confirmLabel={t('common.delete')}
        onClose={() => setModal(null)} onConfirm={async () => { await api.del(`/api/platform/plans/${modal.plan.id}`); reload(); }} />}
    </>
  );
}
