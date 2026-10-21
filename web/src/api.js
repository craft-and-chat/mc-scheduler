import { mockRequest } from './mock.js';

const qs = new URLSearchParams(location.search);
export const MOCK = qs.get('mock') === '1' || import.meta.env.VITE_MOCK === '1';
export const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
export const configured = MOCK || !!API_URL;

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
export const store = { get: lsGet, set: lsSet, del: (k) => { try { localStorage.removeItem(k); } catch {} } };

// Capture ?code= once, then strip it from the address bar.
export function captureAccessCode() {
  try {
    const u = new URL(location.href);
    const code = u.searchParams.get('code');
    if (code) {
      lsSet('mcs_code', code);
      u.searchParams.delete('code');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
  } catch {}
}

export const adminKey = {
  get: () => { try { return sessionStorage.getItem('mcs_admin') || ''; } catch { return ''; } },
  set: (v) => { try { sessionStorage.setItem('mcs_admin', v); } catch {} },
};

async function request(method, path, body, extraHeaders = {}) {
  const [p, search = ''] = path.split('?');
  const headers = { ...extraHeaders };
  const code = lsGet('mcs_code');
  if (code) headers['X-Access-Code'] = code;
  if (MOCK) {
    try { return await mockRequest(method, p, new URLSearchParams(search), body, headers); }
    catch (e) { const err = new Error(e.message); err.status = e.status || 500; throw err; }
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API_URL + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    const err = new Error('Network error'); err.network = true; throw err;
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(res.status === 401 && /access code/.test(data?.error || '') ? 'This link is missing the group code — open the app using the link posted in Discord.' : ((data && data.error) || `HTTP ${res.status}`));
    err.status = res.status; throw err;
  }
  return data;
}

const A = () => ({ 'X-Admin-Key': adminKey.get() });
export const api = {
  state: (week) => request('GET', '/api/state' + (week ? `?week=${week}` : '')),
  addPerson: (name) => request('POST', '/api/people', { name }),
  person: (id) => request('GET', `/api/people/${id}`),
  save: (personId, week, blocks, cant = false) => request('PUT', '/api/availability', { personId, week, blocks, cant }),
  clear: (personId, week) => request('DELETE', `/api/availability?personId=${personId}&week=${week}`),
  addRule: (rule) => request('POST', '/api/recurring', rule),
  delRule: (id) => request('DELETE', `/api/recurring/${id}`),
  admin: {
    check: () => request('GET', '/api/admin/check', undefined, A()),
    lock: (week) => request('POST', '/api/admin/lock', { week }, A()),
    unlock: (week) => request('POST', '/api/admin/unlock', { week }, A()),
    announce: (type, week) => request('POST', '/api/admin/announce', { type, week }, A()),
    testDiscord: () => request('POST', '/api/admin/test-discord', {}, A()),
    rename: (id, name) => request('PATCH', `/api/people/${id}`, { name }),
    remove: (id) => request('DELETE', `/api/admin/people/${id}`, undefined, A()),
  },
};
