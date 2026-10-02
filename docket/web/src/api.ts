import { fmtMoment, iso } from './format';
import type { PendingRequest, State, Task } from './types';

const TOKEN_KEY = 'docket-token';

export function getToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t: string) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

/**
 * Finds a one-time token in `#token=…` (preferred: fragments never reach the server or its logs)
 * or `?token=…`, and returns the URL parts without it. Decodes with decodeURIComponent, not
 * form rules, so a raw "+" in a base64 token stays "+".
 */
export function tokenFromUrl(search: string, hash: string): { token: string | null; search: string; hash: string } {
  let token: string | null = null;
  const take = (parts: string[]) => parts.filter(p => {
    if (!p.startsWith('token=')) return true;
    try { token ??= decodeURIComponent(p.slice(6)) || null; } catch { token ??= p.slice(6) || null; }
    return false;
  });
  const h = take(hash.replace(/^#/, '').split('&').filter(Boolean));
  const q = take(search.replace(/^\?/, '').split('&').filter(Boolean));
  return { token, search: q.length ? '?' + q.join('&') : '', hash: h.length ? '#' + h.join('&') : '' };
}

/** Saves a token from the URL and removes it from the address bar and history. */
export function initToken() {
  const r = tokenFromUrl(location.search, location.hash);
  if (r.token) {
    setToken(r.token);
    history.replaceState(null, '', location.pathname + r.search + r.hash);
  }
}

export class AuthError extends Error {}
/** A non-2xx answer; `status` lets a caller tell "route missing" (404 on an older server) apart. */
export class HttpError extends Error { constructor(msg: string, readonly status: number) { super(msg); } }
export const NEWER = 'This needs a newer Docket server (404).';
/** The request never reached Docket (offline, DNS, server down). */
export class NetError extends Error {}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method,
      cache: 'no-store',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetError("Can't reach Docket. Check your connection.");
  }
  if (res.status === 401) throw new AuthError("That token didn't work.");
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // A 404 without a specific message (HTML, or the API's catch-all "Not found") means the
    // route doesn't exist yet: the server is older than this app.
    const generic = res.status === 404 && (!data?.error || data.error === 'Not found');
    throw new HttpError(generic ? NEWER : data?.error || `Docket error ${res.status}.`, res.status);
  }
  return (data ?? {}) as T;
}

export const getState = async () => normalizeState(await api<unknown>('GET', '/state'));

/** Saves a file from the API (the token goes in a header, so a plain link can't do it). */
export async function download(path: string, name: string) {
  const token = getToken();
  let res: Response;
  try { res = await fetch('/api' + path, { headers: token ? { authorization: 'Bearer ' + token } : {} }); }
  catch { throw new NetError("Can't reach Docket. Check your connection."); }
  if (res.status === 401) throw new AuthError("That token didn't work.");
  if (!res.ok) throw new HttpError(res.status === 404 ? NEWER : `Docket error ${res.status}.`, res.status);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const arr = <T>(v: unknown, f: (x: any) => T): T[] => (Array.isArray(v) ? v.map(f) : []);
const orNull = <T>(v: T | undefined | null): T | null => (v === undefined || v === null ? null : v);

function task(x: any): Task {
  return {
    ...x,
    project: orNull(x.project), due: orNull(x.due), source: orNull(x.source), draft: orNull(x.draft), gmail_draft_id: orNull(x.gmail_draft_id),
    notes: orNull(x.notes), link: orNull(x.link), result: orNull(x.result), result_url: orNull(x.result_url), result_at: orNull(x.result_at),
    origin_kind: orNull(x.origin_kind), origin_title: orNull(x.origin_title), origin_url: orNull(x.origin_url),
    // 0.4.0 fields; a 0.3 server sends none of them.
    at: typeof x.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x.at) ? x.at : null,
    repeat: typeof x.repeat === 'string' && x.repeat ? x.repeat : null,
    repeat_from: x.repeat_from === 'done' ? 'done' : 'planned', series_id: orNull(x.series_id),
    completed_at: orNull(x.completed_at), done: !!x.done, est: Number(x.est) || 0,
    steps: arr(x.steps, (s: any) => ({ text: String(s?.text ?? ''), done: !!s?.done })),
    created_at: x.created_at ?? '', updated_at: x.updated_at ?? '',
  };
}
function request(x: any, seenDefault: boolean): PendingRequest {
  return {
    ...x, task_id: orNull(x.task_id), priority: x.priority ?? 'high', override: !!x.override, status: x.status ?? 'pending',
    reply: orNull(x.reply), outcome: orNull(x.outcome), detail: orNull(x.detail), seen: x.seen === undefined ? seenDefault : !!x.seen,
    completed_at: orNull(x.completed_at), created_at: x.created_at ?? '', origin: x.origin && typeof x.origin === 'object' ? x.origin : null,
  };
}

