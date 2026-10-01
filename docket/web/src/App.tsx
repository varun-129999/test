import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AuthError, NetError, api, coalesce, getState, getToken, normalizeState, setToken, subscribe, type LiveStatus } from './api';
import { DocketCtx, finished, isStandalone, parseRoute, rememberArea, type Ctx, type NotifyOpts, type Route, type Screen } from './ctx';
import { fmtDay, fmtDur, hhmm, todayIn } from './format';
import type { AskSpec } from './prompts';
import type { QueueResult, State, Task, TaskInput, TaskPatch } from './types';
import { Sidebar } from './screens/Sidebar';
import { Today } from './screens/Today';
import { Week } from './screens/Week';
import { Inbox } from './screens/Inbox';
import { Usage } from './screens/Usage';
import { Panel, TabBar, type PanelHandle } from './screens/Panel';
import { ToastView, type Toast } from './screens/parts';

function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

// The last good state, so a cold start without a connection still shows the tasks (read-mostly).
const CACHE_KEY = 'docket-state';
const loadCache = (): { s: State; at: number } | null => {
  try { const j = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); return j?.s ? { s: normalizeState(j.s), at: Number(j.at) || 0 } : null; } catch { return null; }
};
const saveCache = (s: State) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ s, at: Date.now() })); } catch { /* full or private mode */ } };
const clearCache = () => { try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ } };

