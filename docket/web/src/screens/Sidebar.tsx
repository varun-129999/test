import { AREA, AREAS, derive, useDocket, type Screen } from '../ctx';
import { addDays, fmtDur, weekStart } from '../format';
import { emitKey } from '../keys';

export function useNav(): { key: Screen; label: string; count: string | number; extra: string }[] {
  const { s } = useDocket();
  const d = derive(s);
  const ws = weekStart(d.t), we = addDays(ws, 6);
  const weekMin = s.tasks.filter(x => x.day >= ws && x.day <= we).reduce((a, x) => a + x.est, 0);
  return [
    { key: 'today', label: 'Today', count: d.open.length, extra: d.overdue.length ? '+' + d.overdue.length : '' },
    { key: 'week', label: 'Week', count: fmtDur(weekMin), extra: '' },
    { key: 'inbox', label: 'Inbox', count: s.finds.length || '', extra: '' },
    { key: 'usage', label: 'Usage', count: d.left + '%', extra: '' },
  ];
}

export const ringBg = (left: number) => `conic-gradient(var(--accent) 0 ${left}%, var(--chip) 0)`;

export function Sidebar() {
  const { s, route, go, setQ } = useDocket();
  const d = derive(s);
  const ws = weekStart(d.t), we = addDays(ws, 6);
  const nav = useNav();
  const projNames = [...new Set(s.tasks.map(x => x.project).filter((p): p is string => !!p))];
  return (
    <aside className="side">
      <div className="brand">Docket</div>
      <nav className="side-list">
        {nav.map(n => (
          <button key={n.key} className={'nav-item' + (route.screen === n.key ? ' on' : '')} aria-current={route.screen === n.key ? 'page' : undefined} onClick={() => go(n.key)}>
            <span>{n.label}</span>
            <span className={'count' + (n.key === 'inbox' && n.count ? ' hot' : '')}>{n.count}{n.extra && <span className="extra" title={n.extra.slice(1) + ' carried over'}>{n.extra}</span>}</span>
          </button>
        ))}
      </nav>
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
            <button key={p} className="side-row proj" title={'Show ' + p} onClick={() => { setQ(p); if (route.screen !== 'today' && route.screen !== 'week') go('today'); }}>
              <span className="grow">{p}</span><span className="dim">{it.filter(x => x.done).length}/{it.length}</span>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1 }} />
      <button className="keys-hint" onClick={() => emitKey('help')}>Keyboard shortcuts <kbd>?</kbd></button>
      <button className="usage-mini" onClick={() => go('usage')}>
        <div className="ring" style={{ width: 36, height: 36, background: ringBg(d.left) }}>
          <div className="ring-hole" style={{ width: 28, height: 28, background: 'var(--card)' }} />
        </div>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{d.left}% Claude left</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{s.usage.resets_label ? 'Resets ' + s.usage.resets_label : ''}</div>
        </div>
      </button>
    </aside>
  );
}
