import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { detectLocale, directionOf } from '../../web/src/lib/locale.js';
import { resolveThemePreference, contrastText } from '../../web/src/lib/theme.js';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const en = JSON.parse(fs.readFileSync(path.join(root, 'web/src/locales/en.json'), 'utf8'));
const ar = JSON.parse(fs.readFileSync(path.join(root, 'web/src/locales/ar.json'), 'utf8'));

const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) =>
  v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]);
const has = (dict, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), dict) !== undefined
  // keys like permissions['company.settings.view'] contain dots inside one property
  || (() => { const [head, ...rest] = key.split('.'); return dict[head] && dict[head][rest.join('.')] !== undefined; })();

describe('language detection', () => {
  test('device language decides on first visit', () => {
    assert.equal(detectLocale({ languages: ['ar-EG', 'en-US'] }), 'ar');
    assert.equal(detectLocale({ languages: ['en-GB', 'ar'] }), 'en');
    assert.equal(detectLocale({ languages: ['AR'] }), 'ar');
  });
  test('unsupported device languages fall back to the platform default', () => {
    assert.equal(detectLocale({ languages: ['fr-FR', 'de'], fallback: 'ar' }), 'ar');
    assert.equal(detectLocale({ languages: ['fr-FR', 'en'], fallback: 'ar' }), 'en');
    assert.equal(detectLocale({ languages: [] }), 'en');
  });
  test('a manual choice is never overridden by device detection', () => {
    assert.equal(detectLocale({ saved: 'en', languages: ['ar-SA'] }), 'en');
    assert.equal(detectLocale({ account: 'ar', saved: 'en', languages: ['en-US'] }), 'ar');
    assert.equal(detectLocale({ saved: 'xx', languages: ['ar'] }), 'ar');
  });
  test('direction follows language', () => {
    assert.equal(directionOf('ar'), 'rtl');
    assert.equal(directionOf('en'), 'ltr');
  });
  test('theme preference precedence', () => {
    assert.equal(resolveThemePreference({ account: 'dark', saved: 'light', fallback: 'system' }), 'dark');
    assert.equal(resolveThemePreference({ saved: 'light', fallback: 'dark' }), 'light');
    assert.equal(resolveThemePreference({ fallback: 'dark' }), 'dark');
  });
  test('brand text color stays readable', () => {
    assert.equal(contrastText('#ffffff'), '#0f172a');
    assert.equal(contrastText('#4f46e5'), '#ffffff');
    assert.equal(contrastText('#facc15'), '#0f172a');
  });
});

describe('translations', () => {
  test('Arabic and English define exactly the same keys', () => {
    const a = new Set(flatten(ar).map(([k]) => k));
    const e = new Set(flatten(en).map(([k]) => k));
    assert.deepEqual([...e].filter(k => !a.has(k)), [], 'missing in ar.json');
    assert.deepEqual([...a].filter(k => !e.has(k)), [], 'missing in en.json');
  });

  test('no empty translations', () => {
    for (const [dict, name] of [[en, 'en'], [ar, 'ar']]) {
      assert.deepEqual(flatten(dict).filter(([, v]) => !String(v).trim()).map(([k]) => k), [], name);
    }
  });

  test('every static t() key used in the frontend exists', () => {
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p); else if (/\.(jsx?|mjs)$/.test(d.name)) files.push(p);
    });
    walk(path.join(root, 'web/src'));
    const missing = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)) if (!has(en, m[1])) missing.push(`${path.basename(file)}: ${m[1]}`);
    }
    assert.deepEqual(missing, []);
  });

  test('every permission, role and server error code has a label', () => {
    const { PERMISSIONS, SYSTEM_ROLES } = require('../../server/permissions.js');
    for (const dict of [en, ar]) {
      for (const p of PERMISSIONS) {
        assert.ok(dict.permissions[p.key], `permission ${p.key}`);
        assert.ok(dict.permissionCategories[p.category], `category ${p.category}`);
      }
      for (const r of SYSTEM_ROLES) assert.ok(dict.roles.system[r.key] && dict.roles.systemDescription[r.key], `role ${r.key}`);
    }
    const serverSrc = fs.readdirSync(path.join(root, 'server'), { recursive: true })
      .filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(root, 'server', f), 'utf8')).join('\n');
    const codes = new Set([...serverSrc.matchAll(/(?:badRequest|forbidden|notFound|conflict|unauthorized)\('([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]));
    codes.add('auth.rate_limited');
    const missing = [...codes].filter(c => !has(en.errors, c) || !has(ar.errors, c));
    assert.deepEqual(missing, []);
    const actions = new Set([...serverSrc.matchAll(/action: '([a-z_]+\.[a-z_]+)'/g)].map(m => m[1]));
    const missingActions = [...actions].filter(a => !en.audit.actions[a] || !ar.audit.actions[a]);
    assert.deepEqual(missingActions, []);
  });
});
