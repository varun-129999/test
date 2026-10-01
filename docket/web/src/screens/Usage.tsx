import { useEffect, useRef, useState } from 'react';
import { derive, useDocket } from '../ctx';
import { DOWL, ago, plural } from '../format';

/** A range input that shows its value while dragging and saves once the owner stops. */
function Slider({ value, min, max, step = 1, onCommit, label }: { value: number; min: number; max: number; step?: number; onCommit: (v: number) => void; label: string }) {
  const [v, setV] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setV(value), [value]);
  const change = (n: number) => {
    setV(n);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(n), 350);
  };
  return <input type="range" aria-label={label} min={min} max={max} step={step} value={v} onChange={e => change(+e.target.value)} style={{ marginTop: 12 }} />;
}

export function Usage() {
  const { s, act } = useDocket();
  const d = derive(s);
  const u = s.usage, st = s.settings;
  const used = d.used, left = d.left;
  const heldPct = st.high_only ? Math.min(st.reserve_pct, left) : 0;
  const freePct = left - heldPct;

  const ps = new Date(u.period_start).getTime(), reset = new Date(u.resets_at).getTime(), now = Date.now();
  const hrsLeft = Math.max(0, (reset - now) / 36e5);
  const elapsed = Math.max(0.02, (now - ps) / (reset - ps));
  const rate = used / elapsed;
  let pace: string;
  if (rate > 100) {
    const out = new Date(ps + (100 / rate) * (reset - ps)), hh = out.getHours();
    pace = 'At this pace you run out ' + DOWL[out.getDay()] + (hh < 12 ? ' morning' : hh < 18 ? ' afternoon' : ' evening') + '.';
  } else pace = 'At this pace you finish the week with about ' + Math.round(100 - rate) + '% left.';

  const [url, setUrl] = useState(st.claude_url);
  useEffect(() => setUrl(st.claude_url), [st.claude_url]);

  return (
    <>
      <div className="eyebrow">Claude this week</div>
      <div className="big-num">
        <span className="n">{left}%</span><span className="l">left</span>
        {u.estimated && <span className="est-tag" title={`You reported ${u.used_pct}% used. Docket adds an estimate for Claude's Docket calls since then.`}>estimated</span>}
      </div>
      <div className="sub" style={{ marginTop: 4 }}>Resets Monday 09:00 · {hrsLeft >= 24 ? Math.floor(hrsLeft / 24) + ' days ' : ''}{Math.floor(hrsLeft % 24)} hours</div>
      <div style={{ fontSize: 15, marginTop: 10 }}>{pace}</div>
      <div className="cells" aria-hidden="true">
        {Array.from({ length: 100 }, (_, i) => <div key={i} className={'cell ' + (i < used ? 'used' : i < used + freePct ? 'free' : 'held')} />)}
      </div>
      <div className="cell-legend">
        <span><i style={{ background: 'var(--ink)' }} />Used {used}%</span>
        <span><i style={{ background: 'var(--chip)' }} />Free {freePct}%</span>
        <span><i style={{ boxShadow: 'inset 0 0 0 1.5px var(--accent)' }} />Held for high priority {heldPct}%</span>
      </div>
      <div className="usage-cards">
        <div className="card">
          <div className="kv"><span>Used so far</span><span>{u.used_pct}%</span></div>
          <Slider label="Used so far" min={0} max={100} value={u.used_pct} onCommit={v => act('PUT', '/usage', { used_pct: v })} />
          <div className="hint">Copy this from Claude's settings, or say "I've used 65%". {u.updated_at ? 'Updated ' + ago(u.updated_at) + '.' : 'Not set yet this week.'}{u.estimated ? ` Estimated ${u.estimated_used_pct}% now.` : ''}</div>
        </div>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Save for high priority</div>
            <button className={'toggle' + (st.high_only ? ' on' : '')} role="switch" aria-checked={st.high_only} aria-label="Save for high priority" onClick={() => act('PATCH', '/settings', { high_only: !st.high_only })}><i /></button>
          </div>
          <div className="kv small"><span>Keep back</span><span>{st.reserve_pct}%</span></div>
          <Slider label="Keep back" min={0} max={50} value={st.reserve_pct} onCommit={v => act('PATCH', '/settings', { reserve_pct: v })} />
          <div className="hint">When only this much is left, low-priority requests wait until the reset.</div>
        </div>
        <div className="card">
          <div className="kv"><span>Free time per day</span><span>{st.capacity_hours}h</span></div>
          <Slider label="Free time per day" min={2} max={12} step={0.5} value={st.capacity_hours} onCommit={v => act('PATCH', '/settings', { capacity_hours: v })} />
          <div className="hint">Claude has called Docket {plural(u.calls_since_reset, 'time')} since the reset.</div>
        </div>
      </div>
      <h2 className="section-title">Waiting for budget</h2>
      {s.held.map(h => (
        <div key={h.id} className="held-row">
          <span className="t">{h.label}</span>
          <button className="btn slim" onClick={() => act('DELETE', '/held/' + h.id)}>Remove</button>
          <button className="btn ink" onClick={() => act('POST', `/held/${h.id}/run`)}>Run anyway</button>
        </div>
      ))}
      {s.held.length === 0 && <div className="muted-line">Nothing held.</div>}
      <h2 className="section-title">Open Claude at</h2>
      <form className="row-gap" style={{ alignItems: 'center' }} onSubmit={e => { e.preventDefault(); act('PATCH', '/settings', { claude_url: url }); }}>
        <input value={url} onChange={e => setUrl(e.target.value)} aria-label="Claude link" style={{ flex: 1, minWidth: 220, padding: '8px 12px', borderRadius: 99, border: '1px solid var(--chip)', background: 'transparent', color: 'var(--ink)', fontSize: 13 }} />
        <button className="btn" type="submit" disabled={url === st.claude_url}>Save</button>
      </form>
      <div className="hint">Paste your Docket project's link so "Open Claude" starts there. The default opens a new chat.</div>
      <button className="btn" style={{ marginTop: 36, color: 'var(--muted)', padding: '8px 14px' }} onClick={() => { if (confirm('Replace your tasks with the sample data?')) act('POST', '/sample'); }}>Reset to sample data</button>
    </>
  );
}
