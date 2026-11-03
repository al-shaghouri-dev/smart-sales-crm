import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { errorMessage } from '../lib/i18n';

export function Button({ variant = 'secondary', size, loading, children, className = '', ...props }) {
  return (
    <button className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className}`} disabled={loading || props.disabled} {...props}>
      {loading && <Loader2 className="spin" size={16} aria-hidden />}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = '', ...props }) {
  return <button type="button" className={`icon-btn ${className}`} aria-label={label} title={label} {...props}>{children}</button>;
}

export function Field({ label, hint, error, children, full }) {
  const id = useId();
  const child = typeof children === 'function' ? children(id) : children;
  return (
    <div className={`field ${full ? 'full' : ''}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {child}
      {hint && !error && <small className="hint">{hint}</small>}
      {error && <small className="field-error" role="alert">{error}</small>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export const Badge = ({ tone = 'neutral', children }) => <span className={`badge badge-${tone}`}>{children}</span>;

export function Spinner({ label }) {
  const { t } = useTranslation();
  return <div className="spinner-wrap" role="status"><Loader2 className="spin" size={22} aria-hidden /><span>{label || t('common.loading')}</span></div>;
}

export function EmptyState({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      {Icon && <Icon size={28} aria-hidden />}
      {title && <strong>{title}</strong>}
      {children && <p>{children}</p>}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const { t } = useTranslation();
  return (
    <div className="empty error-state" role="alert">
      <AlertCircle size={28} aria-hidden />
      <p>{errorMessage(t, error)}</p>
      {onRetry && <Button onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, size }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    ref.current?.querySelector('input,select,textarea,button')?.focus();
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${size === 'lg' ? 'modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton label={t('common.close')} onClick={onClose}><X size={18} /></IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onClose }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => {
        setBusy(true);
        try { await onConfirm(); onClose(); } catch (e) { toast.error(errorMessage(t, e)); } finally { setBusy(false); }
      }}>{confirmLabel || t('common.confirm')}</Button>
    </>}>
      <p className="muted">{body}</p>
    </Modal>
  );
}

const ToastContext = createContext(null);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((tone, message) => {
    const id = Math.random().toString(36).slice(2);
    setItems(list => [...list, { id, tone, message }]);
    setTimeout(() => setItems(list => list.filter(x => x.id !== id)), 4000);
  }, []);
  const api = useRef({ success: m => push('success', m), error: m => push('error', m) });
  return (
    <ToastContext.Provider value={api.current}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(x => (
          <div key={x.id} className={`toast toast-${x.tone}`}>
            {x.tone === 'success' ? <CheckCircle2 size={18} aria-hidden /> : <AlertCircle size={18} aria-hidden />}
            <span>{x.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Small data-loading hook with loading / error / reload states. */
export function useLoader(loader, deps = []) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const run = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try { setState({ loading: false, error: null, data: await loader() }); }
    catch (error) { setState({ loading: false, error, data: null }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: data => setState(s => ({ ...s, data })) };
}

export function ColorInput({ value, onChange, placeholder, allowEmpty, emptyLabel }) {
  return (
    <div className="color-input">
      <input type="color" value={value || placeholder || '#4f46e5'} onChange={e => onChange(e.target.value)} aria-hidden tabIndex={-1} />
      <input type="text" dir="ltr" value={value || ''} placeholder={placeholder} maxLength={7}
        onChange={e => onChange(e.target.value)} aria-label="hex" />
      {allowEmpty && value && <Button size="sm" variant="ghost" type="button" onClick={() => onChange('')}>{emptyLabel}</Button>}
    </div>
  );
}

export function ImageUpload({ url, onUpload, onRemove, accept = 'image/png,image/jpeg,image/webp,image/gif', square }) {
  const { t } = useTranslation();
  const toast = useToast();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="image-upload">
      <div className={`image-preview ${square ? 'square' : ''}`}>{url ? <img src={url} alt="" /> : <span className="muted">—</span>}</div>
      <div className="row">
        <Button type="button" size="sm" loading={busy} onClick={() => input.current?.click()}>{t('common.uploadImage')}</Button>
        {url && onRemove && <Button type="button" size="sm" variant="ghost" onClick={onRemove}>{t('common.removeImage')}</Button>}
      </div>
      <input ref={input} type="file" accept={accept} hidden onChange={async e => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setBusy(true);
        try { await onUpload(file); } catch (err) { toast.error(errorMessage(t, err)); } finally { setBusy(false); }
      }} />
    </div>
  );
}

/** Field-level error for a given field name from an ApiError with details.field. */
export const fieldError = (t, error, field) => (error?.details?.field === field ? errorMessage(t, error) : null);

/**
 * Shows a one-time invitation / reset link (only when it could not be emailed).
 * The link is never stored client-side and cannot be retrieved again.
 */
export function LinkDialog({ result, title, onClose }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const link = result?.link;
  return (
    <Modal title={title} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t('common.close')}</Button>}>
      {result?.emailSent ? (
        <div className="alert alert-success"><CheckCircle2 size={16} aria-hidden />{t('links.emailSent')}</div>
      ) : link ? (
        <>
          <p className="muted">{t('links.shareOnce')}</p>
          <div className="copy-row">
            <input readOnly dir="ltr" value={link} onFocus={e => e.target.select()} aria-label={t('links.link')} />
            <Button onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* clipboard blocked */ } }}>
              {copied ? t('links.copied') : t('links.copy')}
            </Button>
          </div>
          <small className="hint">{t('links.expiry')}</small>
        </>
      ) : <p className="muted">{t('links.none')}</p>}
    </Modal>
  );
}

/** Format helpers shared by billing & admin pages. */
export const fmtDate = (value, locale, opts = { dateStyle: 'medium' }) =>
  value ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', opts).format(new Date(value)) : '—';
export const fmtMoney = (amount, currency, locale) => {
  try { return new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', { style: 'currency', currency }).format(amount); }
  catch { return `${amount} ${currency}`; }
};
export const localized = (value, locale) => (value && (value[locale] || value.en || value.ar)) || '';

/** IANA time zones for selects. Some engines omit "UTC" from supportedValuesOf, so it is always listed first. */
export const TIMEZONES = (() => {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* old browsers */ }
  return ['UTC', ...zones.filter(z => z !== 'UTC')];
})();
