let csrfToken = null;
let onUnauthorized = () => {};

export const setCsrfToken = token => { csrfToken = token; };
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request(method, url, body) {
  const headers = {};
  const init = { method, credentials: 'same-origin', headers };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken || '';
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }

  let res;
  try { res = await fetch(url, init); } catch { throw new ApiError(0, 'common.network', 'Network error'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/auth/me' && url !== '/api/auth/login') onUnauthorized();
    throw new ApiError(res.status, data.code || 'common.server_error', data.error || 'Request failed', data.details);
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: url => request('DELETE', url),
  upload: (url, file) => { const fd = new FormData(); fd.append('file', file); return request('POST', url, fd); }
};
