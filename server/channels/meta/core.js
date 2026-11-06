const crypto = require('crypto');
const { ProviderError } = require('../adapter');
const { verifyHmacSha256, safeEqual } = require('../../webhooks/signatures');
const { safeFetch } = require('../../net/safe-fetch');

/**
 * Shared Meta platform core (Messenger, Instagram, WhatsApp).
 *
 *  - Webhook signatures: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
 *  - Verification handshake: hub.mode=subscribe & hub.verify_token → echo hub.challenge.
 *  - Graph API client: official hosts only (allow-listed in safeFetch), appsecret_proof on every
 *    call, tokens sent in the Authorization header (never in logged URLs), errors mapped to stable
 *    codes so the sender can decide retry / fail / reconnect.
 *  - signed_request parsing for Deauthorize and Data Deletion callbacks.
 */
const GRAPH_HOSTS = ['graph.facebook.com'];
const IG_HOSTS = ['graph.instagram.com', 'api.instagram.com'];
const CDN_HOSTS = ['.fbcdn.net', '.fbsbx.com', 'lookaside.fbsbx.com', '.cdninstagram.com'];

/** Map a Graph API error object to a ProviderError. https://developers.facebook.com/docs/graph-api/guides/error-handling */
function mapGraphError(status, err = {}) {
  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  if (code === 190 || code === 102) return new ProviderError(sub === 463 || sub === 467 ? 'provider.token_expired' : 'provider.token_invalid', { retryable: false });
  if ([10, 200, 230, 299].includes(code) && sub === 2018278) return new ProviderError('provider.window_closed', { retryable: false });
  if (code === 10 || (code >= 200 && code <= 299)) return new ProviderError('provider.permission_revoked', { retryable: false });
  if ([4, 17, 32, 613, 80006, 80007, 130429, 131048, 131056].includes(code)) return new ProviderError('provider.rate_limited', { retryable: true });
  if (code === 551 || sub === 1545041 || code === 131026 || code === 131031) return new ProviderError('provider.recipient_blocked', { retryable: false });
  if (code === 131047 || code === 470) return new ProviderError('provider.window_closed', { retryable: false });
  if (code === 132000 || code === 132001 || code === 132005 || code === 132012) return new ProviderError('provider.template_invalid', { retryable: false });
  if (code === 131051 || code === 131052 || code === 131053) return new ProviderError('provider.unsupported_media', { retryable: false });
  if (code === 1 || code === 2 || code === 131000 || code === 131016 || status >= 500 || !status) return new ProviderError('provider.unavailable', { retryable: true });
  return new ProviderError('provider.bad_request', { retryable: false });
}

const appSecretProof = (token, secret) => crypto.createHmac('sha256', String(secret)).update(String(token)).digest('hex');

/**
 * Graph client factory.
 *   base: 'https://graph.facebook.com' | 'https://graph.instagram.com'
 *   testMode: allow http + local hosts (development mock servers only)
 */
function createGraphClient({ base, version, appSecret, hosts, testMode = false, fetchImpl = safeFetch }) {
  const netOpts = extra => (testMode ? { allowHttp: true, allowPrivate: true, ...extra } : { allowedHosts: hosts, ...extra });
  const url = (path, query = {}) => {
    const u = new URL(`${base}/${version ? `${version}/` : ''}${String(path).replace(/^\//, '')}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    return u.toString();
  };
  async function request(method, path, { token, query = {}, json, form, multipart, timeoutMs = 20000, maxBytes = 2 * 1024 * 1024, versioned = true } = {}) {
    const q = { ...query };
    if (token && appSecret) q.appsecret_proof = appSecretProof(token, appSecret);
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    else if (multipart) body = multipart;
    const target = versioned ? url(path, q) : (() => { const u = new URL(`${base}/${String(path).replace(/^\//, '')}`); for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v)); return u.toString(); })();
    const res = await fetchImpl(target, netOpts({ method, headers, body, timeoutMs, maxBytes }));
    const data = res.json();
    if (!res.ok || !data || data.error) throw mapGraphError(res.status, data?.error || {});
    return data;
  }
  return {
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),
    del: (path, opts) => request('DELETE', path, opts),
    request
  };
}

/** Download media from Meta's CDN (or a test server) with SSRF checks and a size limit. */
async function downloadMedia(mediaUrl, { token, testMode = false, maxBytes = 20 * 1024 * 1024, fetchImpl = safeFetch } = {}) {
  const res = await fetchImpl(mediaUrl, testMode ? { allowHttp: true, allowPrivate: true, maxBytes, timeoutMs: 60000, headers: token ? { Authorization: `Bearer ${token}` } : undefined }
    : { allowedHosts: [...CDN_HOSTS, ...GRAPH_HOSTS], maxBytes, timeoutMs: 60000, headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) throw new ProviderError(res.status >= 500 ? 'provider.unavailable' : 'provider.bad_request', { retryable: res.status >= 500 });
  return res.body;
}

function verifyMetaSignature(rawBody, headers, appSecret) {
  if (!appSecret) return false;
  return verifyHmacSha256(rawBody, appSecret, headers['x-hub-signature-256']);
}

function handleMetaVerification(query, verifyToken) {
  if (verifyToken && query['hub.mode'] === 'subscribe' && safeEqual(String(query['hub.verify_token'] || ''), verifyToken) && /^[\w-]{1,200}$/.test(String(query['hub.challenge'] || ''))) {
    return { status: 200, body: String(query['hub.challenge']) };
  }
  return { status: 403, body: 'Forbidden' };
}

/** Parse and verify a Meta signed_request (Deauthorize / Data Deletion callbacks). Returns the payload or null. */
function parseSignedRequest(signedRequest, appSecret) {
  if (!appSecret || typeof signedRequest !== 'string' || signedRequest.length > 4096) return null;
  const [sig, payload] = signedRequest.split('.');
  if (!sig || !payload) return null;
  const expected = crypto.createHmac('sha256', String(appSecret)).update(payload).digest();
  let given;
  try { given = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (data.algorithm && String(data.algorithm).toUpperCase() !== 'HMAC-SHA256') return null;
    return data;
  } catch { return null; }
}

/** Kind of a stored attachment → Meta attachment type. */
const metaAttachmentType = kind => (kind === 'image' ? 'image' : kind === 'audio' ? 'audio' : kind === 'video' ? 'video' : 'file');

module.exports = {
  GRAPH_HOSTS, IG_HOSTS, CDN_HOSTS, mapGraphError, appSecretProof, createGraphClient, downloadMedia,
  verifyMetaSignature, handleMetaVerification, parseSignedRequest, metaAttachmentType
};
