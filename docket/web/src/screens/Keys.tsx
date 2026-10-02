import { useEffect, useRef, useState } from 'react';
import { useDocket } from '../ctx';
import { addDays, isDay, weekStart } from '../format';
import { SHORTCUTS, emitKey, keyAction, onKey } from '../keys';

/** Focuses a field once it is on screen (after a screen change or a cleared search). */
function focusSoon(sel: string, tries = 6) {
  const el = document.querySelector<HTMLElement>(sel);
  if (el) { el.focus(); return; }
  if (tries > 0) requestAnimationFrame(() => focusSoon(sel, tries - 1));
}
const ADD = 'input[aria-label="Add a task"]', SEARCH = 'input[aria-label="Search tasks"]', COMPOSER = 'input[aria-label="Command"]';

/** Keyboard shortcuts on the Mac (wide layout), and the `?` card that lists them. */
export function Keys() {
  const ctx = useDocket();
  const [help, setHelp] = useState(false);
  const live = useRef(ctx);
  live.current = ctx;
  useEffect(() => onKey(a => { if (a === 'help') { setHelp(h => !h); return true; } }), []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const a = keyAction(e);
      if (!a) return;
      const { s, route, go, q, setQ, notify } = live.current;
      const handled = (() => {
        switch (a) {
          case 'help': setHelp(h => !h); return true;
          case 'blur': (document.activeElement as HTMLElement | null)?.blur(); return false;
          case 'escape': if (help) { setHelp(false); return true; } return emitKey('escape');
          case 'today': case 'week': case 'inbox': case 'usage': go(a); return true;
          case 'composer': focusSoon(COMPOSER); return true;
          case 'add':
            if (route.screen !== 'today') { focusSoon(COMPOSER); return true; }
            if (q) setQ('');
            focusSoon(ADD); return true;
          case 'search':
            if (route.screen !== 'today' && route.screen !== 'week') go('today');
            focusSoon(SEARCH); return true;
          case 'prev-week': case 'next-week': {
            if (route.screen === 'today') {
              const day = route.day && isDay(route.day) ? route.day : s.today, to = addDays(day, a === 'prev-week' ? -1 : 1);
              go('today', to === s.today ? undefined : to);
              return true;
            }
            if (route.screen !== 'week') return false;
            const cur = weekStart(s.today), ws = route.week && isDay(route.week) ? weekStart(route.week) : cur;
            const to = addDays(ws, a === 'prev-week' ? -7 : 7);
            go('week', to === cur ? undefined : to);
            return true;
          }
          case 'done': case 'delete':
            if (emitKey(a)) return true;
            notify(route.screen === 'today' ? `Open a task first (click it), then press ${a === 'done' ? 'e' : 'x'}.` : `Press ${a === 'done' ? 'e' : 'x'} on Today, with a task open.`);
            return true;
        }
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [help]);
  if (!help) return null;
  return (
    <div className="card keys-help" role="dialog" aria-label="Keyboard shortcuts">
      <div className="keys-head"><span>Keyboard shortcuts</span><button className="x" aria-label="Close" onClick={() => setHelp(false)}>×</button></div>
      <dl>
        {SHORTCUTS.map(([ks, what]) => (
          <div key={what} style={{ display: 'contents' }}>
            <dt>{ks.map(k => <kbd key={k}>{k}</kbd>)}</dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <div className="hint">They don't fire while you type in a field.</div>
    </div>
  );
}
