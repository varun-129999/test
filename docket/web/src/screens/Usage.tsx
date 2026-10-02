import { useEffect, useRef, useState } from 'react';
import { AuthError, HttpError, api, download } from '../api';
import { AREA, derive, useDocket } from '../ctx';
import { DOWL, ago, fmtDay, plural } from '../format';

const USAGE_URL = 'https://claude.ai/settings/usage';

/** A slider's value while dragging, saved once the owner stops. Server updates don't fight the drag. */
function useLive(value: number, onCommit: (v: number) => Promise<unknown>) {
  const [v, setV] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => { if (!busy.current) setV(value); }, [value]);
  const change = (n: number) => {
    setV(n);
    busy.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { onCommit(n).finally(() => { busy.current = false; }); }, 350);
  };
  return [v, change] as const;
}

function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  return <input type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} style={{ marginTop: 12 }} />;
}

export function Usage() {
  const { s, act, call, notify, now, signOut } = useDocket();
  const d = derive(s);
  const u = s.usage, st = s.settings;
  const [usedV, setUsed] = useLive(u.used_pct, v => act('PUT', '/usage', { used_pct: v, source: 'owner' }));
  const [reserveV, setReserve] = useLive(st.reserve_pct, v => act('PATCH', '/settings', { reserve_pct: v }));
  const [capV, setCap] = useLive(st.capacity_hours, v => act('PATCH', '/settings', { capacity_hours: v }));
  const used = d.used, left = d.left, est = Math.max(d.est, used);
  const heldPct = st.high_only ? Math.min(st.reserve_pct, left) : 0;

  // Cells: reported use in ink, the estimate on top of it hatched, the reserve outlined.
  const cells: string[] = [];
  let nFree = 0;
  for (let i = 0; i < 100; i++) {
    const held = i >= 100 - heldPct;
    const c = i < used ? 'used' : i < est ? 'est' + (held ? ' held' : '') : held ? 'held' : 'free';
    if (c === 'free') nFree++;
    cells.push(c);
  }

  const ps = new Date(u.period_start).getTime(), reset = new Date(u.resets_at).getTime();
  const valid = Number.isFinite(ps) && Number.isFinite(reset) && reset > ps;
  const hrsLeft = valid ? Math.max(0, (reset - now) / 36e5) : 0;
  let pace = '';
  if (valid) {
    const elapsed = Math.max(0.02, (now - ps) / (reset - ps));
    const rate = est / elapsed;
    if (rate > 100) {
      const out = new Date(ps + (100 / rate) * (reset - ps)), hh = out.getHours();
      pace = 'At this pace you run out ' + DOWL[out.getDay()] + (hh < 12 ? ' morning' : hh < 18 ? ' afternoon' : ' evening') + '.';
    } else pace = 'At this pace you finish the week with about ' + Math.round(100 - rate) + '% left.';
  }
  const reported = !u.updated_at ? 'Not reported yet this week'
    : u.source === 'statusline' ? 'Synced from Claude Code ' + ago(u.updated_at, now)
    : 'You reported ' + ago(u.updated_at, now);
  const countdown = valid ? (hrsLeft >= 24 ? Math.floor(hrsLeft / 24) + ' days ' : '') + Math.floor(hrsLeft % 24) + ' hours' : '';

  const [url, setUrl] = useState(st.claude_url);
  useEffect(() => setUrl(st.claude_url), [st.claude_url]);
  const notice = s.reset_notice;

  return (
    <>
      <div className="eyebrow">Claude this week</div>
      <div className="big-num"><span className="n">{left}%</span><span className="l">left</span></div>
      <div className="sub" style={{ marginTop: 4 }}>{[reported, u.resets_label && 'Resets ' + u.resets_label, countdown].filter(Boolean).join(' · ')}</div>
      {u.estimated && est > used && <div className="est-line">About {100 - est}% now, estimated from Docket calls.</div>}
      {pace && <div style={{ fontSize: 15, marginTop: 10 }}>{pace}</div>}
      {notice && (
        <div className="banner">
          <span className="dot" />
          <div className="text">Your budget reset. {plural(notice.n, 'request')} {notice.n === 1 ? 'was' : 'were'} waiting.</div>
          <button className="btn slim" onClick={() => act('POST', '/reset-notice/dismiss')}>Dismiss</button>
          <button className="btn ink" onClick={async () => { const r = await call<{ queued: number }>('POST', '/held/queue-all'); if (r) notify(`Ready for Claude: ${plural(r.queued, 'request')}`, { action: 'open-claude' }); }}>Queue all</button>
        </div>
      )}
      {u.near_reserve && (
        <div className="banner">
          <span className="dot" />
          <div className="text">The estimate says you may be at your reserve. Check claude.ai/settings/usage and update the figure below.</div>
          <a className="btn ink" style={{ textDecoration: 'none' }} href={USAGE_URL} target="_blank" rel="noreferrer">Check</a>
        </div>
      )}
      <div className="cells" aria-hidden="true">
        {cells.map((c, i) => <div key={i} className={'cell ' + c} />)}
      </div>
      <div className="cell-legend">
        <span><i style={{ background: 'var(--ink)' }} />Reported {used}%</span>
        {est > used && <span><i className="hatch" />Estimated since +{est - used}%</span>}
        <span><i style={{ background: 'var(--chip)' }} />Free {nFree}%</span>
        <span><i style={{ boxShadow: 'inset 0 0 0 1.5px var(--accent)' }} />Held for high priority {heldPct}%</span>
      </div>
      <div className="usage-cards">
        <div className="card">
          <div className="kv"><span>Used so far</span><span>{usedV}%</span></div>
          <Slider label="Used so far" min={0} max={100} value={usedV} onChange={setUsed} />
          <div className="hint">
            Copy it from <a href={USAGE_URL} target="_blank" rel="noreferrer">claude.ai/settings/usage</a>, or say "I've used 65%". {u.updated_at ? 'Updated ' + ago(u.updated_at, now) + '.' : 'Not set yet this week.'} Claude has called Docket {plural(u.calls_since_reset, 'time')} since the reset.
          </div>
        </div>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Save for high priority</div>
            <button className={'toggle' + (st.high_only ? ' on' : '')} role="switch" aria-checked={st.high_only} aria-label="Save for high priority" onClick={() => act('PATCH', '/settings', { high_only: !st.high_only })}><i /></button>
          </div>
          <div className="kv small"><span>Keep back</span><span>{reserveV}%</span></div>
          <Slider label="Keep back" min={0} max={50} value={reserveV} onChange={setReserve} />
          <div className="hint">When only this much is left, below-high requests wait until the reset.</div>
        </div>
        <div className="card">
          <div className="kv"><span>Free time per day</span><span>{capV}h</span></div>
          <Slider label="Free time per day" min={2} max={12} step={0.5} value={capV} onChange={setCap} />
          <div className="hint">The capacity line on Today and Week.</div>
        </div>
      </div>
      <h2 className="section-title">Waiting for budget</h2>
      {s.held.map(h => (
        <div key={h.id} className="held-row">
          <span className="t">{h.label}</span>
          <button className="btn slim" onClick={() => act('DELETE', '/held/' + h.id)}>Remove</button>
          <button className="btn ink" onClick={async () => {
            const r = await call<{ applied: boolean }>('POST', `/held/${h.id}/run`);
            if (r) notify(r.applied ? 'Applied what Claude had already written.' : 'Ready for Claude: ' + h.label, r.applied ? {} : { action: 'open-claude' });
          }}>Run anyway</button>
        </div>
      ))}
      {s.held.length === 0 && <div className="muted-line">Nothing held.</div>}
      <h2 className="section-title">Open Claude at</h2>
      <form className="row-gap" style={{ alignItems: 'center' }} onSubmit={e => { e.preventDefault(); act('PATCH', '/settings', { claude_url: url }); }}>
        <input className="url-in" value={url} onChange={e => setUrl(e.target.value)} aria-label="Claude link" />
        <button className="btn" type="submit" disabled={url === st.claude_url}>Save</button>
      </form>
      <div className="hint">Paste your Docket project's link so "Open Claude" starts there. The default opens a new chat.</div>
      <h2 className="section-title">Calendar</h2>
      <FeedCard />
      <h2 className="section-title">Recently deleted</h2>
      <Deleted />
      <div className="usage-foot">
        <span>Docket{s.version ? ' ' + s.version : ''} · times in {s.tz}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => download('/backup', `docket-${s.today}.db`).catch(e => notify(e instanceof Error ? e.message : String(e), { kind: 'error' }))}>Download backup</button>
        {s.flags.sample && (
          <button className="btn" onClick={() => { if (confirm('Replace all your tasks with the sample data?')) act('POST', '/sample', { confirm: 'wipe' }); }}>Reset to sample data</button>
        )}
        <button className="btn" onClick={() => { if (confirm('Sign out of Docket on this device?')) signOut(); }}>Sign out</button>
      </div>
    </>
  );
}

