const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

/**
 * Outbound HTTP for provider APIs and media downloads, with SSRF protection.
 *
 *  - https only (http only when explicitly allowed for local test servers outside production)
 *  - the host is resolved first and EVERY address must be public: loopback, private, link-local
 *    (incl. cloud metadata 169.254.169.254), CGNAT, multicast, reserved and IPv4-mapped ranges are
 *    refused, unless allowPrivate (tests only)
 *  - optional host allow-list (e.g. only lookaside.fbsbx.com / graph.facebook.com)
 *  - the connection uses ONLY the addresses validated above (custom DNS lookup at connect time), so
 *    a hostile DNS server cannot answer "public" for the check and "private" for the connection
 *    (DNS rebinding)
 *  - redirects are not followed automatically; each hop is re-validated (max 3)
 *  - response size limit (streamed, aborted when exceeded) and a timeout
 *  - errors never include the URL (provider URLs can contain tokens)
 */
class SafeFetchError extends Error {
  constructor(code, status) { super(code); this.code = code; this.name = 'SafeFetchError'; if (status) this.status = status; }
}

function ipv4ToInt(ip) { return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0; }
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32]
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();
    if (a === '::' || a === '::1') return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:/.test(a) || /^64:ff9b:/.test(a)) return true; // mapped / NAT64 forms: refuse
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true;   // multicast
    if (first === 0x2001 && parseInt(a.split(':')[1] || '0', 16) === 0x0db8) return true; // documentation
    return false;
  }
  return true;
}

async function resolveHost(host) {
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  try { return await dns.promises.lookup(host, { all: true, verbatim: true }); } catch { throw new SafeFetchError('net.dns_failed'); }
}

/** Validate a URL; returns { url, addresses } where addresses are the vetted IPs to connect to. */
async function assertSafeUrl(raw, { allowHttp = false, allowPrivate = false, allowedHosts = null } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new SafeFetchError('net.invalid_url'); }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new SafeFetchError('net.insecure_url');
  if (url.username || url.password) throw new SafeFetchError('net.invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts && !allowedHosts.some(h => host === h || (h.startsWith('.') && host.endsWith(h)))) throw new SafeFetchError('net.host_not_allowed');
  const addresses = await resolveHost(host);
  if (!addresses.length || (!allowPrivate && addresses.some(a => isPrivateAddress(a.address)))) throw new SafeFetchError('net.private_address');
  return { url, addresses };
}

/** Serialise a fetch-style body (string, Buffer, URLSearchParams, FormData) for http(s).request. */
async function encodeBody(body, headers) {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return Buffer.from(body);
  const req = new Request('http://local.invalid/', { method: 'POST', body });
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type') && req.headers.get('content-type')) headers['Content-Type'] = req.headers.get('content-type');
  return Buffer.from(await req.arrayBuffer());
}

function request(url, addresses, { method, headers, body, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let i = 0;
    const lookup = (_host, opts, cb) => {
      const a = addresses[i++ % addresses.length];
      if (opts && opts.all) return cb(null, [{ address: a.address, family: a.family }]);
      cb(null, a.address, a.family);
    };
    const req = lib.request(url, { method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, lookup, timeout: timeoutMs, servername: net.isIP(url.hostname) ? undefined : url.hostname }, res => {
      const declared = Number(res.headers['content-length'] || 0);
      if (declared && declared > maxBytes) { res.destroy(); return reject(new SafeFetchError('net.too_large')); }
      const chunks = []; let total = 0;
      res.on('data', c => { total += c.length; if (total > maxBytes) { res.destroy(); reject(new SafeFetchError('net.too_large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => reject(Object.assign(new SafeFetchError('net.request_failed'), { code: 'ECONNRESET' })));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' })), timeoutMs);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    req.on('error', error => {
      clearTimeout(timer);
      if (error instanceof SafeFetchError) return reject(error);
      if (error.name === 'AbortError') return reject(Object.assign(new SafeFetchError('net.timeout'), { name: 'AbortError' }));
      reject(Object.assign(new SafeFetchError('net.request_failed'), { code: error.code || 'ECONNRESET' }));
    });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * fetch() with SSRF checks. Returns { status, headers, body: Buffer, json() }.
 * opts: { method, headers, body, timeoutMs = 15000, maxBytes = 2MB, allowHttp, allowPrivate, allowedHosts, maxRedirects = 3 }
 */
async function safeFetch(raw, opts = {}) {
  const { method = 'GET', timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3 } = opts;
  const headers = { ...(opts.headers || {}) };
  const body = await encodeBody(opts.body, headers);
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, addresses } = await assertSafeUrl(current, opts);
    const res = await request(url, addresses, { method: hop === 0 ? method : 'GET', headers: hop === 0 ? headers : {}, // credentials are never forwarded to a redirect target body: hop === 0 ? body : null, timeoutMs, maxBytes });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!res.headers.location) throw new SafeFetchError('net.bad_redirect');
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    const buf = res.body;
    return {
      status: res.status, ok: res.status >= 200 && res.status < 300, headers: { get: k => res.headers[String(k).toLowerCase()] ?? null }, body: buf,
      json() { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }
    };
  }
  throw new SafeFetchError('net.too_many_redirects');
}

module.exports = { safeFetch, assertSafeUrl, isPrivateAddress, SafeFetchError };
