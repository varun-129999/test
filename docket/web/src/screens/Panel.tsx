import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { finished, lastArea, useDocket } from '../ctx';
import { age, fmtDay, fmtDur, plural } from '../format';
import { MicIcon } from '../icons';
import { Q, claudePrompt, parseQuickAdd, reviewWeek } from '../prompts';
import type { Outcome, PendingRequest } from '../types';
import { useNav } from './Sidebar';
import { OpenClaude, ToastView, type Toast } from './parts';

type SR = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: any) => void; onerror: (e: any) => void; onend: () => void };

export interface PanelHandle {
  /** Focus the composer and start listening. Must run inside the tap that asked for it. */
  listen(): void;
  /** Open the "Done by Claude" card. */
  showRecent(): void;
}

const OUTCOME: Record<Outcome, string> = { done: 'Done', needs_owner: 'Needs you', failed: "Couldn't finish", held: 'Held for budget', cancelled: 'Removed' };

/** The Claude panel (Mac) or bottom sheet (phone). Always mounted, so the phone can focus it in one tap. */
export function Panel({ ref, open, onClose, note, onNoteClose }: { ref: Ref<PanelHandle>; open: boolean; onClose: () => void; note: Toast | null; onNoteClose: () => void }) {
  const { s, wide, go, act, ask, addTask, notify, now } = useDocket();
  const [input, setInput] = useState('');
  const [heard, setHeard] = useState(false);
  const [hint, setHint] = useState('');
  const [copied, setCopied] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);
  const [hl, setHl] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const el = useRef<HTMLElement>(null);
  const recentEl = useRef<HTMLDivElement>(null);
  const mic = useMic(t => { setInput(t); setHeard(false); }, t => { setInput(t); setHeard(true); }, msg => setHint(msg));

  const recent = finished(s.recent);
  const openRecent = () => {
    const unseen = recent.filter(r => !r.seen).map(r => r.id);
    setHl(new Set(unseen));
    setRecentOpen(true);
    window.setTimeout(() => recentEl.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 260);
    if (unseen.length) act('POST', '/requests/seen', { ids: unseen });
  };
  useImperativeHandle(ref, () => ({
    listen: () => {
      inputRef.current?.focus();
      setHint('');
      if (mic.supported) mic.start();
      else setHint("Use your keyboard's mic to dictate, or type.");
    },
    showRecent: openRecent,
  }));

  // On the phone, keep the sheet above the on-screen keyboard.
  useEffect(() => {
    const vv = window.visualViewport, node = el.current;
    if (wide || !open || !vv || !node) return;
    const on = () => {
      node.style.setProperty('--kb', Math.max(0, window.innerHeight - vv.height - vv.offsetTop) + 'px');
      node.style.setProperty('--vvh', vv.height + 'px');
    };
    on();
    vv.addEventListener('resize', on);
    vv.addEventListener('scroll', on);
    return () => { vv.removeEventListener('resize', on); vv.removeEventListener('scroll', on); node.style.removeProperty('--kb'); node.style.removeProperty('--vvh'); };
  }, [wide, open]);

  const quick = parseQuickAdd(input, s.today, { area: lastArea() });
  const send = async (text = input) => {
    const t = text.trim();
    if (!t) return;
    setHeard(false);
    setHint('');
    if (t.startsWith('+')) {
      const qa = parseQuickAdd(t, s.today, { area: lastArea() });
      if (!qa) { notify('Type a title after the +.', { kind: 'error' }); return; }
      setInput('');
      await addTask(qa);
      return;
    }
    setInput('');
    ask(Q.command(t));
  };
  const rw = reviewWeek(s.today, s.review?.week_start);
  const chips = [
    { label: 'Plan my day', run: () => ask(Q.planDay()) },
    { label: 'Balance week', run: () => ask(Q.balanceWeek()) },
    { label: 'Weekly review', run: () => ask(Q.review(rw)) },
    { label: 'Scan Gmail', run: () => ask(Q.scanGmail()) },
  ];
  const prompt = claudePrompt(s.requests);
  const flashCopied = (k: string) => { setCopied(k); window.setTimeout(() => setCopied(''), 4000); };
  const copy = () => { navigator.clipboard?.writeText(prompt).then(() => flashCopied('prompt'), () => notify("Couldn't copy. Select the text in Claude instead.", { kind: 'error' })); };
  const unseen = recent.filter(r => !r.seen).length;
  const notice = s.reset_notice;

  return (
    <aside ref={el} className={'panel' + (open ? ' open' : '')} aria-label="Claude" role={wide ? 'complementary' : 'dialog'} aria-modal={wide ? undefined : true}>
      {!wide && <button className="grabber" aria-label="Close" onClick={onClose}><div /></button>}
      <div className="panel-scroll">
        <div className="card">
          <div className="claude-label"><span className="dot" />Claude<span className="busy">{mic.listening ? 'Listening…' : s.requests.length ? s.requests.length + ' waiting' : ''}</span></div>
          {s.last_cmd && <div className="reply-cmd">"{s.last_cmd}"</div>}
          <div className="reply">{hint || s.reply || 'Tell me what to add, move or plan.'}</div>
          {!s.last_cmd && <div className="hint">Start with + to add a task yourself, without Claude: "+ groceries 45m tomorrow".</div>}
        </div>

        {s.requests.length > 0 && (
          <div className="card queue">
            <div className="moves-head">Waiting for Claude</div>
            {s.requests.map(r => (
              <div key={r.id} className="queue-row">
                <span className="t">{r.label}</span>
                <span className="age" title={new Date(r.created_at).toLocaleString()}>{age(r.created_at, now)}</span>
                <button className="btn slim" onClick={() => act('DELETE', '/requests/' + r.id)}>Remove</button>
              </div>
            ))}
            <div className="row-gap">
              <OpenClaude onCopied={() => flashCopied('open')} />
              <button className="btn" onClick={copy}>{copied === 'prompt' ? 'Copied' : 'Copy prompt'}</button>
            </div>
            <div className="hint" style={{ marginTop: 0 }}>
              {copied === 'open' ? "Copied; paste it if it isn't filled in." : 'Nothing runs until you open Claude. It runs in your own chat, on your plan.'}
            </div>
          </div>
        )}

        {s.moves.length > 0 && (
          <div className="card moves">
            <div className="moves-head">{s.moves.length > 1 ? 'Move these?' : 'Suggested move'}</div>
            {s.moves.map(m => (
              <div key={m.id} className="move">
                <div className="t">
                  <div>{m.title} <span className="to">→ {fmtDay(m.to_day)}</span></div>
                  {m.reason && <div className="r">{m.reason}</div>}
                </div>
                <button className="btn slim" onClick={() => act('POST', `/moves/${m.id}/resolve`, { approve: false })}>Skip</button>
                <button className="btn ink" onClick={() => act('POST', `/moves/${m.id}/resolve`, { approve: true })}>Move</button>
              </div>
            ))}
            {s.moves.length > 1 && (
              <div className="row-gap moves-all">
                <button className="btn slim" onClick={() => act('POST', '/moves/resolve-all', { approve: false })}>Skip all</button>
                <button className="btn ink" onClick={() => act('POST', '/moves/resolve-all', { approve: true })}>Move all</button>
              </div>
            )}
          </div>
        )}

        {recent.length > 0 && (
          <div ref={recentEl} className="card recent">
            <button className="recent-head" aria-expanded={recentOpen} onClick={() => (recentOpen ? setRecentOpen(false) : openRecent())}>
              <span>Done by Claude</span>
              {unseen > 0 && <span className="new">{unseen} new</span>}
              <span className="go">{recentOpen ? 'Hide' : 'Show'}</span>
            </button>
            {recentOpen && recent.map(r => <RecentRow key={r.id} r={r} hl={hl.has(r.id)} now={now} />)}
          </div>
        )}

        {s.finds.length > 0 && (
          <button className="card link-card" onClick={() => go('inbox')}>
            <span>{plural(s.finds.length, 'task')} found in your inbox</span><span className="go">View</span>
          </button>
        )}
        {s.held.length > 0 && (
          <button className="card link-card dashed" onClick={() => go('usage')}>
            <span>{notice ? `Your budget reset. ${plural(notice.n, 'request')} ${notice.n === 1 ? 'was' : 'were'} waiting` : `${plural(s.held.length, 'request')} waiting for budget`}</span><span className="go">View</span>
          </button>
        )}
        {s.review && (
          <div className="card">
            <div className="review-head"><span>Weekly review</span><button onClick={() => act('POST', `/reviews/${s.review!.week_start}/dismiss`)}>Close</button></div>
            <div className="review-text">{s.review.text}</div>
          </div>
        )}
      </div>
      {note && <ToastView key={note.id} t={note} where="sheet" onClose={onNoteClose} />}
      <div className="composer">
        <div className="row-gap chips">
          {chips.map(c => <button key={c.label} className="btn claude" onClick={c.run}>{c.label}</button>)}
        </div>
        {heard ? (
          <div className="row-gap heard">
            <button className="btn ink claude" onClick={() => send()}>Send to Claude</button>
            <button className="btn" onClick={() => send(input.trim().startsWith('+') ? input : '+ ' + input)}>Add as task</button>
            <button className="btn" onClick={() => { setInput(''); setHeard(false); }}>Cancel</button>
          </div>
        ) : quick ? (
          <div className="qa-preview">Adds without Claude: <b>{quick.title}</b> · {quick.day === s.today ? 'Today' : fmtDay(quick.day!)} · {fmtDur(quick.est)} · {quick.area}{quick.priority !== 'med' ? ' · ' + quick.priority : ''}{quick.due ? ' · due ' + fmtDay(quick.due) : ''}</div>
        ) : null}
        <form className="pill" onSubmit={e => { e.preventDefault(); send(); }}>
          <input ref={inputRef} value={input} onChange={e => { setInput(e.target.value); setHeard(false); }} placeholder={mic.listening ? 'Listening…' : 'Say or type a command'} aria-label="Command" enterKeyHint="send" maxLength={2000} />
          <button type="button" className={'mic' + (mic.listening ? ' listening' : '')} aria-label={mic.listening ? 'Stop listening' : 'Speak'} onClick={() => (mic.supported ? mic.toggle() : setHint("Voice input isn't available in this browser. Use your keyboard's dictation, or type."))}><MicIcon /></button>
        </form>
      </div>
    </aside>
  );
}