/** Fills fields an older server (0.2.0, 0.3) does not send, so the app never crashes on them. */
export function normalizeState(raw: any): State {
  const r = raw ?? {};
  const u = r.usage ?? {}, st = r.settings ?? {};
  const used = Number(u.used_pct) || 0;
  const est = Number(u.est_pct ?? u.estimated_used_pct ?? used) || 0;
  const reserve = Number(u.reserve_pct ?? st.reserve_pct ?? 0);
  const highOnly = !!(u.high_only ?? st.high_only);
  const atReserve = u.at_reserve ?? (highOnly && 100 - used <= reserve);
  let tz = r.tz;
  if (!tz) try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = 'UTC'; }
  return {
    today: r.today ?? iso(new Date()),
    now: r.now ?? new Date().toISOString(),
    tz,
    tasks: arr(r.tasks, task),
    moves: arr(r.moves, (m: any) => ({ ...m, reason: m.reason ?? '' })),
    held: arr(r.held, (h: any) => ({ ...h, task_id: orNull(h.task_id), priority: h.priority ?? 'low' })),
    requests: arr(r.requests, (x: any) => request(x, true)),
    recent: arr(r.recent, (x: any) => request(x, true)),
    usage: {
      period_start: u.period_start ?? '', resets_at: u.resets_at ?? '', resets_label: u.resets_label ?? (u.resets_at ? fmtMoment(u.resets_at) : ''),
      used_pct: used, left_pct: u.left_pct ?? 100 - used, updated_at: orNull(u.updated_at), source: orNull(u.source),
      est_pct: est, estimated: u.estimated ?? est !== used, calls_since_reset: Number(u.calls_since_reset) || 0,
      reserve_pct: reserve, high_only: highOnly, at_reserve: !!atReserve,
      near_reserve: !!(u.near_reserve ?? (highOnly && !atReserve && 100 - est <= reserve)),
    },
    settings: {
      capacity_hours: Number(st.capacity_hours) || 6, reserve_pct: Number(st.reserve_pct ?? reserve), high_only: !!st.high_only,
      week_start: st.week_start ?? 'Mon', reset: st.reset ?? 'Mon 09:00', pct_per_call: Number(st.pct_per_call) || 0,
      claude_url: st.claude_url || 'https://claude.ai/new',
    },
    emails: arr(r.emails, (e: any) => e),
    finds: arr(r.finds, (f: any) => f),
    review: r.review ?? null,
    week_plan: r.week_plan ?? null,
    reset_notice: r.reset_notice ?? null,
    last_cmd: r.last_cmd ?? '',
    reply: r.reply ?? '',
    reply_at: orNull(r.reply_at),
    inbox_checked_at: orNull(r.inbox_checked_at),
    deleted: arr(r.deleted, (x: any) => ({ id: String(x.id), title: String(x.title ?? ''), day: x.day ?? '', area: x.area ?? 'Work', deleted_at: x.deleted_at ?? '' })),
    // Feature check, not a version check: only a server that soft-deletes sends `deleted`.
    // (A cached, already normalized state carries flags.trash, which wins.)
    flags: { sample: !!r.flags?.sample, trash: typeof r.flags?.trash === 'boolean' ? r.flags.trash : Array.isArray(r.deleted) },
    version: r.version ?? '',
  };
}

/**
 * Wraps an async function so concurrent calls share one run, and a call that arrives while it
 * is running triggers exactly one more run afterwards (latest wins: everyone gets that result).
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  let again = false;
  return () => {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        let out!: T, err: unknown, ok = false;
        do {
          again = false;
          try { out = await fn(); ok = true; } catch (e) { err = e; ok = false; }
        } while (again);
        if (!ok) throw err;
        return out;
      } finally { running = null; }
    })();
    return running;
  };
}

export type LiveStatus = 'open' | 'closed' | 'auth';

/**
 * Server-sent events read with fetch, so the token goes in the Authorization header instead of
 * the URL. Calls onChange on every change event and after each (re)connect, in case changes were
 * missed; reconnects with backoff from 1 s to 30 s; drops a silent connection after 60 s (the
 * server pings every 25 s, so silence means a dead socket, e.g. after the phone slept).
 */
export function subscribe(onChange: () => void, onStatus?: (s: LiveStatus) => void): () => void {
  let stopped = false, delay = 1000, retry: ReturnType<typeof setTimeout> | undefined;
  let ctl: AbortController | null = null;
  const run = async () => {
    if (stopped) return;
    ctl = new AbortController();
    const c = ctl;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const kick = () => { clearTimeout(watchdog); watchdog = setTimeout(() => c.abort(), 60000); };
    try {
      const token = getToken();
      const res = await fetch('/api/events', { signal: c.signal, cache: 'no-store', headers: { accept: 'text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) } });
      if (res.status === 401) { onStatus?.('auth'); return; }
      if (!res.ok || !res.body) throw new Error('events ' + res.status);
      delay = 1000;
      onStatus?.('open');
      onChange();
      kick();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kick();
        buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event:\s*change\s*$/m.test(block)) onChange();
        }
      }
    } catch { /* network error, abort or watchdog: reconnect below */ }
    finally { clearTimeout(watchdog); }
    if (stopped) return;
    onStatus?.('closed');
    retry = setTimeout(run, delay);
    delay = Math.min(30000, delay * 2);
  };
  run();
  return () => { stopped = true; clearTimeout(retry); ctl?.abort(); };
}
