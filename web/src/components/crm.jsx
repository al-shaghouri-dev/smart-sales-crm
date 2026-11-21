import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Minus, Search, X } from 'lucide-react';
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
  return (
    <div className="chart" dir="ltr" lang={i18n.language}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="none">
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

/** Smooth path through points (monotone-ish cubic, no overshoot below the baseline). */
function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1] || pts[i];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const [x3, y3] = pts[i + 2] || pts[i + 1];
    const t = 0.18;
    // Control points stay between the two neighbouring values, so the curve never overshoots (no dips below zero).
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    const clamp = v => Math.min(hi, Math.max(lo, v));
    const c1 = [x1 + (x2 - x0) * t, clamp(y1 + (y2 - y0) * t)];
    const c2 = [x2 - (x3 - x1) * t, clamp(y2 - (y3 - y1) * t)];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${x2},${y2}`;
  }
  return d;
}

let gradSeq = 0;
const useGradId = prefix => { const r = useRef(null); if (!r.current) r.current = `${prefix}${++gradSeq}`; return r.current; };

/** Tiny area sparkline that fills its container. */
export function Sparkline({ values, color = 'var(--primary)' }) {
  const id = useGradId('sp');
  const w = 200, h = 48;
  const max = Math.max(...values, 0), min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [values.length === 1 ? w : (i / (values.length - 1)) * w, h - 4 - ((v - min) / span) * (h - 10)]);
  const line = smoothPath(pts);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden dir="ltr">
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".45" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {values.length > 0 && <path d={`${line} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />}
      {values.length > 0 && <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** Percentage change badge versus the previous period. */
export function Trend({ current, previous, points }) {
  const { t } = useTranslation();
  let diff = null;
  if (points) diff = current === null || previous === null ? null : Math.round((current - previous) * 10) / 10;
  else if (previous > 0) diff = Math.round(((current - previous) / previous) * 1000) / 10;
  else if (current > 0) diff = 100;
  if (diff === null) return <span className="trend" title={t('dashboard.vsPrevious')}><Minus size={13} aria-hidden /></span>;
  const Icon = diff > 0 ? ArrowUpRight : diff < 0 ? ArrowDownRight : Minus;
  return (
    <span className={`trend ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`} title={t('dashboard.vsPrevious')} dir="ltr">
      <Icon size={14} aria-hidden />{diff > 0 ? '+' : ''}{diff}{points ? ' pt' : '%'}
    </span>
  );
}

const niceMax = v => { if (v <= 0) return 4; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; };

/** Responsive area chart with hover tooltip. Time always runs left → right (also in Arabic). */
export function AreaChart({ labels, values, color = 'var(--primary)', height = 260, format = v => String(v), formatLabel = l => l }) {
  const box = useRef(null);
  const id = useGradId('ar');
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState(null);
  useLayoutEffect(() => {
    if (!box.current) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const pad = { top: 20, right: 12, bottom: 26, left: 44 };
  const cw = width - pad.left - pad.right, ch = height - pad.top - pad.bottom;
  const top = niceMax(Math.max(...values, 0));
  const n = values.length;
  const x = i => pad.left + (n <= 1 ? cw : (i / (n - 1)) * cw);
  const y = v => pad.top + ch - (v / top) * ch;
  const pts = values.map((v, i) => [x(i), y(v)]);
  const line = smoothPath(pts);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => top * f);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(cw / 70))));
  const short = v => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : String(+v.toFixed(1)));
  const showDots = n <= 40;
  function move(e) {
    const r = box.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = Math.round(((px - pad.left) / cw) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  }
  return (
    <div className="area-chart" ref={box} dir="ltr" onMouseMove={move} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} role="img">
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".42" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
        {ticks.map(v => (
          <g key={v}>
            <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} />
            <text className="axis" x={pad.left - 8} y={y(v) + 4} textAnchor="end">{short(v)}</text>
          </g>
        ))}
        {n > 0 && <path d={`${line} L${x(n - 1)},${pad.top + ch} L${x(0)},${pad.top + ch} Z`} fill={`url(#${id})`} />}
        {n > 0 && <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" />}
        {showDots && pts.map(([px, py], i) => (i % every === 0 || i === n - 1) && <circle key={i} className="dot" cx={px} cy={py} r="3.5" stroke={color} />)}
        {labels.map((l, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) ? (
          <text key={l} className="axis" x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>{formatLabel(l)}</text>
        ) : null)}
        {hover !== null && <>
          <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + ch} stroke={color} strokeOpacity=".35" strokeDasharray="4 4" />
          <circle cx={x(hover)} cy={y(values[hover])} r="6" fill={color} stroke="var(--surface)" strokeWidth="3" />
        </>}
      </svg>
      {hover !== null && (
        <div className="area-tip" style={{ left: x(hover), top: y(values[hover]) }}>
          {format(values[hover])}<small>{formatLabel(labels[hover], true)}</small>
        </div>
      )}
    </div>
  );
}

/** Donut with legend. rows: [{ label, value, color }] */
export function Donut({ rows, centerLabel }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  const r = 70, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="donut-wrap">
      <div className="donut">
        <svg viewBox="0 0 180 180" aria-hidden>
          <circle cx="90" cy="90" r={r} stroke="var(--surface-2)" />
          {total > 0 && rows.map(row => {
            const len = (row.value / total) * c;
            const el = <circle key={row.label} cx="90" cy="90" r={r} stroke={row.color} strokeDasharray={`${Math.max(len - 2, 0)} ${c}`} strokeDashoffset={-offset} />;
            offset += len;
            return el;
          })}
        </svg>
        <div className="donut-center"><strong>{total.toLocaleString('en')}</strong><span>{centerLabel}</span></div>
      </div>
      <ul className="legend">
        {rows.map(row => (
          <li key={row.label}><i style={{ background: row.color }} /><span dir="auto">{row.label}</span><b dir="ltr">{total ? Math.round((row.value / total) * 100) : 0}%</b></li>
        ))}
      </ul>
    </div>
  );
}

/** "5 minutes ago" in the current language. */
export function timeAgo(value, locale) {
  const diff = (new Date(value).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale === 'ar' ? 'ar' : 'en', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDay(value, locale);
}
