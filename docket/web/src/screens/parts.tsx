// Small pieces shared by several screens: the edit form, the add row, task rows, search, toasts.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { AREA, AREAS, isStandalone, lastArea, search, useDocket, type ToastAction } from '../ctx';
import { DOW, addDays, dt, fmtDay, fmtDur, nextMonday, plural } from '../format';
import { SearchIcon } from '../icons';
import { ORIGIN_LABEL, claudeLink, claudePrompt, continueLink } from '../prompts';
import { WEEK_ORDER, defaultRule, describeRepeat, formatRule, parseRule, shortRepeat, type RepeatRule, type RepeatUnit } from '../repeat';
import type { Area, OriginKind, PendingRequest, Task, TaskPatch } from '../types';

// "Set this week's plan" on Today opens Week with the plan field focused.
let planFocus = false;
export const focusPlanNext = () => { planFocus = true; };
export const takePlanFocus = () => { const v = planFocus; planFocus = false; return v; };

export interface Toast { id: number; msg: string; kind: 'info' | 'error'; action?: ToastAction }

/** "Open Claude" with the queued prompt. In the iPhone home-screen app it also copies the prompt, in the same tap. */
export function OpenClaude({ className = 'btn ink', onCopied, onOpen }: { className?: string; onCopied?: () => void; onOpen?: () => void }) {
  const { s } = useDocket();
  const prompt = claudePrompt(s.requests);
  return (
    <a className={className + ' claude'} style={{ textDecoration: 'none' }} href={claudeLink(s.settings.claude_url, prompt)} target="_blank" rel="noreferrer"
      onClick={() => {
        if (isStandalone()) { try { navigator.clipboard?.writeText(prompt).then(() => onCopied?.(), () => { /* denied */ }); } catch { /* no clipboard */ } }
        onOpen?.();
      }}>Open Claude</a>
  );
}

/**
 * "Continue in <title>": opens the chat or session the task came from, and copies the prompt in
 * the same tap (an existing chat can't be prefilled), so it is one paste there.
 */
export function ContinueLink({ reqs, className = 'btn ink', onCopied, children }: { reqs: PendingRequest[]; className?: string; onCopied?: () => void; children?: React.ReactNode }) {
  const c = continueLink(reqs[0]?.origin);
  if (!c) return null;
  const prompt = claudePrompt(reqs);
  return (
    <a className={className} style={{ textDecoration: 'none' }} href={c.url} target="_blank" rel="noreferrer" title={c.url}
      onClick={() => { try { navigator.clipboard?.writeText(prompt).then(() => onCopied?.(), () => { /* denied */ }); } catch { /* no clipboard */ } }}>
      {children ?? c.label}
    </a>
  );
}

/** A toast: bottom right on the Mac, above the tab bar on the phone, above the composer in the sheet. */
export function ToastView({ t, where, onClose }: { t: Toast; where: 'wide' | 'phone' | 'sheet'; onClose: () => void }) {
  const { s, notify } = useDocket();
  const a = t.action;
  const cont = a && typeof a === 'object' && 'continue' in a ? s.requests.find(r => r.id === a.continue) : undefined;
  return (
    <div className={(where === 'sheet' ? 'sheet-note' : 'toast' + (where === 'wide' ? ' wide' : '')) + (t.kind === 'error' ? ' error' : '')} role={t.kind === 'error' ? 'alert' : 'status'}>
      {t.kind === 'error' && <span className="dot" />}
      <span className="msg">{t.msg}</span>
      {cont && continueLink(cont.origin) ? <ContinueLink reqs={[cont]} className="btn slim toast-act claude" onCopied={() => notify('Copied. Paste it there and send.')} />
        : a === 'open-claude' || (a && typeof a === 'object' && 'continue' in a) ? (s.requests.length > 0 && <OpenClaude className="btn slim toast-act" />)
        : a ? <button className="btn slim toast-act" onClick={() => { onClose(); a.run(); }}>{a.label}</button> : null}
      <button className="x" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, l]) => <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

