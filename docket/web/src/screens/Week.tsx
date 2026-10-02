import { useEffect, useRef, useState } from 'react';
import { AREA, AREAS, byPlan, dayLoad, derive, useDocket } from '../ctx';
import { DOW, MON, addDays, ago, dt, fmtDay, fmtDur, isDay, isoWeek, plural, weekStart } from '../format';
import { Q, reviewWeek } from '../prompts';
import type { Task } from '../types';
import { AddTaskRow, SearchResults, TaskRow, takePlanFocus, useFind } from './parts';

export function Week() {
  const { s, route, go, ask, wide, q, openSheet } = useDocket();
  const d = derive(s);
  const t = d.t;
  const cur = weekStart(t);
  const ws = route.week && isDay(route.week) ? weekStart(route.week) : cur;
  const isCur = ws === cur;
  const [picked, setPicked] = useState<{ ws: string; day: string } | null>(null);
  const sel = picked && picked.ws === ws ? picked.day : isCur ? t : ws;
  const find = useFind();
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
  const loads = days.map(x => dayLoad(s, x));
  const maxH = Math.max(8, ...loads.map(l => l.planned / 60));
  const weekMin = loads.reduce((a, l) => a + l.planned, 0);
  const overDays = loads.filter(l => l.over > 0).length;
  const wsd = dt(ws), wed = dt(days[6]);
  const items = s.tasks.filter(x => x.day === sel).sort((a, b) => Number(a.done) - Number(b.done) || byPlan(a, b));
  const later = s.tasks.filter(x => !x.done && x.day > days[6]).sort((a, b) => a.day.localeCompare(b.day) || byPlan(a, b));
  const groups = new Map<string, Task[]>();
  for (const x of later) { const k = weekStart(x.day); groups.set(k, [...(groups.get(k) ?? []), x]); }
  const toWeek = (w: string) => go('week', w === cur ? undefined : w);
  const rw = isCur ? reviewWeek(t, s.review?.week_start) : ws;

  return (
    <>
      <div className="week-top">
        <div className="eyebrow">Week {isoWeek(ws)}</div>
        <div className="week-nav">
          {!isCur && <button className="btn slim" onClick={() => toWeek(cur)}>This week</button>}
          <button className="icon-btn" aria-label="Previous week" onClick={() => toWeek(addDays(ws, -7))}>‹</button>
          <button className="icon-btn" aria-label="Next week" onClick={() => toWeek(addDays(ws, 7))}>›</button>
          {find.button}
        </div>
      </div>
      <div className="head-row">
        <h1 className="display week">{wsd.getDate()} {MON[wsd.getMonth()]} – {wed.getDate()} {MON[wed.getMonth()]}</h1>
        {wide && find.input}
      </div>
      {!wide && find.input}
      <div className="sub">{fmtDur(weekMin)} planned · {overDays ? plural(overDays, 'day') + ' over' : 'no days over'} · Claude {d.left}% left</div>
      {!wide && s.moves.length > 0 && (
        <div className="banner">
          <span className="dot" />
          <div className="text">{plural(s.moves.length, 'move')} suggested.</div>
          <button className="btn ink" onClick={() => openSheet()}>Review</button>
        </div>
      )}
      {q ? <SearchResults /> : (
        <>
          {isCur && <PlanCard ws={ws} />}
          <div className="week-rows">
            {days.map((x, i) => {
              const l = loads[i], dd = dt(x);
              const segs = AREAS.map(a => ({ a, w: l.its.filter(z => z.area === a).reduce((n, z) => n + z.est, 0) / 60 / maxH * 100 })).filter(z => z.w > 0);
              return (
                <button key={x} className={'week-row' + (sel === x ? ' sel' : '') + (x < t ? ' past' : '') + (x === t ? ' today' : '')} aria-pressed={sel === x}
                  aria-label={`${fmtDay(x)}, ${l.planned ? fmtDur(l.planned) + ' planned' : 'nothing planned'}${l.over ? ', ' + fmtDur(l.over) + ' over' : ''}`} onClick={() => setPicked({ ws, day: x })}>
                  <div className="week-day">
                    <div className={'l' + (l.over ? ' over' : '')}>{DOW[dd.getDay()]}</div>
                    <div className="d">{dd.getDate()}</div>
                  </div>
                  <div className="bar">
                    {segs.map(sg => <div key={sg.a} style={{ width: sg.w + '%', background: AREA[sg.a].c }} />)}
                    <div className="cap" style={{ left: (s.settings.capacity_hours / maxH * 100) + '%' }} />
                  </div>
                  <div className={'week-total' + (l.over ? ' over' : '')}>{l.planned ? fmtDur(l.planned) : '–'}</div>
                </button>
              );
            })}
          </div>
          {(isCur || ws < cur) && (
            <div className="row-gap" style={{ gap: 8, marginTop: 18 }}>
              {isCur && <button className="btn ink big claude" onClick={() => ask(Q.balanceWeek())}>Balance my week</button>}
              <button className="btn big claude" onClick={() => ask(Q.review(rw))}>{rw < cur ? (isCur ? 'Review last week' : 'Review this week') : 'Weekly review'}</button>
            </div>
          )}
          <h2 className="section-title">{sel === t ? 'Today' : fmtDay(sel)}</h2>
          {items.map(x => <TaskRow key={x.id} x={x} />)}
          {items.length === 0 && <div className="muted-line" style={{ padding: '10px 0' }}>Nothing planned.</div>}
          {sel >= t && <AddTaskRow day={sel} />}
          {groups.size > 0 && (
            <>
              <h2 className="section-title">Later</h2>
              {[...groups].map(([gws, ts]) => (
                <div key={gws} className="later-group">
                  <button className="later-head" onClick={() => toWeek(gws)}>Week of {dt(gws).getDate()} {MON[dt(gws).getMonth()]} · {fmtDur(ts.reduce((a, x) => a + x.est, 0))}</button>
                  {ts.map(x => <TaskRow key={x.id} x={x} showDay />)}
                </div>
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

/** "This week": what the owner wants from the week, saved per week, and handed to Claude to plan. */
function PlanCard({ ws }: { ws: string }) {
  const { s, act, ask, now } = useDocket();
  const plan = s.week_plan?.week_start === ws ? s.week_plan : null;
  const saved = plan?.text ?? '';
  const [text, setText] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!dirty) setText(saved); }, [saved, dirty]);
  useEffect(() => { if (takePlanFocus()) ref.current?.focus(); }, []);
  const save = async () => {
    const v = text.trim();
    if (v === saved) { setDirty(false); return true; }
    // Keep the text (and the Save button) if the server says no.
    const ok = v ? await act('PUT', '/week-plan', { week_start: ws, text: v }) : await act('DELETE', '/week-plan/' + ws);
    if (ok) setDirty(false);
    return ok;
  };
  const planWeek = async () => {
    const v = text.trim();
    if (!v) return;
    // Queue it even if saving fails: the prompt carries the text.
    await save();
    ask(Q.planWeek(v));
  };
  return (
    <div className="card plan">
      <div className="plan-head"><span>This week</span>{plan && <span className="when">Updated {ago(plan.updated_at, now)}</span>}</div>
      <textarea ref={ref} rows={3} value={text} maxLength={2000} placeholder="What do you want to get done this week?" aria-label="This week's plan"
        onChange={e => { setText(e.target.value); setDirty(true); }} onBlur={() => { if (dirty) save(); }} />
      <div className="row-gap">
        <button className="btn ink claude" disabled={!text.trim()} onMouseDown={e => e.preventDefault()} onClick={planWeek}>Plan my week from this</button>
        {dirty && <button className="btn" onMouseDown={e => e.preventDefault()} onClick={() => save()}>Save</button>}
      </div>
    </div>
  );
}
