import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { errorMessage } from '../lib/i18n';
import { BrandMark } from '../components/Layout';
import { Button, Card, ColorInput, ErrorState, Field, IconButton, ImageUpload, PageHeader, Spinner, fieldError, useLoader, useToast } from '../components/ui';
import { TIMEZONES } from '../components/ui';


function useSave(onDone) {
  const { t } = useTranslation();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async fn => {
    setBusy(true); setError(null);
    try { const r = await fn(); toast.success(t('common.saved')); onDone?.(r); }
    catch (err) { setError(err); toast.error(errorMessage(t, err)); }
    finally { setBusy(false); }
  };
  return { busy, error, run };
}

function ProfileTab({ data, canEdit, onSaved }) {
  const { t } = useTranslation();
  const p = data.profile;
  const [form, setForm] = useState({ name: p.name || '', email: p.email || '', phone: p.phone || '', country: p.country || '', address: p.address || '', businessType: p.businessType || '' });
  const { busy, error, run } = useSave(onSaved);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <Card actions={canEdit && <Button variant="primary" loading={busy} onClick={() => run(() => api.patch('/api/company', form))}>{t('common.save')}</Button>}>
      <fieldset className="form-grid" disabled={!canEdit}>
        <Field label={t('company.name')} error={fieldError(t, error, 'name')} full>{id => <input id={id} maxLength={120} value={form.name} onChange={set('name')} />}</Field>
        <Field label={t('company.email')} error={fieldError(t, error, 'email')}>{id => <input id={id} type="email" dir="ltr" value={form.email} onChange={set('email')} />}</Field>
        <Field label={t('company.phone')}>{id => <input id={id} type="tel" dir="ltr" value={form.phone} onChange={set('phone')} />}</Field>
        <Field label={t('company.country')}>{id => <input id={id} maxLength={80} value={form.country} onChange={set('country')} />}</Field>
        <Field label={t('company.businessType')}>{id => <input id={id} maxLength={120} value={form.businessType} onChange={set('businessType')} />}</Field>
        <Field label={t('company.address')} full>{id => <textarea id={id} rows={2} maxLength={300} value={form.address} onChange={set('address')} />}</Field>
      </fieldset>
    </Card>
  );
}

function RegionalTab({ data, canEdit, onSaved }) {
  const { t } = useTranslation();
  const p = data.profile;
  const [form, setForm] = useState({ timezone: p.timezone, currency: p.currency, defaultLocale: p.defaultLocale });
  const { busy, error, run } = useSave(onSaved);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <Card actions={canEdit && <Button variant="primary" loading={busy} onClick={() => run(() => api.patch('/api/company', form))}>{t('common.save')}</Button>}>
      <fieldset className="form-grid" disabled={!canEdit}>
        <Field label={t('company.timezone')} hint={t('company.timezoneHint')} error={fieldError(t, error, 'timezone')}>
          {id => <select id={id} dir="ltr" value={form.timezone} onChange={set('timezone')}>{TIMEZONES.map(z => <option key={z}>{z}</option>)}</select>}
        </Field>
        <Field label={t('company.currency')}>
          {id => <select id={id} dir="ltr" value={form.currency} onChange={set('currency')}>{data.currencies.map(c => <option key={c}>{c}</option>)}</select>}
        </Field>
        <Field label={t('company.defaultLocale')}>
          {id => (
            <select id={id} value={form.defaultLocale} onChange={set('defaultLocale')}>
              <option value="ar">{t('common.arabic')}</option>
              <option value="en">{t('common.english')}</option>
            </select>
          )}
        </Field>
      </fieldset>
    </Card>
  );
}

function SalesTab({ data, canEdit, onSaved }) {
  const { t } = useTranslation();
  const s = data.settings;
  const [form, setForm] = useState({ taxRate: s.taxRate, shippingFee: s.shippingFee, autoReplyEnabled: s.autoReplyEnabled, quickReplies: s.quickReplies.length ? s.quickReplies : [''] });
  const { busy, error, run } = useSave(onSaved);
  const setReply = (i, value) => setForm(f => ({ ...f, quickReplies: f.quickReplies.map((q, j) => (j === i ? value : q)) }));
  return (
    <Card actions={canEdit && <Button variant="primary" loading={busy} onClick={() => run(() => api.patch('/api/company', { ...form, taxRate: Number(form.taxRate), shippingFee: Number(form.shippingFee) }))}>{t('common.save')}</Button>}>
      <fieldset className="form-grid" disabled={!canEdit}>
        <Field label={t('company.taxRate')} error={fieldError(t, error, 'taxRate')}>{id => <input id={id} type="number" min="0" max="100" step="0.01" dir="ltr" value={form.taxRate} onChange={e => setForm(f => ({ ...f, taxRate: e.target.value }))} />}</Field>
        <Field label={`${t('company.shippingFee')} (${data.profile.currency})`} error={fieldError(t, error, 'shippingFee')}>{id => <input id={id} type="number" min="0" step="0.01" dir="ltr" value={form.shippingFee} onChange={e => setForm(f => ({ ...f, shippingFee: e.target.value }))} />}</Field>
        <label className="check full">
          <input type="checkbox" checked={form.autoReplyEnabled} onChange={e => setForm(f => ({ ...f, autoReplyEnabled: e.target.checked }))} />
          <span><strong>{t('company.autoReply')}</strong><small className="hint">{t('company.autoReplyHint')}</small></span>
        </label>
        <div className="field full">
          <span className="label">{t('company.quickReplies')}</span>
          <small className="hint">{t('company.quickRepliesHint')}</small>
          <div className="stack">
            {form.quickReplies.map((q, i) => (
              <div key={i} className="row">
                <textarea rows={2} maxLength={1000} value={q} aria-label={`${t('company.quickReplies')} ${i + 1}`} onChange={e => setReply(i, e.target.value)} />
                <IconButton label={t('common.remove')} onClick={() => setForm(f => ({ ...f, quickReplies: f.quickReplies.filter((_, j) => j !== i) }))}><Trash2 size={16} /></IconButton>
              </div>
            ))}
            <Button size="sm" type="button" onClick={() => setForm(f => ({ ...f, quickReplies: [...f.quickReplies, ''] }))}><Plus size={14} aria-hidden />{t('company.addQuickReply')}</Button>
          </div>
        </div>
      </fieldset>
    </Card>
  );
}