/** Today / Tomorrow / Next Mon, plus a date field for anything else. */
export function DayPicker({ value, onChange, min }: { value: string; onChange: (d: string) => void; min?: string }) {
  const { s } = useDocket();
  const t = s.today;
  const opts: [string, string][] = [[t, 'Today'], [addDays(t, 1), 'Tomorrow'], [nextMonday(t), 'Next Mon']];
  return (
    <div className="row-gap day-pick">
      {opts.map(([d, l]) => <button key={l} type="button" className={'btn slim' + (value === d ? ' on' : '')} onClick={() => onChange(d)}>{l}</button>)}
      <input type="date" aria-label="Pick a day" value={value} min={min} onChange={e => e.target.value && onChange(e.target.value)} />
    </div>
  );
}

const EST = [15, 30, 60, 90];

type RepeatKind = RepeatRule['kind'] | '' | 'other';
const REPEAT_KINDS: [RepeatKind, string][] = [['', 'None'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly on…'], ['monthly', 'Monthly on day…'], ['every', 'Every N days, weeks or months']];

/** The form's repeat fields as a canonical rule: null for none, undefined to keep one this app can't edit, or an error. */
function ruleOf(f: { rk: RepeatKind; days: number[]; n: string; unit: RepeatUnit; date: string }): string | null | undefined | { error: string } {
  switch (f.rk) {
    case '': return null;
    case 'other': return undefined;
    case 'weekly': return f.days.length ? formatRule({ kind: 'weekly', days: f.days }) : { error: 'Pick at least one day for the repeat.' };
    case 'monthly': { const d = Math.round(Number(f.date)); return d >= 1 && d <= 31 ? 'monthly:' + d : { error: 'The day of the month is 1 to 31.' }; }
    case 'every': { const n = Math.round(Number(f.n)); return n >= 1 && n <= 365 ? `every:${n}:${f.unit}` : { error: 'Repeat every 1 to 365 days, weeks or months.' }; }
    default: return f.rk;
  }
}

const repeatHint = (rule: ReturnType<typeof ruleOf>, from: boolean) =>
  rule === undefined ? 'Set by Claude or a newer Docket; leave it, or pick another.' : !rule || typeof rule === 'object' ? '' :
  describeRepeat(rule) + '. Completing it adds the next one' + (from ? ', counted from the day you finish it.' : ', on the next day the rule gives.');

/** The inline edit form for a task. Saves only the fields that changed, in one PATCH. */
export function TaskEdit({ x, onClose, onDelete, focus }: { x: Task; onClose: () => void; onDelete?: () => void; focus?: 'origin' }) {
  const { s, patchTask, notify } = useDocket();
  const [f, setF] = useState(() => {
    const r = parseRule(x.repeat);
    const w = r?.kind === 'weekly' ? r : defaultRule('weekly', x.day), e = r?.kind === 'every' ? r : defaultRule('every', x.day), m = r?.kind === 'monthly' ? r : defaultRule('monthly', x.day);
    return {
      title: x.title, est: String(x.est), day: x.day, due: x.due ?? '', at: x.at ?? '', priority: x.priority, area: x.area, energy: x.energy,
      project: x.project ?? '', notes: x.notes ?? '', link: x.link ?? '',
      origin_kind: (x.origin_kind ?? '') as OriginKind | '', origin_title: x.origin_title ?? '', origin_url: x.origin_url ?? '',
      rk: (r ? r.kind : x.repeat ? 'other' : '') as RepeatKind,
      days: w.kind === 'weekly' ? w.days : [], n: String(e.kind === 'every' ? e.n : 2), unit: (e.kind === 'every' ? e.unit : 'weeks') as RepeatUnit,
      date: String(m.kind === 'monthly' ? m.date : dt(x.day).getDate()), from: x.repeat_from === 'done',
    };
  });
  const originRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus !== 'origin' || !originRef.current) return;
    originRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    originRef.current.querySelector('select')?.focus({ preventScroll: true });
  }, [focus]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));
  const projects = useMemo(() => [...new Set(s.tasks.map(t => t.project).filter((p): p is string => !!p))].sort(), [s.tasks]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const est = Math.round(Number(f.est));
    if (!f.title.trim()) return notify('A task needs a title.', { kind: 'error' });
    if (!(est > 0)) return notify('The estimate is a number of minutes.', { kind: 'error' });
    const p: TaskPatch = {};
    if (f.title.trim() !== x.title) p.title = f.title.trim();
    if (est !== x.est) p.est = est;
    if (f.day && f.day !== x.day) p.day = f.day;
    if ((f.due || null) !== x.due) p.due = f.due || null;
    const at = f.at.slice(0, 5) || null;
    if (at !== x.at) p.at = at;
    const rule = ruleOf(f);
    if (rule && typeof rule === 'object') return notify(rule.error, { kind: 'error' });
    if (rule !== undefined && rule !== x.repeat) p.repeat = rule;
    const from = f.from ? 'done' : 'planned';
    if (f.rk && from !== x.repeat_from) p.repeat_from = from;
    if (f.priority !== x.priority) p.priority = f.priority;
    if (f.area !== x.area) p.area = f.area;
    if (f.energy !== x.energy) p.energy = f.energy;
    const project = f.project.trim() || null, notes = f.notes.trim() || null;
    // The server wants a scheme; a host typed by hand ("docs.google.com/…") becomes https://.
    const raw = f.link.trim(), link = raw ? (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw) : null;
    if (project !== x.project) p.project = project;
    if (notes !== x.notes) p.notes = notes;
    if (link !== x.link) p.link = link;
    const oRaw = f.origin_url.trim(), oUrl = oRaw ? (/^[a-z][a-z0-9+.-]*:/i.test(oRaw) ? oRaw : 'https://' + oRaw) : null;
    if (oUrl && !/^https:\/\//i.test(oUrl)) return notify('The origin link must start with https://.', { kind: 'error' });
    const o = { kind: f.origin_kind || null, title: f.origin_title.trim() || null, url: oUrl };
    if (o.kind !== x.origin_kind || o.title !== x.origin_title || o.url !== x.origin_url) p.origin = o.kind || o.title || o.url ? o : null;
    if (!Object.keys(p).length) return onClose();
    setBusy(true);
    const ok = await patchTask(x, p);
    setBusy(false);
    if (ok) onClose();
  };
  // Paste needs permission in some browsers; when it is refused the owner can still type or long-press.
  const pasteOrigin = async () => {
    let t = '';
    try { t = (await navigator.clipboard.readText()).trim(); } catch { /* denied or unsupported */ }
    if (!t) return notify("Couldn't read the clipboard. Paste into the field instead.", { kind: 'error' });
    setF(p => ({ ...p, origin_url: t, origin_kind: p.origin_kind || (/^https:\/\/claude\.ai\/code\//i.test(t) ? 'claude_code' : /^https:\/\/claude\.ai\//i.test(t) ? 'chat' : /^https:\/\/mail\.google\.com\//i.test(t) ? 'email' : '') }));
  };
  const listId = 'projects-' + x.id;
  return (
    <form className="edit" onSubmit={save}>
      <label className="f"><span>Title</span><input value={f.title} onChange={e => set('title', e.target.value)} maxLength={200} /></label>
      <div className="f"><span>Estimate</span>
        <div className="row-gap" style={{ alignItems: 'center' }}>
          <input className="num" type="number" inputMode="numeric" min={5} max={1440} step={5} aria-label="Estimate in minutes" value={f.est} onChange={e => set('est', e.target.value)} />
          <span className="unit">min</span>
          {EST.map(n => <button key={n} type="button" className={'btn slim' + (Number(f.est) === n ? ' on' : '')} onClick={() => set('est', String(n))}>{fmtDur(n)}</button>)}
        </div>
      </div>
      <div className="f"><span>Day</span><DayPicker value={f.day} onChange={v => set('day', v)} /></div>
      <div className="f"><span>Time</span>
        <div className="row-gap" style={{ alignItems: 'center' }}>
          <input type="time" aria-label="Time of day" value={f.at} onChange={e => set('at', e.target.value)} />
          {f.at ? <button type="button" className="btn slim" onClick={() => set('at', '')}>Clear</button> : <span className="unit">Any time</span>}
        </div>
      </div>
      <div className="f"><span>Due</span>
        <div className="row-gap" style={{ alignItems: 'center' }}>
          <input type="date" aria-label="Due date" value={f.due} onChange={e => set('due', e.target.value)} />
          {f.due && <button type="button" className="btn slim" onClick={() => set('due', '')}>Clear</button>}
        </div>
      </div>
      <div className="f top"><span>Repeat</span>
        <div className="repeat-edit">
          <div className="row-gap">
            <select aria-label="Repeat" value={f.rk} onChange={e => set('rk', e.target.value as RepeatKind)}>
              {REPEAT_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              {f.rk === 'other' && <option value="other">{x.repeat}</option>}
            </select>
            {f.rk === 'monthly' && <input className="num" type="number" inputMode="numeric" min={1} max={31} aria-label="Day of the month" value={f.date} onChange={e => set('date', e.target.value)} />}
            {f.rk === 'every' && <>
              <input className="num" type="number" inputMode="numeric" min={1} max={365} aria-label="Every how many" value={f.n} onChange={e => set('n', e.target.value)} />
              <select aria-label="Unit" value={f.unit} onChange={e => set('unit', e.target.value as RepeatUnit)}>
                <option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option>
              </select>
            </>}
          </div>
          {f.rk === 'weekly' && (
            <div className="seg days" role="group" aria-label="Repeat on">
              {WEEK_ORDER.map(d => {
                const on = f.days.includes(d);
                return <button key={d} type="button" className={on ? 'on' : ''} aria-pressed={on} onClick={() => set('days', on ? f.days.filter(z => z !== d) : [...f.days, d])}>{DOW[d]}</button>;
              })}
            </div>
          )}
          {f.rk && f.rk !== 'other' && (
            <label className="check-line"><input type="checkbox" checked={f.from} onChange={e => set('from', e.target.checked)} />From completion</label>
          )}
          {f.rk && <div className="hint" style={{ marginTop: 0 }}>{repeatHint(ruleOf(f), f.from)}</div>}
        </div>
      </div>
      <div className="f"><span>Priority</span><Seg label="Priority" value={f.priority} options={[['high', 'High'], ['med', 'Med'], ['low', 'Low']]} onChange={v => set('priority', v)} /></div>
      <div className="f"><span>Area</span><Seg label="Area" value={f.area} options={AREAS.map(a => [a, a] as [Area, string])} onChange={v => set('area', v)} /></div>
      <div className="f"><span>Energy</span><Seg label="Energy" value={f.energy} options={[['high', 'High'], ['low', 'Low']]} onChange={v => set('energy', v)} /></div>
      <label className="f"><span>Project</span><input list={listId} value={f.project} onChange={e => set('project', e.target.value)} maxLength={100} placeholder="None" /></label>
      <datalist id={listId}>{projects.map(p => <option key={p} value={p} />)}</datalist>
      <label className="f top"><span>Notes</span><textarea rows={3} value={f.notes} onChange={e => set('notes', e.target.value)} maxLength={4000} placeholder="Context, links, what done means" /></label>
      <label className="f"><span>Link</span><input type="text" inputMode="url" value={f.link} onChange={e => set('link', e.target.value)} maxLength={500} placeholder="https://" /></label>
      <div className="f top" ref={originRef}><span>Origin</span>
        <div className="origin-edit">
          <div className="row-gap">
            <select aria-label="Where it came from" value={f.origin_kind} onChange={e => set('origin_kind', e.target.value as OriginKind | '')}>
              <option value="">None</option>
              {(Object.keys(ORIGIN_LABEL) as OriginKind[]).map(k => <option key={k} value={k}>{ORIGIN_LABEL[k]}</option>)}
            </select>
            <input className="grow" aria-label="Chat or session title" value={f.origin_title} onChange={e => set('origin_title', e.target.value)} maxLength={120} placeholder="Chat or session title" />
          </div>
          <div className="row-gap">
            <input className="grow" type="text" inputMode="url" aria-label="Chat or session link" value={f.origin_url} onChange={e => set('origin_url', e.target.value)} maxLength={500} placeholder="https://claude.ai/…" />
            <button type="button" className="btn slim" onClick={pasteOrigin}>Paste</button>
          </div>
        </div>
      </div>
      <div className="row-gap edit-actions">
        <button className="btn ink" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button className="btn" type="button" onClick={onClose}>Cancel</button>
        {onDelete && <button className="btn danger" type="button" onClick={onDelete}>Delete</button>}
      </div>
    </form>
  );
}

/** "Add a task" without Claude: a title, then optional chips for the estimate and area. */
export function AddTaskRow({ day }: { day: string }) {
  const { addTask } = useDocket();
  const [title, setTitle] = useState('');
  const [est, setEst] = useState(30);
  const [area, setArea] = useState<Area>(lastArea);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    const out = await addTask({ title: t, area, est, priority: 'med', energy: 'low', day }, { quiet: true });
    setBusy(false);
    if (out) setTitle('');
  };
  return (
    <form className="add-row" onSubmit={submit}>
      <div className="add-line">
        <span className="plus" aria-hidden="true">+</span>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a task" aria-label="Add a task" maxLength={200} enterKeyHint="done" />
        {title.trim() && <button className="btn ink slim" type="submit" disabled={busy}>Add</button>}
      </div>
      {title.trim() && (
        <div className="add-opts">
          {EST.map(n => <button key={n} type="button" className={'btn slim' + (est === n ? ' on' : '')} aria-pressed={est === n} onClick={() => setEst(n)}>{fmtDur(n)}</button>)}
          <span className="sep" />
          {AREAS.map(a => (
            <button key={a} type="button" className={'btn slim' + (area === a ? ' on' : '')} aria-pressed={area === a} onClick={() => setArea(a)}>
              <span className="sq" style={{ background: AREA[a].c }} />{a}
            </button>
          ))}
        </div>
      )}
    </form>
  );
}

/** Deletes at once on screen; the server's answer (or an error) follows. */
export function useDelete() {
  const { act, optimistic } = useDocket();
  return (x: Task) => {
    optimistic(st => ({ ...st, tasks: st.tasks.filter(t => t.id !== x.id) }));
    return act('DELETE', '/tasks/' + x.id);
  };
}

/** A compact task row (Week, Later, search results). Tapping the title opens the edit form. */
export function TaskRow({ x, showDay }: { x: Task; showDay?: boolean }) {
  const { s, patchTask } = useDocket();
  const del = useDelete();
  const [open, setOpen] = useState(false);
  const A = AREA[x.area] ?? AREA.Work;
  const withClaude = s.requests.some(r => r.task_id === x.id);
  return (
    <div className={'list-item' + (open ? ' open' : '')}>
      <div className={'list-row' + (x.done ? ' done' : '')}>
        <button className="check" aria-label={(x.done ? 'Reopen ' : 'Complete ') + x.title} style={{ borderColor: A.c, background: x.done ? A.c : 'transparent' }} onClick={() => patchTask(x, { done: !x.done })} />
        <button className="t row-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{x.title}</button>
        {withClaude && <span className="tag" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)', fontSize: 11 }}>With Claude</span>}
        <span className="m">{showDay ? fmtDay(x.day) + ' · ' : ''}{x.at ? x.at + ' · ' : ''}{x.area} · {fmtDur(x.est)}{x.repeat && shortRepeat(x.repeat) ? ' · ' + shortRepeat(x.repeat) : ''}</span>
      </div>
      {open && <TaskEdit x={x} onClose={() => setOpen(false)} onDelete={() => { setOpen(false); del(x); }} />}
    </div>
  );
}

/**
 * The search box. On the Mac it is always there; on the phone an icon opens it, focusing the
 * field in the same tap so the keyboard comes up.
 */
export function useFind() {
  const { q, setQ, wide } = useDocket();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const shown = wide || open || !!q;
  const close = () => { setQ(''); setOpen(false); };
  const input = shown ? (
    <div className={'search' + (wide ? '' : ' full')} role="search">
      <SearchIcon />
      <input ref={ref} value={q} onChange={e => setQ(e.target.value)} placeholder="Search tasks" aria-label="Search tasks" enterKeyHint="search" onKeyDown={e => { if (e.key === 'Escape') close(); }} />
      {(q || !wide) && <button className="x" type="button" aria-label="Close search" onClick={close}>×</button>}
    </div>
  ) : null;
  const button = shown ? null : (
    <button className="icon-btn" aria-label="Search tasks" onClick={() => { flushSync(() => setOpen(true)); ref.current?.focus(); }}><SearchIcon /></button>
  );
  return { input, button };
}

export function SearchResults() {
  const { s, q } = useDocket();
  const res = search(s.tasks, q);
  return (
    <div className="results">
      <h2 className="section-title">{res.length ? plural(res.length, 'match', 'matches') : 'No matches'}</h2>
      {res.slice(0, 60).map(x => <TaskRow key={x.id} x={x} showDay />)}
      {res.length === 0 && <div className="muted-line">Searches the titles, projects and notes of open tasks, and of tasks done in the last 60 days.</div>}
    </div>
  );
}
