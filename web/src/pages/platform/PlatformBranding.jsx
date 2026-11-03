import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useApp } from '../../context/AppContext';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/i18n';
import { BrandMark } from '../../components/Layout';
import { Button, Card, ColorInput, ErrorState, Field, ImageUpload, PageHeader, Spinner, fieldError, useLoader, useToast } from '../../components/ui';

const FONTS = ['Cairo', 'Inter', 'IBM Plex Sans Arabic', 'Tajawal', 'Noto Sans Arabic', 'system-ui'];
const LOCALIZED = ['tagline', 'loginHeading', 'loginSubheading', 'registrationHeading', 'registrationSubheading'];

function LocalizedInputs({ label, value, onChange, multiline, error }) {
  const { t } = useTranslation();
  const Tag = multiline ? 'textarea' : 'input';
  return (
    <div className="field full">
      <span className="label">{label}</span>
      <div className="form-grid tight">
        <Field label={t('platform.inArabic')}>{id => <Tag id={id} dir="rtl" lang="ar" rows={multiline ? 2 : undefined} value={value?.ar || ''} onChange={e => onChange({ ...value, ar: e.target.value })} />}</Field>
        <Field label={t('platform.inEnglish')}>{id => <Tag id={id} dir="ltr" lang="en" rows={multiline ? 2 : undefined} value={value?.en || ''} onChange={e => onChange({ ...value, en: e.target.value })} />}</Field>
      </div>
      {error && <small className="field-error">{error}</small>}
    </div>
  );
}

