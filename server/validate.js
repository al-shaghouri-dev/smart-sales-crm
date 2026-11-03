const { badRequest } = require('./errors');

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const LOCALES = ['ar', 'en'];
const THEMES = ['light', 'dark', 'system'];
const FONTS = ['Cairo', 'Inter', 'IBM Plex Sans Arabic', 'Tajawal', 'Noto Sans Arabic', 'system-ui'];

function str(value, { field, max = 200, required = false, min = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('validation.required', `${field} is required`, { field });
    return value === undefined ? undefined : null;
  }
  const s = String(value).trim();
  if (required && !s) throw badRequest('validation.required', `${field} is required`, { field });
  if (s.length > max || s.length < min) throw badRequest('validation.length', `${field} has an invalid length`, { field, min, max });
  return s;
}

function email(value, { field = 'email', required = true } = {}) {
  const s = str(value, { field, max: 254, required });
  if (s && !EMAIL.test(s)) throw badRequest('validation.email', 'Invalid email address', { field });
  return s ? s.toLowerCase() : s;
}

function oneOf(value, allowed, { field, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest('validation.required', `${field} is required`, { field });
    return value === undefined ? undefined : null;
  }
  if (!allowed.includes(value)) throw badRequest('validation.invalid', `${field} is invalid`, { field });
  return value;
}

function color(value, { field } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!COLOR.test(String(value))) throw badRequest('validation.color', `${field} must be a #RRGGBB color`, { field });
  return String(value).toLowerCase();
}

function number(value, { field, min = 0, max = 1e9 } = {}) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw badRequest('validation.number', `${field} is invalid`, { field });
  return n;
}

function url(value, { field } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim();
  if (!/^(\/uploads\/[\w./-]+|https:\/\/[^\s"'<>]{1,2000})$/i.test(s) || s.includes('..')) {
    throw badRequest('validation.url', `${field} must be an https URL`, { field });
  }
  return s;
}

function timezone(value, { field = 'timezone' } = {}) {
  if (value === undefined) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: String(value) });
    return String(value);
  } catch {
    throw badRequest('validation.timezone', 'Invalid timezone', { field });
  }
}

/** Per-locale text object: { ar?: string, en?: string } */
function localized(value, { field, max = 200 } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('validation.invalid', `${field} is invalid`, { field });
  const out = {};
  for (const loc of LOCALES) if (value[loc] !== undefined && value[loc] !== null) out[loc] = str(value[loc], { field, max }) || '';
  return out;
}

function uuid(value, { field = 'id' } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))) {
    throw badRequest('validation.invalid', `${field} is invalid`, { field });
  }
  return String(value).toLowerCase();
}

/** Drop undefined keys so PATCH only touches provided fields. */
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

module.exports = { str, email, oneOf, color, number, url, timezone, localized, uuid, compact, LOCALES, THEMES, FONTS };