export function App() {
  const [s, setS] = useState<State | null>(null);
  const [auth, setAuth] = useState<'ok' | 'need' | 'failed'>('ok');
  const [loadError, setLoadError] = useState('');
  const [stale, setStale] = useState<{ msg: string } | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [q, setQ] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const notified = useRef(new Set<string>());
  const sRef = useRef<State | null>(null);
  sRef.current = s;
  const panel = useRef<PanelHandle | null>(null);
  const wide = useWidth() >= 1000;

  // The time of the last good data, for the offline bar.
  const goodAt = useRef(0);
  // One refresh at a time; calls that arrive meanwhile share one more run (latest wins).
  const refresh = useMemo(() => coalesce(async () => {
    try {
      const next = await getState();
      goodAt.current = Date.now();
      setS(next);
      setAuth('ok');
      setLoadError('');
      setStale(null);
      saveCache(next);
      return next;
    } catch (e) {
      if (e instanceof AuthError) setAuth(getToken() ? 'failed' : 'need');
      else {
        const msg = e instanceof Error ? e.message : String(e);
        setLoadError(msg);
        if (!sRef.current) { const c = loadCache(); if (c) { setS(c.s); goodAt.current = c.at; } }
        if (sRef.current || goodAt.current) setStale({ msg: e instanceof NetError ? '' : msg });
      }
      return null;
    }
  }), []);

  const notify = useCallback((msg: string, o: NotifyOpts = {}) => {
    window.clearTimeout(toastTimer.current);
    const kind = o.kind ?? 'info';
    setToast({ id: Date.now(), msg, kind, action: o.action });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 10000 : o.action ? 8000 : 5000);
  }, []);

  const openSheet = useCallback((o: { recent?: boolean } = {}) => {
    setSheet(true);
    if (o.recent) panel.current?.showRecent();
  }, []);

  // The hero mic: show the sheet synchronously so the composer can take focus inside the tap
  // (iOS only opens the keyboard, and only allows speech, from the gesture itself).
  const mic = useCallback(() => {
    flushSync(() => setSheet(true));
    panel.current?.listen();
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (auth !== 'ok') return;
    let was: LiveStatus | '' = '';
    return subscribe(() => { refresh(); }, st => {
      // A dropped stream may mean the network went away: check, so the offline bar appears.
      if ((st === 'closed' && was === 'open') || st === 'auth') refresh();
      was = st;
    });
  }, [auth, refresh]);
  useEffect(() => {
    const on = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); refresh(); } };
    document.addEventListener('visibilitychange', on);
    window.addEventListener('focus', on);
    return () => { document.removeEventListener('visibilitychange', on); window.removeEventListener('focus', on); };
  }, [refresh]);
  // Every minute: re-render time-based text, and refetch once when the server's day has rolled over.
  const rolled = useRef('');
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
      const cur = sRef.current;
      if (!cur) return;
      const day = todayIn(cur.tz);
      if (day !== cur.today && rolled.current !== day) { rolled.current = day; refresh(); }
    }, 60000);
    return () => window.clearInterval(id);
  }, [refresh]);
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!sheet || wide) return;
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(false); };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [sheet, wide]);

  // Results Claude finished while the app was closed (or since the last refresh).
  useEffect(() => {
    if (!s) return;
    const done = finished(s.recent);
    const fresh = done.filter(r => !r.seen && !notified.current.has(r.id));
    if (!fresh.length) return;
    fresh.forEach(r => notified.current.add(r.id));
    const unseen = done.filter(r => !r.seen);
    notify(unseen.length === 1 ? 'Claude finished: ' + unseen[0].label : `Claude finished ${unseen.length} things`, { action: { label: 'View', run: () => openSheet({ recent: true }) } });
  }, [s, notify, openSheet]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!s) return null;
    const fail = (e: unknown) => {
      if (e instanceof AuthError) { setAuth('failed'); return; }
      notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
    };
    const run = async <T,>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data?: T }> => {
      try {
        const data = await api<T>(method, path, body);
        await refresh();
        return { ok: true, data };
      } catch (e) {
        fail(e);
        await refresh();
        return { ok: false };
      }
    };
    const go = (sc: Screen, arg?: string) => {
      const h = arg ? sc + '/' + arg : sc;
      if (location.hash.slice(1) !== h) location.hash = h;
      setRoute(parseRoute('#' + h));
      setSheet(false);
      window.scrollTo(0, 0);
    };
    const optimistic = (fn: (st: State) => State) => setS(prev => (prev ? fn(prev) : prev));
    const act = async (m: string, p: string, b?: unknown) => (await run(m, p, b)).ok;
    const ask = async (q: AskSpec) => {
      try {
        const r = await api<QueueResult>('POST', '/requests', { prompt: q.prompt, label: q.label, priority: q.priority, task_id: q.taskId });
        await refresh();
        if (r.status === 'held') notify(`You're at your reserve, so "${q.label}" waits under Usage.`, { action: { label: 'View', run: () => go('usage') } });
        else {
          // The same request already waiting takes the newest wording, so say which happened.
          const before = r.existing ? s.requests.find(x => x.id === r.request.id) : undefined;
          const lead = !r.existing ? 'Ready for Claude: ' : before && before.prompt !== r.request.prompt ? 'Updated what Claude will do: ' : 'Already waiting for Claude: ';
          const task = q.taskId ? s.tasks.find(x => x.id === q.taskId) : undefined;
          notify(lead + q.label.replace(/^Give to Claude: /, ''), { action: task?.origin_url ? { continue: r.request.id } : 'open-claude' });
        }
      } catch (e) {
        fail(e);
        await refresh();
      }
    };
    return {
      s, wide, route, now, q, setQ, go, act, ask, optimistic, openSheet, mic, notify,
      call: async <T,>(m: string, p: string, b?: unknown) => (await run<T>(m, p, b)).data,
      patchTask: (t: Task, p: TaskPatch) => {
        // The task stores its origin flat; the patch sends it as one object.
        const { origin, ...rest } = p;
        const flat = origin !== undefined ? { origin_kind: origin?.kind ?? null, origin_title: origin?.title ?? null, origin_url: origin?.url ?? null } : {};
        optimistic(st => ({ ...st, tasks: st.tasks.map(x => (x.id === t.id ? ({ ...x, ...rest, ...flat } as Task) : x)) }));
        return act('PATCH', '/tasks/' + t.id, p);
      },
      addTask: async (t: TaskInput, o: { quiet?: boolean } = {}) => {
        const out = (await run<Task>('POST', '/tasks', t)).data;
        if (out) {
          rememberArea(t.area);
          if (!o.quiet) notify(`Added: ${out.title} · ${out.day === s.today ? 'Today' : fmtDay(out.day)} · ${fmtDur(out.est)}`);
        }
        return out;
      },
      signOut: () => { setToken(''); clearCache(); setS(null); setAuth('need'); },
    };
  }, [s, wide, route, now, q, refresh, notify, openSheet, mic]);

  if (auth !== 'ok') return <SignIn failed={auth === 'failed'} onSave={async t => { setToken(t); await refresh(); }} />;
  if (!ctx) {
    return (
      <div className="signin">
        <div className="muted-line" style={{ textAlign: 'center' }}>
          {loadError ? <>{loadError.startsWith("Can't reach") ? "Can't reach Docket. Retrying…" : "Can't load Docket: " + loadError}<div style={{ marginTop: 12 }}><button className="btn" onClick={() => refresh()}>Retry</button></div></> : 'Loading…'}
        </div>
      </div>
    );
  }

  const screen = route.screen;
  return (
    <DocketCtx.Provider value={ctx}>
      <div className={'app ' + (wide ? 'wide' : 'narrow')}>
        {wide && <Sidebar />}
        <main className="main">
          <div className="content">
            {stale && (
              <div className="offline-bar" role="status">
                <span className="text">{stale.msg ? `${stale.msg} Showing` : 'Offline, showing'} data from {hhmm(goodAt.current)}.</span>
                <button className="btn slim" onClick={() => refresh()}>Retry</button>
              </div>
            )}
            {screen === 'today' && <Today />}
            {screen === 'week' && <Week />}
            {screen === 'inbox' && <Inbox />}
            {screen === 'usage' && <Usage />}
          </div>
        </main>
        {!wide && sheet && <div className="backdrop" onClick={() => setSheet(false)} />}
        <Panel ref={panel} open={wide || sheet} onClose={() => setSheet(false)} note={!wide && sheet ? toast : null} onNoteClose={() => setToast(null)} />
        {toast && (wide || !sheet) && <ToastView key={toast.id} t={toast} where={wide ? 'wide' : 'phone'} onClose={() => setToast(null)} />}
        {!wide && <TabBar />}
      </div>
    </DocketCtx.Provider>
  );
}

function SignIn({ failed, onSave }: { failed: boolean; onSave: (t: string) => Promise<void> }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const standalone = isStandalone();
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); if (t) setV(t.trim()); } catch { /* the owner can still type it */ }
  };
  return (
    <div className="signin">
      <form className="card" onSubmit={async e => { e.preventDefault(); if (!v.trim() || busy) return; setBusy(true); await onSave(v.trim()); setBusy(false); }}>
        <div className="brand" style={{ margin: 0 }}>Docket</div>
        <div className="hint" style={{ marginTop: 0 }}>
          {standalone ? 'Paste your token once. Find it in Render › Environment › DOCKET_TOKEN.' : 'Enter the token you set as DOCKET_TOKEN on the server.'}
        </div>
        <div className="signin-field">
          <input type="password" autoComplete="current-password" value={v} onChange={e => setV(e.target.value)} placeholder="Token" aria-label="Token" autoFocus={!standalone} />
          {standalone && <button type="button" className="btn" onClick={paste}>Paste</button>}
        </div>
        {failed && !busy && <div className="err" role="alert">That token didn't work.</div>}
        <button className="btn ink big" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Open'}</button>
      </form>
    </div>
  );
}
