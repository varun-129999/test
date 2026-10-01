import { AREA, AREAS, derive, useDocket, type Screen } from '../ctx';
import { addDays, fmtDur, weekStart } from '../format';

export function useNav(): { key: Screen; label: string; count: string | number }[] {
  const { s } = useDocket();
  const d = derive(s);
  const ws = weekStart(d.t), we = addDays(ws, 6);
  const weekMin = s.tasks.filter(x => x.day >= ws && x.day <= we).reduce((a, x) => a + x.est, 0);
  return [
    { key: 'today', label: 'Today', count: d.open.length },
    { key: 'week', label: 'Week', count: fmtDur(weekMin) },
    { key: 'inbox', label: 'Inbox', count: s.finds.length || '' },
    { key: 'usage', label: 'Usage', count: d.left + '%' },
  ];
}

export const ringBg = (left: number) => `conic-gradient(var(--accent) 0 ${left}%, var(--chip) 0)`;

export function Sidebar() {
  const { s, screen, go } = useDocket();
  const d = derive(s);
  const ws = weekStart(d.t), we = addDays(ws, 6);
  const nav = useNav();
  const projNames = [...new Set(s.tasks.map(x => x.project).filter((p): p is string => !!p))];
  return (
    <aside className="side">
      <div className="brand">Docket</div>
      <div className="side-list">
        {nav.map(n => (
          <div key={n.key} className={'nav-item' + (screen === n.key ? ' on' : '')} onClick={() => go(n.key)}>
            <span>{n.label}</span>
            <span className={'count' + (n.key === 'inbox' && n.count ? ' hot' : '')}>{n.count}</span>
          </div>
        ))}
      </div>
      <div className="side-label">Areas this week</div>
      <div className="side-list">
        {AREAS.map(a => (
          <div key={a} className="side-row">
            <span className="sq" style={{ background: AREA[a].c }} />
            <span className="grow">{a}</span>
            <span className="dim">{fmtDur(s.tasks.filter(x => x.area === a && x.day >= ws && x.day <= we).reduce((q, x) => q + x.est, 0))}</span>
          </div>
        ))}
      </div>
      {projNames.length > 0 && <div className="side-label">Projects</div>}
      <div className="side-list">
        {projNames.map(p => {
          const it = s.tasks.filter(x => x.project === p);
          return (
            <div key={p} className="side-row" style={{ justifyContent: 'space-between' }}>
              <span>{p}</span><span className="dim">{it.filter(x => x.done).length}/{it.length}</span>
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <div className="usage-mini" onClick={() => go('usage')}>
        <div className="ring" style={{ width: 36, height: 36, background: ringBg(d.left) }}>
          <div className="ring-hole" style={{ width: 28, height: 28, background: 'var(--card)' }} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{d.left}% Claude left</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>Resets Mon 09:00</div>
        </div>
      </div>
    </aside>
  );
}