function BrandingTab({ data, canEdit, onSaved }) {
  const { t } = useTranslation();
  const { platform, reloadMe } = useApp();
  const b = data.branding;
  const [form, setForm] = useState({ displayName: b.displayName || '', logoUrl: b.logoUrl || '', primaryColor: b.primaryColor || '', secondaryColor: b.secondaryColor || '', accentColor: b.accentColor || '' });
  const { busy, error, run } = useSave(async r => { await reloadMe(); onSaved(r); });
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  const payload = () => Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v === '' ? null : v]));
  const primary = form.primaryColor || platform.primaryColor;
  return (
    <div className="grid-2 wide-first">
      <Card actions={canEdit && <Button variant="primary" loading={busy} onClick={() => run(() => api.patch('/api/company/branding', payload()))}>{t('common.save')}</Button>}>
        <p className="muted">{t('company.brandingHint')}</p>
        <fieldset className="form-grid" disabled={!canEdit}>
          <Field label={t('company.displayName')} hint={t('company.displayNameHint')} full>{id => <input id={id} maxLength={120} value={form.displayName} placeholder={data.profile.name} onChange={e => set('displayName')(e.target.value)} />}</Field>
          <div className="field full">
            <span className="label">{t('company.logo')}</span>
            <ImageUpload url={form.logoUrl} square onUpload={async file => { const r = await api.upload('/api/company/branding/logo', file); set('logoUrl')(r.url); await reloadMe(); }} onRemove={() => set('logoUrl')('')} />
          </div>
          {['primaryColor', 'secondaryColor', 'accentColor'].map(k => (
            <Field key={k} label={t(`company.${k}`)} error={fieldError(t, error, k)}>
              {() => <ColorInput value={form[k]} placeholder={platform[k]} allowEmpty emptyLabel={t('company.useDefault')} onChange={set(k)} />}
            </Field>
          ))}
        </fieldset>
      </Card>
      <Card title={t('company.preview')}>
        <div className="brand-preview" style={{ '--p': primary }}>
          <BrandMark logoUrl={form.logoUrl} name={form.displayName || data.profile.name} size={44} />
          <strong>{form.displayName || data.profile.name}</strong>
          <span className="preview-btn" style={{ background: primary }}>{t('common.save')}</span>
          <span className="preview-chip" style={{ borderColor: form.accentColor || platform.accentColor, color: form.accentColor || platform.accentColor }}>{t('common.active')}</span>
        </div>
      </Card>
    </div>
  );
}

const TABS = ['profile', 'regional', 'sales', 'branding'];

export default function CompanySettings() {
  const { t } = useTranslation();
  const { can } = useApp();
  const [params, setParams] = useSearchParams();
  const canView = can('company.settings.view') || can('company.settings.manage');
  const canEdit = can('company.settings.manage');
  const canBrand = can('company.branding.manage');
  const tabs = useMemo(() => TABS.filter(tab => (tab === 'branding' ? canBrand : canView)), [canBrand, canView]);
  const tab = tabs.includes(params.get('tab')) ? params.get('tab') : tabs[0];
  const { data, loading, error, reload, setData } = useLoader(() => api.get('/api/company'), []);
  useEffect(() => { if (params.get('tab') && !tabs.includes(params.get('tab'))) setParams({}); }, [params, tabs, setParams]);

  return (
    <>
      <PageHeader title={t('company.title')} subtitle={t('company.subtitle')} />
      <div className="tabs" role="tablist">
        {tabs.map(x => (
          <button key={x} role="tab" type="button" aria-selected={x === tab} className={`tab ${x === tab ? 'active' : ''}`} onClick={() => setParams({ tab: x })}>{t(`company.tabs.${x}`)}</button>
        ))}
      </div>
      {loading ? <Spinner /> : error ? <ErrorState error={error} onRetry={reload} /> : (
        <div role="tabpanel" key={tab}>
          {tab === 'profile' && <ProfileTab data={data} canEdit={canEdit} onSaved={setData} />}
          {tab === 'regional' && <RegionalTab data={data} canEdit={canEdit} onSaved={setData} />}
          {tab === 'sales' && <SalesTab data={data} canEdit={canEdit} onSaved={setData} />}
          {tab === 'branding' && <BrandingTab data={data} canEdit={canBrand} onSaved={setData} />}
        </div>
      )}
    </>
  );
}