/** The calendar feed: a private .ics link Apple Calendar (or any calendar) subscribes to. */
function FeedCard() {
  const { notify } = useDocket();
  const [f, setF] = useState<{ state: 'loading' | 'ready' | 'old' | 'error'; url: string | null; msg?: string }>({ state: 'loading', url: null });
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = () => {
    let live = true;
    api<{ url?: string | null }>('GET', '/feed').then(
      r => { if (live) setF({ state: 'ready', url: r.url ?? null }); },
      e => { if (live) setF(e instanceof HttpError && e.status === 404 ? { state: 'old', url: null } : { state: 'error', url: null, msg: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { live = false; };
  };
  useEffect(load, []);
  const run = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    try {
      const r = await api<{ url?: string | null }>(method, '/feed');
      setF({ state: 'ready', url: method === 'POST' ? r.url ?? null : null });
      if (method === 'DELETE') notify('Calendar link revoked. Subscriptions to it stop updating.');
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) setF({ state: 'old', url: null });
      if (!(e instanceof AuthError)) notify(e instanceof Error ? e.message : String(e), { kind: 'error' });
    }
    setBusy(false);
  };
  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }, () => notify("Couldn't copy. Select the link instead.", { kind: 'error' }));
  };
  const url = f.url;
  return (
    <div className="card feed-card">
      <div className="head">Show Docket in your calendar</div>
      {f.state === 'old' ? <div className="hint" style={{ marginTop: 0 }}>Calendar links need Docket 0.5 on the server.</div>
        : f.state === 'error' ? <div className="row-gap" style={{ alignItems: 'center' }}><span className="hint" style={{ marginTop: 0, flex: 1 }}>{f.msg}</span><button className="btn slim" onClick={() => { setF({ state: 'loading', url: null }); load(); }}>Retry</button></div>
        : f.state === 'loading' ? <div className="hint" style={{ marginTop: 0 }}>Loading…</div>
        : <>
          <div className="hint" style={{ marginTop: 0 }}>A private link your calendar subscribes to: tasks from a week ago to two months ahead, timed ones at their time, the rest as all-day. Anyone with the link can read your tasks, so keep it to yourself. Revoke turns it off.</div>
          {url && <input className="url-in" readOnly value={url} aria-label="Calendar link" onFocus={e => e.currentTarget.select()} />}
          <div className="row-gap">
            {url ? <>
              <a className="btn ink" style={{ textDecoration: 'none' }} href={url.replace(/^https?:/i, 'webcal:')}>Subscribe</a>
              <button className="btn" onClick={() => copy(url)}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="btn danger" disabled={busy} onClick={() => { if (confirm('Revoke this calendar link? Calendars subscribed to it stop updating. You can make a new link any time.')) run('DELETE'); }}>Revoke</button>
            </> : <button className="btn ink" disabled={busy} onClick={() => run('POST')}>{busy ? 'Creating…' : 'Create link'}</button>}
          </div>
          <ol>
            <li>iPhone: Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar, and paste the link.</li>
            <li>Mac Calendar: File → New Calendar Subscription, and paste the link.</li>
          </ol>
        </>}
    </div>
  );
}

