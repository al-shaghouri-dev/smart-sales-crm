#!/usr/bin/env node
/*
 * Build guard for Vercel (runs before `npm run build` on Vercel; see vercel.json buildCommand).
 *
 * Vercel hosts ONLY the static frontend. /api, /socket.io, /webhooks and /uploads are forwarded to
 * the Node.js server (which runs jobs, Socket.IO and owns the database connection) so the browser
 * sees a single origin and the session cookie/CSRF protection keep working unchanged.
 *
 * This guard stops a deployment that would be broken or unsafe:
 *   - the backend origin placeholder is still in vercel.json
 *   - a backend destination is not https
 *   - the four backend rewrites do not all point to the same origin
 *   - the security headers were removed
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'vercel.json');
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const problems = [];

const external = (config.rewrites || []).filter(r => /^https?:\/\//.test(r.destination));
const required = ['/api/', '/socket.io/', '/webhooks/', '/uploads/'];
for (const prefix of required) {
  if (!external.some(r => r.source.startsWith(prefix))) problems.push(`missing rewrite for ${prefix}`);
}
const origins = new Set();
for (const r of external) {
  if (r.destination.includes('NOT_CONFIGURED')) {
    problems.push('vercel.json still contains the placeholder backend origin (BACKEND_ORIGIN_NOT_CONFIGURED.invalid)');
    break;
  }
  let url;
  try { url = new URL(r.destination.replace(/\$\d+/g, 'x')); } catch { problems.push(`invalid destination: ${r.destination}`); continue; }
  if (url.protocol !== 'https:') problems.push(`backend destination must use https: ${url.origin}`);
  origins.add(url.origin);
}
if (origins.size > 1) problems.push(`all backend rewrites must point to one origin (found ${[...origins].join(', ')})`);

const headerKeys = new Set((config.headers || []).flatMap(h => (h.headers || []).map(x => x.key.toLowerCase())));
for (const key of ['content-security-policy', 'x-content-type-options', 'referrer-policy', 'strict-transport-security']) {
  if (!headerKeys.has(key)) problems.push(`security header missing: ${key}`);
}

if (problems.length) {
  console.error('\nVercel deployment blocked by scripts/check-vercel-config.js:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nSet the Node.js backend origin (https://…) in the four rewrites of vercel.json.');
  console.error('See docs/DEPLOYMENT.md, section "Vercel (frontend only)".\n');
  process.exit(1);
}
console.log(`Vercel config OK — backend origin: ${[...origins][0]}`);