function Editor({ initial }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { setPlatform, locale } = useApp();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = k => v => setForm(f => ({ ...f, [k]: v }));
  const setE = k => e => set(k)(e.target.value);

  async function save() {
    setBusy(true); setError(null);
    try {
      const body = { ...form };
      for (const k of ['logoUrl', 'faviconUrl', 'websiteUrl', 'supportEmail', 'supportPhone']) if (body[k] === '') body[k] = null;
      const saved = await api.patch('/api/platform/settings', body);
      setPlatform(saved);
      setForm(saved);
      toast.success(t('common.saved'));
    } catch (err) { setError(err); toast.error(errorMessage(t, err)); } finally { setBusy(false); }
  }

  async function upload(asset, file) {
    const r = await api.upload(`/api/platform/branding/${asset}`, file);
    const key = asset === 'logo' ? 'logoUrl' : 'faviconUrl';
    set(key)(r.url);
    setPlatform(p => ({ ...p, [key]: r.url }));
  }

  const heading = form.loginHeading?.[locale] || t('auth.defaultHeading');
  return (
    <>
      <PageHeader title={t('platform.brandingTitle')} subtitle={t('platform.brandingSubtitle')} actions={<Button variant="primary" loading={busy} onClick={save}>{t('common.save')}</Button>} />
      <div className="grid-2 wide-first">
        <div className="stack">
          <Card title={t('platform.identity')}>
            <div className="form-grid">
              <Field label={t('platform.appName')} error={fieldError(t, error, 'appName')} full>{id => <input id={id} maxLength={60} value={form.appName} onChange={setE('appName')} />}</Field>
              <LocalizedInputs label={t('platform.tagline')} value={form.tagline} onChange={set('tagline')} />
              <div className="field"><span className="label">{t('platform.logo')}</span><ImageUpload url={form.logoUrl} square onUpload={f => upload('logo', f)} onRemove={() => set('logoUrl')('')} /></div>
              <div className="field"><span className="label">{t('platform.favicon')}</span><ImageUpload url={form.faviconUrl} square accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/gif" onUpload={f => upload('favicon', f)} onRemove={() => set('faviconUrl')('')} /></div>
            </div>
          </Card>
          <Card title={t('platform.colors')}>
            <div className="form-grid three">
              {['primaryColor', 'secondaryColor', 'accentColor'].map(k => (
                <Field key={k} label={t(`company.${k}`)} error={fieldError(t, error, k)}>{() => <ColorInput value={form[k]} onChange={set(k)} />}</Field>
              ))}
            </div>
          </Card>
          <Card title={t('platform.typography')}>
            <div className="form-grid three">
              <Field label={t('platform.font')}>{id => <select id={id} value={form.fontFamily} onChange={setE('fontFamily')}>{FONTS.map(f => <option key={f}>{f}</option>)}</select>}</Field>
              <Field label={t('platform.defaultTheme')}>{id => (
                <select id={id} value={form.defaultTheme} onChange={setE('defaultTheme')}>
                  {['system', 'light', 'dark'].map(x => <option key={x} value={x}>{t(`common.${x}`)}</option>)}
                </select>
              )}</Field>
              <Field label={t('platform.defaultLocale')}>{id => (
                <select id={id} value={form.defaultLocale} onChange={setE('defaultLocale')}>
                  <option value="ar">{t('common.arabic')}</option><option value="en">{t('common.english')}</option>
                </select>
              )}</Field>
            </div>
          </Card>
          <Card title={t('platform.loginPage')}>
            <LocalizedInputs label={t('platform.heading')} value={form.loginHeading} onChange={set('loginHeading')} />
            <LocalizedInputs label={t('platform.subheading')} value={form.loginSubheading} onChange={set('loginSubheading')} multiline />
          </Card>
          <Card title={t('platform.registrationPage')}>
            <LocalizedInputs label={t('platform.heading')} value={form.registrationHeading} onChange={set('registrationHeading')} />
            <LocalizedInputs label={t('platform.subheading')} value={form.registrationSubheading} onChange={set('registrationSubheading')} multiline />
          </Card>
          <Card title={t('platform.policies')}>
            <fieldset className="stack">
              <legend className="label">{t('platform.expiredPolicy')}</legend>
              {['read_only', 'block'].map(p => (
                <label key={p} className="check">
                  <input type="radio" name="expiredPolicy" checked={form.expiredAccessPolicy === p} onChange={() => set('expiredAccessPolicy')(p)} />
                  <span><strong>{t(`platform.policy.${p}`)}</strong><small className="hint">{t(`platform.policyHint.${p}`)}</small></span>
                </label>
              ))}
              <small className="hint">{t('admin.dataPreserved')}</small>
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={Boolean(form.registrationEnabled)} onChange={e => set('registrationEnabled')(e.target.checked)} />
              <span><strong>{t('platform.registrationEnabled')}</strong><small className="hint">{t('platform.registrationEnabledHint')}</small></span>
            </label>
          </Card>
          <Card title={t('platform.contact')}>
            <div className="form-grid">
              <Field label={t('platform.supportEmail')} error={fieldError(t, error, 'supportEmail')}>{id => <input id={id} type="email" dir="ltr" value={form.supportEmail || ''} onChange={setE('supportEmail')} />}</Field>
              <Field label={t('platform.supportPhone')}>{id => <input id={id} type="tel" dir="ltr" value={form.supportPhone || ''} onChange={setE('supportPhone')} />}</Field>
              <Field label={t('platform.websiteUrl')} error={fieldError(t, error, 'websiteUrl')} full>{id => <input id={id} type="url" dir="ltr" placeholder="https://" value={form.websiteUrl || ''} onChange={setE('websiteUrl')} />}</Field>
            </div>
          </Card>
        </div>
        <Card title={t('company.preview')} className="sticky">
          <div className="login-preview" style={{ '--p': form.primaryColor, '--s': form.secondaryColor }}>
            <div className="login-preview-brand">
              <BrandMark logoUrl={form.logoUrl} name={form.appName} size={32} />
              <strong>{form.appName}</strong>
            </div>
            <p className="login-preview-heading">{heading}</p>
            <span className="preview-btn" style={{ background: form.primaryColor }}>{t('auth.signIn')}</span>
          </div>
        </Card>
      </div>
    </>
  );
}

export default function PlatformBranding() {
  const { data, loading, error, reload } = useLoader(() => api.get('/api/platform/settings'), []);
  if (loading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  for (const k of LOCALIZED) data[k] = data[k] || {};
  return <Editor initial={data} />;
}