/** Tasks deleted in the last 30 days (a 0.5 server keeps them), with Restore and Delete forever. */
function Deleted() {
  const { s, act, optimistic, notify, now } = useDocket();
  if (!s.flags.trash) return <div className="muted-line">Recently deleted needs Docket 0.5 on the server. Until then, deleting a task is permanent.</div>;
  const drop = (id: string) => optimistic(st => ({ ...st, deleted: st.deleted.filter(d => d.id !== id) }));
  return (
    <>
      {s.deleted.map(x => (
        <div key={x.id} className="deleted-row">
          <span className="sq" style={{ background: (AREA[x.area] ?? AREA.Work).c }} />
          <div className="t">{x.title || 'Untitled'}<span className="m">{x.day ? fmtDay(x.day) + ' · ' : ''}deleted {ago(x.deleted_at, now)}</span></div>
          <div className="acts">
            <button className="btn slim" onClick={async () => { drop(x.id); if (await act('POST', `/tasks/${x.id}/restore`)) notify('Restored: ' + x.title); }}>Restore</button>
            <button className="btn slim danger" onClick={() => { if (confirm(`Delete "${x.title}" forever? This can't be undone.`)) { drop(x.id); act('DELETE', `/tasks/${x.id}/purge`); } }}>Delete forever</button>
          </div>
        </div>
      ))}
      {s.deleted.length === 0 && <div className="muted-line">Nothing deleted recently.</div>}
      <div className="hint">Deleted tasks stay here for 30 days, then go for good.</div>
    </>
  );
}
