import type { State } from './types';

const TOKEN_KEY = 'docket-token';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ }
}

// A one-time ?token= in the URL (e.g. opened from a bookmark on the phone) is saved and removed.
const fromUrl = new URLSearchParams(location.search).get('token');
if (fromUrl) {
  setToken(fromUrl);
  history.replaceState(null, '', location.pathname + location.hash);
}

export class AuthError extends Error {}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch('/api' + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('Unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data as T;
}

export const getState = () => api<State>('GET', '/state');

export function subscribe(onChange: () => void): () => void {
  const token = getToken();
  const es = new EventSource('/api/events' + (token ? '?token=' + encodeURIComponent(token) : ''));
  es.addEventListener('change', onChange);
  // Refetch after a reconnect in case changes were missed.
  es.onopen = onChange;
  return () => es.close();
}
