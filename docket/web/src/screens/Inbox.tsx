import { useDocket } from '../ctx';
import { ago, fmtDay, fmtDur } from '../format';
import { Q } from '../prompts';

export function Inbox() {
  const { s, ask, act, now } = useDocket();
  return (
    <>
      <div className="eyebrow">From Gmail</div>
      <h1 className="display">Inbox</h1>
      <div className="lead">
        {s.emails.length
          ? `Emails Claude read with your Gmail connector, checked ${ago(s.inbox_checked_at, now)}. Docket never connects to Gmail itself.`
          : 'Nothing here yet. Tap Find tasks and deadlines, then run it in Claude with the Gmail connector turned on.'}
      </div>
      <button className="btn ink big claude" style={{ marginTop: 16 }} onClick={() => ask(Q.scanGmail())}>Find tasks and deadlines</button>
      {s.finds.length > 0 && (
        <div className="card finds">
          <div className="claude-label"><span className="dot" />Claude found</div>
          {s.finds.map(f => (
            <div key={f.id} className="find">
              <div className="t">
                <div>{f.title}</div>
                <div>{[f.area, f.est ? fmtDur(f.est) : '', f.due ? 'due ' + fmtDay(f.due) : '', f.priority].filter(Boolean).join(' · ')}</div>
              </div>
              <button className="btn slim" onClick={() => act('POST', `/finds/${f.id}/skip`)}>Skip</button>
              <button className="btn ink" onClick={() => act('POST', `/finds/${f.id}/add`)}>Add</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 18 }}>
        {s.emails.map(e => (
          <div key={e.id} className="email">
            <div className="top"><span className="from">{e.from}</span><span className="when">{e.when}</span></div>
            <div className="subject">{e.subject}</div>
            <div className="snippet">{e.snippet}</div>
          </div>
        ))}
      </div>
    </>
  );
}
