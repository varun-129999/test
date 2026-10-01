import { useRef, useState } from 'react';
import { useDocket } from '../ctx';
import { fmtDay, plural, weekStart } from '../format';
import { MicIcon } from '../icons';
import { P, claudeLink, claudePrompt } from '../prompts';
import { useNav } from './Sidebar';

type SR = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: (e: any) => void; onerror: (e: any) => void; onend: () => void };

/** The Claude panel (Mac) or bottom sheet (phone). */
export function Panel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { s, wide, go, act, ask, flash } = useDocket();
  const [input, setInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const mic = useMic(text => setInput(text), text => send(text), msg => { setNote(msg); inputRef.current?.focus(); });

  const send = (text = input) => {
    const t = text.trim();
    if (!t) return;
    setInput('');
    setNote('');
    ask(t, { label: t, priority: 'high' });
  };
  const ws = weekStart(s.today);
  const chips = [
    { label: 'Plan my day', run: () => ask(P.planDay, { label: 'Plan my day', priority: 'high' }) },
    { label: 'Balance week', run: () => ask(P.balanceWeek, { label: 'Balance my week', priority: 'high' }) },
    { label: 'Weekly review', run: () => ask(P.review(ws), { label: 'Weekly review', priority: 'low' }) },
    { label: 'Scan Gmail', run: () => ask(P.scanGmail, { label: 'Find tasks in Gmail', priority: 'high' }) },
  ];
  const prompt = claudePrompt(s.requests);
  const copy = () => { navigator.clipboard?.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  return (
    <aside className={'panel' + (open ? ' open' : '')} aria-label="Claude">
      {!wide && <div className="grabber" onClick={onClose}><div /></div>}
      <div className="panel-scroll">
        <div className="card">
          <div className="claude-label"><span className="dot" />Claude<span className="busy">{mic.listening ? 'Listening…' : s.requests.length ? s.requests.length + ' queued' : ''}</span></div>
          {s.last_cmd && <div className="reply-cmd">"{s.last_cmd}"</div>}
          <div className="reply">{note || s.reply}</div>
        </div>

        {s.requests.length > 0 && (
          <div className="card queue">
            <div className="moves-head">Waiting for Claude</div>
            {s.requests.map(r => (
              <div key={r.id} className="queue-row">
                <span className="t">{r.label}</span>
                <button className="btn slim" onClick={() => act('DELETE', '/requests/' + r.id)}>Remove</button>
              </div>
            ))}
            <div className="row-gap">
              <a className="btn ink" style={{ textDecoration: 'none' }} href={claudeLink(s.settings.claude_url, prompt)} target="_blank" rel="noreferrer" onClick={() => flash('Opening Claude…')}>Open Claude</a>
              <button className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button>
            </div>
            <div className="hint" style={{ marginTop: 0 }}>Runs in your own Claude chat, on your plan. Or just open the Docket project and say "check Docket".</div>
          </div>
        )}

        {s.moves.length > 0 && (
          <div className="card moves">
            <div className="moves-head">Suggested moves</div>
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
          </div>
        )}

        {s.finds.length > 0 && (
          <div className="card link-card" onClick={() => go('inbox')}>
            <span>{plural(s.finds.length, 'task')} found in your inbox</span><span className="go">View</span>
          </div>
        )}
        {s.held.length > 0 && (
          <div className="card link-card dashed" onClick={() => go('usage')}>
            <span>{plural(s.held.length, 'request')} waiting for budget</span><span className="go">View</span>
          </div>
        )}
        {s.review && (
          <div className="card">
            <div className="review-head"><span>Weekly review</span><button onClick={() => act('POST', `/reviews/${s.review!.week_start}/dismiss`)}>Close</button></div>
            <div className="review-text">{s.review.text}</div>
          </div>
        )}
      </div>
      <div className="composer">
        <div className="row-gap chips">
          {chips.map(c => <button key={c.label} className="btn" onClick={c.run}>{c.label}</button>)}
        </div>
        <form className="pill" onSubmit={e => { e.preventDefault(); send(); }}>
          <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} placeholder={mic.listening ? 'Listening…' : 'Say or type a command'} aria-label="Command" enterKeyHint="send" />
          <button type="button" className={'mic' + (mic.listening ? ' listening' : '')} title="Speak" aria-label="Speak" onClick={mic.toggle}><MicIcon /></button>
        </form>
      </div>
    </aside>
  );
}

/**
 * Browser speech recognition, as a fallback. In normal use, voice goes through
 * the Claude apps' own dictation.
 */
function useMic(onText: (t: string) => void, onFinal: (t: string) => void, onUnsupported: (msg: string) => void) {
  const [listening, setListening] = useState(false);
  const rec = useRef<SR | null>(null);
  const toggle = () => {
    if (listening) { rec.current?.stop(); return; }
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) { onUnsupported("Voice input isn't supported in this browser. Type below, or use dictation in the Claude app."); return; }
    const r: SR = new Ctor();
    r.lang = navigator.language || 'en-GB';
    r.interimResults = true;
    r.continuous = false;
    let finalText = '';
    r.onresult = e => { let txt = ''; for (const res of e.results) txt += res[0].transcript; finalText = txt; onText(txt); };
    r.onerror = e => { setListening(false); onUnsupported(e.error === 'not-allowed' ? 'Microphone access is blocked. Allow it in your browser, or type instead.' : 'Voice error: ' + e.error); };
    r.onend = () => { setListening(false); if (finalText.trim()) onFinal(finalText); };
    rec.current = r;
    setListening(true);
    onText('');
    try { r.start(); } catch { setListening(false); }
  };
  return { listening, toggle };
}

/** Bottom tab bar (phone). The mic opens the Claude sheet. */
export function TabBar() {
  const { screen, go, openSheet } = useDocket();
  const nav = useNav();
  const tab = (n: (typeof nav)[number]) => <button key={n.key} className={'tab' + (screen === n.key ? ' on' : '')} onClick={() => go(n.key)}>{n.label}</button>;
  return (
    <nav className="tabbar">
      {nav.slice(0, 2).map(tab)}
      <button className="tab-mic" aria-label="Talk to Claude" onClick={() => { openSheet(); setTimeout(() => (document.querySelector('.mic') as HTMLButtonElement | null)?.click(), 50); }}><MicIcon size={28} stroke={2} /></button>
      {nav.slice(2).map(tab)}
    </nav>
  );
}
