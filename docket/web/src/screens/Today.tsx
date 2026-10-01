import { useState } from 'react';
import { AREA, AREAS, derive, useDocket } from '../ctx';
import { DOWL, MONL, addDays, dt, fmtDay, fmtDur, plural } from '../format';
import { P } from '../prompts';
import type { Task } from '../types';
import { ringBg } from './Sidebar';

const nextP = { high: 'med', med: 'low', low: 'high' } as const;
const nextA = { Work: 'Personal', Personal: 'Health', Health: 'Work' } as const;

export function Legend({ children }: { children?: React.ReactNode }) {
  return (
    <div className="legend">
      {AREAS.map(a => <span key={a}><span className="sq" style={{ background: AREA[a].c }} />{a}</span>)}
      {children}
    </div>
  );
}

export function Today() {
  const { s, wide, go, ask, openSheet } = useDocket();
  const d = derive(s);
  const [expanded, setExpanded] = useState<string | null>(null);
  const td = dt(d.t);
  const cap = s.settings.capacity_hours;

  let banner: { text: string; cta: string; run: () => void } | null = null;
  if (!wide && s.moves.length) banner = { text: plural(s.moves.length, 'move') + ' suggested.', cta: 'Review', run: openSheet };
  else if (d.overMin > 0 && !s.moves.length) banner = { text: `You're ${fmtDur(d.overMin)} over today.`, cta: 'Rebalance', run: () => ask(P.planDay, { label: 'Plan my day', priority: 'high' }) };

  let cum = 0, lineDone = false;
  const rows: React.ReactNode[] = [];
  for (const x of d.open) {
    cum += x.est;
    const over = cum > d.capMin;
    if (over && !lineDone) {
      lineDone = true;
      rows.push(<div key="capline" className="capline"><div className="dash" /><span>your {cap} hours end here</span><div className="dash short" /></div>);
    }
    rows.push(<Block key={x.id} x={x} over={over} open={expanded === x.id} onExpand={() => setExpanded(expanded === x.id ? null : x.id)} onClose={() => setExpanded(null)} />);
  }
  const done = d.todays.filter(x => x.done);

  return (
    <>
      <div className="head-row">
        <div>
          <div className="eyebrow">{DOWL[td.getDay()]}</div>
          <h1 className="display">{td.getDate()} {MONL[td.getMonth()]}</h1>
        </div>
        {!wide && (
          <div onClick={() => go('usage')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <div className="ring" style={{ width: 44, height: 44, background: ringBg(d.left) }}>
              <div className="ring-hole" style={{ width: 34, height: 34, background: 'var(--bg)', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600, whiteSpace: 'nowrap' }}>{d.left}%</div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--muted)' }}>Claude left</div>
          </div>
        )}
      </div>
      <Legend><span className="summary">{d.open.length} tasks · {fmtDur(d.openMin)} / {cap}h</span></Legend>
      {banner && (
        <div className="banner">
          <span className="dot" />
          <div className="text">{banner.text}</div>
          <button className="btn ink" onClick={banner.run}>{banner.cta}</button>
        </div>
      )}
      <div className="blocks">{rows}</div>
      {d.open.length === 0 && <div className="empty">Nothing left for today. Tap the mic and say what's next.</div>}
      {done.length > 0 && (
        <div>
          <h2 className="done-head">Done · {done.length}</h2>
          {done.map(x => <DoneRow key={x.id} x={x} />)}
        </div>
      )}
    </>
  );
}

function DoneRow({ x }: { x: Task }) {
  const { patchTask } = useDocket();
  return (
    <div className="done-row" onClick={() => patchTask(x, { done: false })}>
      <span className="tick">✓</span><span className="t">{x.title}</span><span className="d">{fmtDur(x.est)}</span>
    </div>
  );
}

function Block({ x, over, open, onExpand, onClose }: { x: Task; over: boolean; open: boolean; onExpand: () => void; onClose: () => void }) {
  const { s, act, ask, patchTask } = useDocket();
  const [copied, setCopied] = useState(false);
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
  const tags = [];
  if (x.priority === 'high') tags.push(tag('High'));
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
  const askTask = (prompt: string, label: string) => ask(prompt, { label: label + ': ' + x.title, priority: x.priority, taskId: x.id });

  return (
    <div className={'block' + (big ? '' : ' small')} style={{ background: bg, color: fg, border }}>
      <div className="block-head" style={{ minHeight: h }} onClick={onExpand}>
        <button className="check" aria-label={'Complete ' + x.title} style={{ borderColor: ring }} onClick={e => { e.stopPropagation(); patchTask(x, { done: true }); }} />
        <div className="block-body">
          <div className="block-title">{x.title}</div>
          <div className="block-meta">
            <span className="meta">{meta}</span>
            {tags.map(tg => <span key={tg.t} className="tag" style={{ background: tg.bg, color: tg.fg }}>{tg.t}</span>)}
          </div>
        </div>
        <div className="block-dur">{fmtDur(x.est)}</div>
      </div>
      {open && (
        <div className="block-open">
          {x.steps.length > 0 && (
            <div className="steps">
              {x.steps.map((st, i) => (
                <button key={i} className={'step' + (st.done ? ' done' : '')} onClick={() => act('POST', `/tasks/${x.id}/steps/${i}/toggle`)}>
                  <span className="box" /><span>{st.text}</span>
                </button>
              ))}
            </div>
          )}
          {x.draft && (
            <div className="draft">
              <div className="draft-label">Draft</div>
              <div className="draft-text">{x.draft}</div>
              <div className="row-gap" style={{ marginTop: 10 }}>
                {x.gmail_draft_id
                  ? <a className="btn ink" style={{ textDecoration: 'none' }} href="https://mail.google.com/mail/u/0/#drafts" target="_blank" rel="noreferrer">Saved to Gmail drafts</a>
                  : <button className="btn ink" onClick={() => ask(P.saveDraft(x), { label: 'Save to Gmail: ' + x.title, priority: 'high', taskId: x.id })}>Save to Gmail drafts</button>}
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(x.draft!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
          )}
          <div className="row-gap">
            <button className="btn" onClick={() => askTask(P.breakDown(x), 'Break down')}>Break down</button>
            <button className="btn" onClick={() => askTask(P.estimate(x), 'Estimate')}>Estimate</button>
            <button className="btn" onClick={() => askTask(P.draft(x), 'Draft')}>Draft it</button>
            <button className="btn" onClick={() => { patchTask(x, { day: addDays(s.today, 1) }); onClose(); }}>Tomorrow</button>
            <button className="btn" onClick={() => patchTask(x, { priority: nextP[x.priority] })}>Priority: {x.priority}</button>
            <button className="btn" onClick={() => patchTask(x, { area: nextA[x.area] })}>{x.area}</button>
            <button className="btn danger" onClick={() => { act('DELETE', '/tasks/' + x.id); onClose(); }}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}
