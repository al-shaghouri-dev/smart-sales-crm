import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { Badge } from './ui';

export const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '•';

export const CUSTOMER_TONES = { new: 'primary', lead: 'warning', customer: 'success', inactive: 'neutral' };
export const ORDER_TONES = { new: 'primary', confirmed: 'warning', shipped: 'warning', delivered: 'success', cancelled: 'neutral' };

export function CustomerStatus({ status }) {
  const { t } = useTranslation();
  return <Badge tone={CUSTOMER_TONES[status] || 'neutral'}>{t(`customers.status.${status}`)}</Badge>;
}

export function money(value, currency, locale) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: Number.isInteger(value) ? 0 : 2 }).format(value || 0);
  } catch { return `${value} ${currency}`; }
}

export const fmtDay = (value, locale) => (value ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium' }).format(new Date(value)) : '—');
export const fmtDateTime = (value, locale) => (value ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—');

/** Searchable customer selector (server-side search). value = { id, displayName } | null */
export function CustomerPicker({ value, onChange, id, placeholder }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = setTimeout(() => {
      api.get(`/api/customers?limit=8&search=${encodeURIComponent(q)}`).then(r => setItems(r.customers)).catch(() => setItems([]));
    }, 200);
    return () => clearTimeout(h);
  }, [q, open]);
  useEffect(() => {
    const close = e => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  if (value) {
    return (
      <div className="picker-value">
        <span className="avatar sm" aria-hidden>{initials(value.displayName)}</span>
        <span dir="auto">{value.displayName}</span>
        <button type="button" className="icon-btn" aria-label={t('common.remove')} onClick={() => onChange(null)}><X size={14} /></button>
      </div>
    );
  }
  return (
    <div className="picker" ref={box}>
      <div className="search-box">
        <Search size={16} aria-hidden />
        <input id={id} value={q} placeholder={placeholder || t('customers.searchPlaceholder')} onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true); }} autoComplete="off" />
      </div>
      {open && (
        <ul className="picker-list" role="listbox">
          {!items.length && <li className="muted small picker-empty">{t('customers.noMatches')}</li>}
          {items.map(c => (
            <li key={c.id}>
              <button type="button" onClick={() => { onChange({ id: c.id, displayName: c.displayName }); setOpen(false); setQ(''); }}>
                <span className="avatar sm" aria-hidden>{initials(c.displayName)}</span>
                <span className="picker-main"><strong dir="auto">{c.displayName}</strong><small className="muted" dir="ltr">{c.phone || c.email || ''}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Pager({ page, pages, onPage }) {
  const { t, i18n } = useTranslation();
  if (pages <= 1) return null;
  const rtl = i18n.dir() === 'rtl';
  const Prev = rtl ? ChevronRight : ChevronLeft;
  const Next = rtl ? ChevronLeft : ChevronRight;
  return (
    <div className="pager">
      <button type="button" className="icon-btn" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.previous')}><Prev size={18} /></button>
      <span className="muted small">{t('common.pageOf', { page, pages })}</span>
      <button type="button" className="icon-btn" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('common.next')}><Next size={18} /></button>
    </div>
  );
}

/**
 * Minimal responsive bar chart (SVG, no dependency). series: [{ label, values[], color }]; labels: x labels.
 * Bars of several series are grouped side by side.
 */
export function BarChart({ labels, series, height = 180, format = v => String(v) }) {
  const { i18n } = useTranslation();
  const max = Math.max(1, ...series.flatMap(s => s.values));
  const n = labels.length;
  const width = 640;
  const pad = { top: 10, bottom: 22, left: 4, right: 4 };
  const slot = (width - pad.left - pad.right) / Math.max(n, 1);
  const barW = Math.max(2, Math.min(18, (slot * 0.7) / series.length));
  const chartH = height - pad.top - pad.bottom;
  const step = Math.max(1, Math.ceil(n / 8));
  const rtl = i18n.dir() === 'rtl';
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="none" style={{ transform: rtl ? 'scaleX(-1)' : undefined }}>
        {[0.25, 0.5, 0.75, 1].map(f => <line key={f} x1={pad.left} x2={width - pad.right} y1={pad.top + chartH * (1 - f)} y2={pad.top + chartH * (1 - f)} className="chart-grid" />)}
        {labels.map((l, i) => series.map((s, j) => {
          const v = s.values[i] || 0;
          const h = (v / max) * chartH;
          const x = pad.left + i * slot + (slot - barW * series.length) / 2 + j * barW;
          return <rect key={`${i}-${j}`} x={x} y={pad.top + chartH - h} width={barW - 1} height={Math.max(h, v ? 1 : 0)} rx="2" fill={s.color}><title>{`${l}: ${format(v)}`}</title></rect>;
        }))}
      </svg>
      <div className="chart-x">
        {labels.map((l, i) => (i % step === 0 ? <span key={l} style={{ insetInlineStart: `${((i + 0.5) / n) * 100}%` }}>{l.slice(5)}</span> : null))}
      </div>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map(s => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars (e.g. pipeline stages). rows: [{ label, value, sub }] */
export function HBars({ rows, color = 'var(--primary)' }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <ul className="hbars">
      {rows.map(r => (
        <li key={r.label}>
          <span className="hbars-label" dir="auto">{r.label}</span>
          <span className="hbars-track"><span className="hbars-fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} /></span>
          <span className="hbars-value">{r.sub ?? r.value}</span>
        </li>
      ))}
    </ul>
  );
}
