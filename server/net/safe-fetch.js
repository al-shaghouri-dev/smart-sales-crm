const dns = require('dns').promises;
const net = require('net');

/**
 * Outbound HTTP for provider APIs and media downloads, with SSRF protection.
 *
 *  - https only (http only when explicitly allowed for local test servers outside production)
 *  - the host is resolved first and EVERY address must be public: loopback, private, link-local
 *    (incl. cloud metadata 169.254.169.254), CGNAT, multicast, reserved and IPv4-mapped ranges are
 *    refused, unless allowPrivate (tests only)
 *  - optional host allow-list (e.g. only lookaside.fbsbx.com / graph.facebook.com)
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

async function assertSafeUrl(raw, { allowHttp = false, allowPrivate = false, allowedHosts = null } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new SafeFetchError('net.invalid_url'); }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new SafeFetchError('net.insecure_url');
  if (url.username || url.password) throw new SafeFetchError('net.invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts && !allowedHosts.some(h => host === h || (h.startsWith('.') && host.endsWith(h)))) throw new SafeFetchError('net.host_not_allowed');
  if (!allowPrivate) {
    const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true }).catch(() => { throw new SafeFetchError('net.dns_failed'); })).map(r => r.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) throw new SafeFetchError('net.private_address');
  }
  return url;
}

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) { await res.body?.cancel().catch(() => {}); throw new SafeFetchError('net.too_large'); }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body || []) {
    total += chunk.length;
    if (total > maxBytes) throw new SafeFetchError('net.too_large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * fetch() with SSRF checks. Returns { status, headers, body: Buffer, json() }.
 * opts: { method, headers, body, timeoutMs = 15000, maxBytes = 2MB, allowHttp, allowPrivate, allowedHosts, maxRedirects = 3 }
 */
async function safeFetch(raw, opts = {}) {
  const { method = 'GET', headers, body, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024, maxRedirects = 3 } = opts;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertSafeUrl(current, opts);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: hop === 0 ? method : 'GET', headers, body: hop === 0 ? body : undefined, redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        if (!location) throw new SafeFetchError('net.bad_redirect');
        current = new URL(location, url).toString();
        continue;
      }
      const buf = await readLimited(res, maxBytes);
      return {
        status: res.status, ok: res.ok, headers: res.headers, body: buf,
        json() { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }
      };
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      if (error.name === 'AbortError') throw Object.assign(new SafeFetchError('net.timeout'), { name: 'AbortError' });
      // Undici wraps the cause; keep only a code (never the URL).
      throw Object.assign(new SafeFetchError('net.request_failed'), { code: error.cause?.code || 'ECONNRESET' });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SafeFetchError('net.too_many_redirects');
}

module.exports = { safeFetch, assertSafeUrl, isPrivateAddress, SafeFetchError };
