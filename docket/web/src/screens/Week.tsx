import { useState } from 'react';
import { AREA, AREAS, RANK, derive, useDocket } from '../ctx';
import { DOW, MON, addDays, dt, fmtDay, fmtDur, isoWeek, plural, weekStart } from '../format';
import { P } from '../prompts';

export function Week() {
  const { s, ask, patchTask } = useDocket();
  const d = derive(s);
  const t = d.t;
  const [sel, setSel] = useState(t);
  const ws = weekStart(t);
  const days = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(ws, i));
  const dayMin = (x: string) => s.tasks.filter(q => q.day === x).reduce((a, q) => a + q.est, 0);
  const maxH = Math.max(8, ...days.map(x => dayMin(x) / 60));
  const weekMin = days.reduce((a, x) => a + dayMin(x), 0);
  const overDays = days.filter(x => dayMin(x) > d.capMin).length;
  const wsd = dt(ws), wed = dt(days[6]);
  const items = s.tasks.filter(x => x.day === sel).sort((a, b) => Number(a.done) - Number(b.done) || RANK[a.priority] - RANK[b.priority]);

  return (
    <>
      <div className="eyebrow">Week {isoWeek(t)}</div>
      <h1 className="display week">{wsd.getDate()} {MON[wsd.getMonth()]} – {wed.getDate()} {MON[wed.getMonth()]}</h1>
      <div className="sub">{fmtDur(weekMin)} planned · {overDays ? plural(overDays, 'day') + ' over' : 'no days over'} · Claude {d.left}% left</div>
      <div className="week-rows">
        {days.map(x => {
          const its = s.tasks.filter(q => q.day === x), tot = dayMin(x), dd = dt(x);
          const segs = AREAS.map(a => ({ a, w: its.filter(q => q.area === a).reduce((n, q) => n + q.est, 0) / 60 / maxH * 100 })).filter(z => z.w > 0);
          return (
            <div key={x} className={'week-row' + (sel === x ? ' sel' : '') + (x < t ? ' past' : '') + (x === t ? ' today' : '')} onClick={() => setSel(x)}>
              <div className="week-day">
                <div className={'l' + (tot > d.capMin ? ' over' : '')}>{DOW[dd.getDay()]}</div>
                <div className="d">{dd.getDate()}</div>
              </div>
              <div className="bar">
                {segs.map(sg => <div key={sg.a} style={{ width: sg.w + '%', background: AREA[sg.a].c }} />)}
                <div className="cap" style={{ left: (s.settings.capacity_hours / maxH * 100) + '%' }} />
              </div>
              <div className={'week-total' + (tot > d.capMin ? ' over' : '')}>{tot ? fmtDur(tot) : '–'}</div>
            </div>
          );
        })}
      </div>
      <div className="row-gap" style={{ gap: 8, marginTop: 18 }}>
        <button className="btn ink big" onClick={() => ask(P.balanceWeek, { label: 'Balance my week', priority: 'high' })}>Balance my week</button>
        <button className="btn big" onClick={() => ask(P.review(ws), { label: 'Weekly review', priority: 'low' })}>Weekly review</button>
      </div>
      <h2 className="section-title">{sel === t ? 'Today' : fmtDay(sel)}</h2>
      {items.map(x => (
        <div key={x.id} className={'list-row' + (x.done ? ' done' : '')}>
          <button className="check" aria-label={(x.done ? 'Reopen ' : 'Complete ') + x.title} style={{ borderColor: AREA[x.area].c, background: x.done ? AREA[x.area].c : 'transparent' }} onClick={() => patchTask(x, { done: !x.done })} />
          <span className="t">{x.title}</span>
          <span className="m">{x.area} · {fmtDur(x.est)}</span>
        </div>
      ))}
      {items.length === 0 && <div className="muted-line" style={{ padding: '10px 0' }}>Nothing planned.</div>}
    </>
  );
}
