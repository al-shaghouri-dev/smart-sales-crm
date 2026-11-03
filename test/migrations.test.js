const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Knex runs migrations in filename order. A filename dated in the future sorts after migrations
 * created later with `knex migrate:make`, which breaks fresh installs (see Phase 2 review).
 * These checks run without a database.
 */
const DIR = path.join(__dirname, '..', 'db', 'migrations');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js')).sort();
const PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_[a-z0-9_]+\.js$/;

function timestampOf(file) {
  const m = PATTERN.exec(file);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Reject impossible dates such as 20261340... (Date would silently roll them over).
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return date;
}

test('migration filenames use the knex YYYYMMDDHHMMSS_name.js format with a real date', () => {
  assert.ok(files.length >= 2);
  for (const f of files) assert.ok(timestampOf(f), `${f} must look like 20261103000002_snake_case_name.js with a valid date`);
});

test('no migration is dated in the future', () => {
  const now = Date.now();
  const future = files.filter(f => timestampOf(f).getTime() > now);
  assert.deepEqual(future, [], 'future-dated migrations sort after ones created later and break fresh installs');
});

test('migration timestamps are unique and strictly increasing', () => {
  const stamps = files.map(f => f.slice(0, 14));
  assert.equal(new Set(stamps).size, stamps.length, 'duplicate timestamps');
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] > stamps[i - 1]);
});

test('migrations do not import live application code', () => {
  // A migration must keep producing the same schema forever, so it cannot depend on files that change later.
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    assert.doesNotMatch(src, /require\(['"]\.\.\/\.\.\/server\//, `${f} imports ../../server — copy the values into the migration instead`);
  }
});
