import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthError, api, getState, setToken, subscribe } from './api';
import { DocketCtx, type AskOpts, type Ctx, type Screen } from './ctx';
import type { State, Task } from './types';
import { Sidebar } from './screens/Sidebar';
import { Today } from './screens/Today';
import { Week } from './screens/Week';
import { Inbox } from './screens/Inbox';
import { Usage } from './screens/Usage';
import { Panel, TabBar } from './screens/Panel';

const SCREENS: Screen[] = ['today', 'week', 'inbox', 'usage'];
const hashScreen = (): Screen => {
  const h = location.hash.slice(1) as Screen;
  return SCREENS.includes(h) ? h : 'today';
};

function useWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

export function App() {
  const [s, setS] = useState<State | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [screen, setScreen] = useState<Screen>(hashScreen);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<number | undefined>(undefined);
  const lastReplyAt = useRef<string | null | undefined>(undefined);
  const wide = useWidth() >= 1000;

  const refresh = useCallback(async () => {
    try {
      const next = await getState();
      setS(next);
      setNeedToken(false);
      setLoadError('');
      return next;
    } catch (e) {
      if (e instanceof AuthError) setNeedToken(true);
      else setLoadError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => (needToken ? undefined : subscribe(() => { refresh(); })), [needToken, refresh]);
  useEffect(() => {
    const on = () => setScreen(hashScreen());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const flash = useCallback((msg: string) => {
    if (wide || sheet) return;
    window.clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = window.setTimeout(() => setToast(''), 6000);
  }, [wide, sheet]);

  // When Claude finishes a queued request, show its reply as a toast on the phone.
  useEffect(() => {
    if (!s) return;
    if (lastReplyAt.current !== undefined && s.reply_at && s.reply_at !== lastReplyAt.current) flash(s.reply);
    lastReplyAt.current = s.reply_at;
  }, [s, flash]);

  const ctx = useMemo<Ctx | null>(() => {
    if (!s) return null;
    const act = async (method: string, path: string, body?: unknown) => {
      try {
        await api(method, path, body);
      } catch (e) {
        if (e instanceof AuthError) { setNeedToken(true); return; }
        flash(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    };
    const ask = async (prompt: string, o: AskOpts) => {
      try {
        const r = await api<{ status: 'pending' | 'held' }>('POST', '/requests', { prompt, label: o.label, priority: o.priority, task_id: o.taskId });
        flash(r.status === 'held' ? 'Held until reset: ' + o.label : 'Queued for Claude: ' + o.label);
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    };
    return {
      s, wide, screen,
      go: sc => { location.hash = sc; setScreen(sc); setSheet(false); window.scrollTo(0, 0); },
      act, ask,
      patchTask: (t: Task, p: Partial<Task>) => act('PATCH', '/tasks/' + t.id, p),
      openSheet: () => { setSheet(true); setToast(''); },
      flash,
    };
  }, [s, wide, screen, refresh, flash]);

  if (needToken) return <SignIn onSave={t => { setToken(t); refresh(); }} />;
  if (!ctx) return <div className="signin"><div className="muted-line">{loadError ? 'Can\'t reach Docket: ' + loadError : 'Loading…'}</div></div>;

  return (
    <DocketCtx.Provider value={ctx}>
      <div className={'app ' + (wide ? 'wide' : 'narrow')}>
        {wide && <Sidebar />}
        <main className="main">
          <div className="content">
            {screen === 'today' && <Today />}
            {screen === 'week' && <Week />}
            {screen === 'inbox' && <Inbox />}
            {screen === 'usage' && <Usage />}
          </div>
        </main>
        {!wide && sheet && <div className="backdrop" onClick={() => setSheet(false)} />}
        <Panel open={wide || sheet} onClose={() => setSheet(false)} />
        {!wide && !sheet && toast && <div className="toast" onClick={ctx.openSheet}>{toast}</div>}
        {!wide && <TabBar />}
      </div>
    </DocketCtx.Provider>
  );
}

function SignIn({ onSave }: { onSave: (t: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="signin">
      <form className="card" onSubmit={e => { e.preventDefault(); if (v.trim()) onSave(v.trim()); }}>
        <div className="brand" style={{ margin: 0 }}>Docket</div>
        <div className="hint" style={{ marginTop: 0 }}>Enter the token you set as DOCKET_TOKEN on the server.</div>
        <input type="password" autoComplete="current-password" value={v} onChange={e => setV(e.target.value)} placeholder="Token" autoFocus />
        <button className="btn ink big" type="submit">Open</button>
      </form>
    </div>
  );
}