function RecentRow({ r, hl, now }: { r: PendingRequest; hl: boolean; now: number }) {
  return (
    <div className={'recent-row' + (hl ? ' unseen' : '')}>
      <div className="top"><span className="t">{r.label}</span><span className="when">{age(r.completed_at ?? r.created_at, now)}</span></div>
      {r.outcome && r.outcome !== 'done' && <span className={'outcome ' + r.outcome}>{OUTCOME[r.outcome] ?? r.outcome}</span>}
      {r.reply && <div className="r">{r.reply}</div>}
      {r.detail && <div className="r">{r.detail}</div>}
    </div>
  );
}

/**
 * Browser speech recognition, where the browser has it. start() must be called from the tap
 * itself. The result is shown with Send / Add as task / Cancel, never sent on its own.
 */
function useMic(onText: (t: string) => void, onFinal: (t: string) => void, onMessage: (msg: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<SR | null>(null);
  const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const start = () => {
    if (!Ctor || listening) return;
    const r: SR = new Ctor();
    r.lang = navigator.language || 'en-GB';
    r.interimResults = true;
    r.continuous = false;
    let finalText = '';
    r.onresult = e => { let txt = ''; for (const res of e.results) txt += res[0].transcript; finalText = txt; onText(txt); };
    r.onerror = e => {
      setListening(false);
      if (e.error !== 'no-speech' && e.error !== 'aborted') onMessage(e.error === 'not-allowed' ? 'Microphone access is blocked. Allow it in your browser, or type instead.' : 'Voice error: ' + e.error);
    };
    r.onend = () => { setListening(false); if (finalText.trim()) onFinal(finalText.trim()); };
    rec.current = r;
    setListening(true);
    onText('');
    try { r.start(); } catch { setListening(false); }
  };
  const toggle = () => (listening ? rec.current?.stop() : start());
  return { listening, start, toggle, supported: !!Ctor };
}

/** Bottom tab bar (phone). The mic opens the Claude sheet, focused and listening. */
export function TabBar() {
  const { route, go, mic } = useDocket();
  const nav = useNav();
  const tab = (n: (typeof nav)[number]) => (
    <button key={n.key} className={'tab' + (route.screen === n.key ? ' on' : '')} aria-current={route.screen === n.key ? 'page' : undefined} onClick={() => go(n.key)}>
      {n.label}{n.extra && <span className="tab-badge">{n.extra}</span>}
    </button>
  );
  return (
    <nav className="tabbar">
      {nav.slice(0, 2).map(tab)}
      <button className="tab-mic" aria-label="Talk to Claude" onClick={mic}><MicIcon size={28} stroke={2} /></button>
      {nav.slice(2).map(tab)}
    </nav>
  );
}
