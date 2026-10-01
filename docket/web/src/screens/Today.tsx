import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AREA, AREAS, derive, finished, safeUrl, useDocket } from '../ctx';
import { DOWL, MONL, addDays, ago, dt, fmtDay, fmtDur, plural, shortDay } from '../format';
import { Q, continueLink, originOf, originText } from '../prompts';
import type { Task } from '../types';
import { ringBg } from './Sidebar';
import { AddTaskRow, DayPicker, SearchResults, TaskEdit, focusPlanNext, useDelete, useFind } from './parts';

export function Legend({ children }: { children?: React.ReactNode }) {
  return (
    <div className="legend">
      {AREAS.map(a => <span key={a}><span className="sq" style={{ background: AREA[a].c }} />{a}</span>)}
      {children}
    </div>
  );
}

export function Today() {
  const { s, wide, go, ask, openSheet, q } = useDocket();
  const d = derive(s);
  const [expanded, setExpanded] = useState<string | null>(null);
  const frozen = useRef<string[] | null>(null);
  const find = useFind();
  const td = dt(d.t);
  const cap = s.settings.capacity_hours;

  // While a block is open, keep the order it had when it opened, so a change (priority, a
  // new task from Claude) doesn't move it under the finger. The list re-sorts once it closes.
  let open = d.open;
  if (expanded && open.some(x => x.id === expanded)) {
    frozen.current ??= open.map(x => x.id);
    const pos = new Map(frozen.current.map((id, i) => [id, i]));
    open = [...open].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  } else frozen.current = null;

  let banner: { text: string; cta: string; run: () => void; claude?: boolean } | null = null;
  if (!wide && s.moves.length) banner = { text: plural(s.moves.length, 'move') + ' suggested.', cta: 'Review', run: () => openSheet() };
  else if (d.overMin > 0 && !s.moves.length) banner = { text: `You're ${fmtDur(d.overMin)} over today.`, cta: 'Rebalance', run: () => ask(Q.planDay()), claude: true };

  let cum = 0, lineDone = false;
  const rows: React.ReactNode[] = [];
  for (const x of open) {
    cum += x.est;
    const over = cum > d.capMin;
    if (over && !lineDone) {
      lineDone = true;
      rows.push(<div key="capline" className="capline"><div className="dash" /><span>your {cap} hours end here</span><div className="dash short" /></div>);
    }
    rows.push(<Block key={x.id} x={x} over={over} open={expanded === x.id} onExpand={() => setExpanded(expanded === x.id ? null : x.id)} onClose={() => setExpanded(null)} />);
  }
  const done = d.todays.filter(x => x.done);
  const chips: React.ReactNode[] = [];
  if (!wide && s.requests.length) chips.push(<button key="wait" className="btn chip-wait" onClick={() => openSheet()}><span className="dot" />{s.requests.length} waiting</button>);
  if (td.getDay() === 1 && !s.week_plan) chips.push(<button key="plan" className="btn" onClick={() => { focusPlanNext(); go('week'); }}>Set this week's plan</button>);

  return (
    <>
      <div className="head-row">
        <div>
          <div className="eyebrow">{DOWL[td.getDay()]}</div>
          <h1 className="display">{td.getDate()} {MONL[td.getMonth()]}</h1>
        </div>
        {wide ? find.input : (
          <div className="head-side">
            {find.button}
            <button className="ring-btn" aria-label={d.left + '% of Claude left this week'} onClick={() => go('usage')}>
              <div className="ring" style={{ width: 44, height: 44, background: ringBg(d.left) }}>
                <div className="ring-hole" style={{ width: 34, height: 34, background: 'var(--bg)', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{d.left}%</div>
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted)' }}>Claude left</div>
            </button>
          </div>
        )}
      </div>
      {!wide && find.input}
      <Legend><span className="summary">{d.open.length} tasks · {fmtDur(d.openMin)} / {cap}h</span></Legend>
      {chips.length > 0 && <div className="head-chips">{chips}</div>}
      {banner && (
        <div className="banner">
          <span className="dot" />
          <div className="text">{banner.text}</div>
          <button className={'btn ink' + (banner.claude ? ' claude' : '')} onClick={banner.run}>{banner.cta}</button>
        </div>
      )}
      {q ? <SearchResults /> : (
        <>
          {d.overdue.length > 0 && <CarriedOver tasks={d.overdue} />}
          <div className="blocks">{rows}</div>
          {d.open.length === 0 && <div className="empty">{wide ? 'Nothing left for today.' : "Nothing left for today. Tap the mic and say what's next."}</div>}
          <AddTaskRow day={d.t} />
          {done.length > 0 && (
            <div>
              <h2 className="done-head">Done · {done.length}</h2>
              {done.map(x => <DoneRow key={x.id} x={x} />)}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Open tasks from earlier days. They don't count toward today until moved. */
function CarriedOver({ tasks }: { tasks: Task[] }) {
  const { s, patchTask, act, optimistic } = useDocket();
  const del = useDelete();
  const [all, setAll] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const moveAll = async () => {
    const ids = new Set(tasks.map(x => x.id));
    optimistic(st => ({ ...st, tasks: st.tasks.map(x => (ids.has(x.id) ? { ...x, day: st.today } : x)) }));
    await Promise.all(tasks.map(x => act('PATCH', '/tasks/' + x.id, { day: s.today })));
  };
  const shown = all ? tasks : tasks.slice(0, 5);
  return (
    <div className="card carried">
      <div className="carried-head">
        <span className="h">Carried over · {tasks.length}</span>
        <button className="btn" onClick={moveAll}>Move all to today</button>
      </div>
      {shown.map(x => (
        <div key={x.id} className="carried-row">
          <span className="sq" style={{ background: (AREA[x.area] ?? AREA.Work).c }} />
          <div className="t">
            <div>{x.title}</div>
            <div className="m">from {shortDay(x.day, s.today)} · {fmtDur(x.est)}{x.priority === 'high' ? ' · High' : ''}</div>
          </div>
          <div className="row-gap acts">
            <button className="btn slim" onClick={() => patchTask(x, { day: s.today })}>Today</button>
            <button className="btn slim" aria-expanded={pick === x.id} onClick={() => setPick(pick === x.id ? null : x.id)}>Pick day</button>
            <button className="btn slim" onClick={() => patchTask(x, { done: true })}>Done</button>
            <button className="btn slim danger" onClick={() => del(x)}>Delete</button>
          </div>
          {pick === x.id && <div className="pick"><DayPicker value={x.day} min={s.today} onChange={day => { setPick(null); patchTask(x, { day }); }} /></div>}
        </div>
      ))}
      {tasks.length > 5 && <button className="more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${tasks.length}`}</button>}
    </div>
  );
}

function DoneRow({ x }: { x: Task }) {
  const { patchTask } = useDocket();
  return (
    <button className="done-row" title="Tap to reopen" onClick={() => patchTask(x, { done: false })}>
      <span className="tick">✓</span><span className="t">{x.title}</span><span className="d">{fmtDur(x.est)}</span>
    </button>
  );
}

function Block({ x, over, open, onExpand, onClose }: { x: Task; over: boolean; open: boolean; onExpand: () => void; onClose: () => void }) {
  const { s, act, ask, patchTask, optimistic, notify, now } = useDocket();
  const del = useDelete();
  const [copied, setCopied] = useState('');
  const [mode, setMode] = useState<'' | 'edit' | 'give'>('');
  const [give, setGive] = useState('');
  const [step, setStep] = useState('');
  useEffect(() => { if (!open) setMode(''); }, [open]);
  const A = AREA[x.area] ?? AREA.Work;
  const big = x.est >= 30;
  let bg: string, fg: string, border = 'none', ring: string;
  if (over) {
    bg = `repeating-linear-gradient(135deg, color-mix(in oklch, ${A.c} 70%, var(--bg)) 0 6px, color-mix(in oklch, ${A.c} 28%, var(--bg)) 6px 12px)`;
    fg = 'var(--ink)'; ring = 'var(--ink)';
  } else if (big) { bg = A.c; fg = A.on; ring = A.on; }
  else { bg = 'var(--card)'; fg = 'var(--ink)'; border = '1px solid var(--line)'; ring = A.c; }
  const onBlock = big && !over;
  const tag = (t: string, accent = false) => ({ t, bg: accent ? 'var(--accent-soft)' : onBlock ? 'rgba(255,255,255,.22)' : 'var(--chip)', fg: accent ? 'var(--accent-ink)' : 'inherit' });
  const pending = s.requests.find(r => r.task_id === x.id);
  const last = finished(s.recent).find(r => r.task_id === x.id);
  const replied = !pending && last && (last.outcome === 'needs_owner' || last.outcome === 'failed') ? last : null;
  const tags = [];
  if (x.priority === 'high') tags.push(tag('High'));
  if (pending) tags.push(tag('With Claude', true));
  else if (replied) tags.push(tag('Claude replied', true));
  if (x.result) tags.push(tag('Result ready', true));
  if (x.draft) tags.push(tag(x.gmail_draft_id ? 'Draft saved' : 'Draft ready', true));
  if (x.source === 'gmail') tags.push(tag('Gmail'));
  if (x.due && x.due !== x.day) tags.push(tag('Due ' + fmtDay(x.due).split(' ').slice(0, 2).join(' ')));
  if (over) {
    const mv = s.moves.find(m => m.task_id === x.id);
    if (mv) tags.push(tag('Suggest ' + fmtDay(mv.to_day).split(' ')[0], true));
  }
  const sd = x.steps.filter(z => z.done).length;
  const meta = [x.project, x.energy === 'high' ? 'High energy' : 'Low energy', x.steps.length ? `${sd} of ${x.steps.length} steps` : ''].filter(Boolean).join(' · ');
  const h = big ? Math.min(130, Math.max(48, x.est * 0.7)) : 0;
  const link = safeUrl(x.link), resultUrl = safeUrl(x.result_url);
  const origin = originOf(x), from = originText(origin), fromUrl = continueLink(origin)?.url;

  const copy = (k: string, text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(k); window.setTimeout(() => setCopied(''), 1500); }, () => notify("Couldn't copy.", { kind: 'error' }));
  };
  const toggleStep = (i: number) => {
    const done = !x.steps[i].done;
    optimistic(st => ({ ...st, tasks: st.tasks.map(t => (t.id === x.id ? { ...t, steps: t.steps.map((z, j) => (j === i ? { ...z, done } : z)) } : t)) }));
    act('PATCH', `/tasks/${x.id}/steps/${i}`, { done });
  };
  const addStep = async (e: FormEvent) => {
    e.preventDefault();
    const t = step.trim();
    if (t && (await act('POST', `/tasks/${x.id}/steps`, { steps: [t] }))) setStep('');
  };
  const giveTo = (e: FormEvent) => {
    e.preventDefault();
    ask(Q.give(x, give));
    setGive('');
    setMode('');
  };

  return (
    <div className={'block' + (big ? '' : ' small')} style={{ background: bg, color: fg, border }}>
      <div className="block-head" role="button" tabIndex={0} aria-expanded={open} style={{ minHeight: h }} onClick={onExpand}
        onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onExpand(); } }}>
        <button className="check" aria-label={'Complete ' + x.title} style={{ borderColor: ring }} onClick={e => { e.stopPropagation(); patchTask(x, { done: true }); }} />
        <div className="block-body">
          <div className="block-title">{x.title}</div>
          <div className="block-meta">
            {meta && <span className="meta">{meta}</span>}
            {from && (fromUrl
              ? <a className="origin" href={fromUrl} target="_blank" rel="noreferrer" title={fromUrl} onClick={e => e.stopPropagation()}>{from}</a>
              : <span className="origin">{from}</span>)}
            {tags.map(tg => <span key={tg.t} className="tag" style={{ background: tg.bg, color: tg.fg }}>{tg.t}</span>)}
          </div>
        </div>
        <div className="block-dur">{fmtDur(x.est)}</div>
      </div>
      {open && (
        <div className="block-open">
          {(x.notes || x.link) && (
            <div className="notes">
              {x.notes && <div className="notes-text">{x.notes}</div>}
              {link ? <a className="link-out" href={link} target="_blank" rel="noreferrer">{link.replace(/^https?:\/\//i, '')}</a> : x.link && <div className="notes-text">{x.link}</div>}
            </div>
          )}
          {replied && (
            <div className="draft">
              <div className="draft-label">{replied.outcome === 'needs_owner' ? 'Claude needs something' : "Claude couldn't finish"}{replied.completed_at ? ' · ' + ago(replied.completed_at, now) : ''}</div>
              <div className="draft-text">{[replied.reply, replied.detail].filter(Boolean).join('\n\n') || 'No details.'}</div>
            </div>
          )}
          {x.result && (
            <div className="draft">
              <div className="draft-label">Result{x.result_at ? ' · ' + ago(x.result_at, now) : ''}</div>
              <div className="draft-text">{x.result}</div>
              {resultUrl && <a className="link-out" href={resultUrl} target="_blank" rel="noreferrer">{resultUrl.replace(/^https?:\/\//i, '')}</a>}
              <div className="row-gap" style={{ marginTop: 10 }}>
                <button className="btn ink" onClick={() => { patchTask(x, { done: true }); onClose(); }}>Mark done</button>
                <button className="btn" onClick={() => copy('result', x.result!)}>{copied === 'result' ? 'Copied' : 'Copy'}</button>
                <button className="btn" onClick={() => patchTask(x, { result: null })}>Clear</button>
              </div>
            </div>
          )}
          {x.steps.length > 0 && (
            <div className="steps">
              {x.steps.map((st, i) => (
                <button key={i} className={'step' + (st.done ? ' done' : '')} aria-pressed={st.done} onClick={() => toggleStep(i)}>
                  <span className="box" /><span>{st.text}</span>
                </button>
              ))}
            </div>
          )}
          <form className="add-step" onSubmit={addStep}>
            <span className="box" aria-hidden="true" />
            <input value={step} onChange={e => setStep(e.target.value)} placeholder="Add a step" aria-label="Add a step" maxLength={300} enterKeyHint="done" />
            {step.trim() && <button className="btn slim" type="submit">Add</button>}
          </form>
          {x.draft && (
            <div className="draft">
              <div className="draft-label">Draft</div>
              <div className="draft-text">{x.draft}</div>
              <div className="row-gap" style={{ marginTop: 10 }}>
                {x.gmail_draft_id
                  ? <a className="btn ink" style={{ textDecoration: 'none' }} href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Saved to Gmail drafts</a>
                  : <button className="btn ink claude" onClick={() => ask(Q.saveDraft(x))}>Save to Gmail drafts</button>}
                <button className="btn" onClick={() => copy('draft', x.draft!)}>{copied === 'draft' ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
          )}
          {mode === 'give' && (
            <form className="give" onSubmit={giveTo}>
              <input autoFocus value={give} onChange={e => setGive(e.target.value)} placeholder="What should Claude do?" aria-label="What should Claude do?" maxLength={1500} enterKeyHint="send" />
              <button className="btn ink claude" type="submit">Give to Claude</button>
              <button className="btn" type="button" onClick={() => setMode('')}>Cancel</button>
            </form>
          )}
          {mode === 'edit' ? <TaskEdit x={x} onClose={() => setMode('')} /> : (
            <div className="row-gap">
              <button className="btn claude" onClick={() => ask(Q.breakDown(x))}>Break down</button>
              <button className="btn claude" onClick={() => ask(Q.estimate(x))}>Estimate</button>
              <button className="btn claude" onClick={() => ask(Q.draft(x))}>Draft it</button>
              <button className="btn claude" aria-expanded={mode === 'give'} onClick={() => setMode(mode === 'give' ? '' : 'give')}>Give to Claude</button>
              <button className="btn" onClick={() => setMode('edit')}>Edit</button>
              <button className="btn" onClick={() => { patchTask(x, { day: addDays(s.today, 1) }); onClose(); }}>Tomorrow</button>
              <button className="btn danger" onClick={() => { onClose(); del(x); }}>Delete</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
