// The prompts the app's "Ask Claude" buttons queue. Claude runs them in the owner's own
// Claude chat (on their plan), never from this app. Prompts name tasks by id only: titles are
// data Claude reads from Docket, not text the owner should be sending as instructions.
import { addDays, dt, weekStart } from './format';
import type { Area, Energy, Origin, OriginKind, PendingRequest, Priority, Task, TaskInput } from './types';

/** What the UI queues: the prompt, a short label for lists, and the priority the budget guard sees. */
export interface AskSpec { prompt: string; label: string; priority: Priority; taskId?: string }

const MAX_LABEL = 120, MAX_PROMPT = 2000;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const sentence = (s: string) => s.trim().replace(/[\s.]+$/, '');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export const ORIGIN_LABEL: Record<OriginKind, string> = { chat: 'Chat', cowork: 'Cowork', claude_code: 'Claude Code', email: 'Email', docket: 'Docket' };
const ORIGIN_WORD: Record<OriginKind, string> = { chat: 'chat', cowork: 'Cowork', claude_code: 'Claude Code', email: 'email', docket: 'Docket' };
const httpsUrl = (u: string | null | undefined) => {
  const v = u?.trim();
  if (!v || !/^https:\/\/\S+$/i.test(v)) return null;
  try { return new URL(v).protocol === 'https:' ? v : null; } catch { return null; }
};

export const originOf = (t: Pick<Task, 'origin_kind' | 'origin_title' | 'origin_url'>): Origin | null =>
  t.origin_kind || t.origin_title || t.origin_url ? { kind: t.origin_kind, title: t.origin_title, url: t.origin_url } : null;

/** "From Cowork: Q4 deck", for a task's meta line. */
export function originText(o: Origin | null | undefined): string {
  if (!o) return '';
  const kind = o.kind ? ORIGIN_LABEL[o.kind] ?? '' : '', title = o.title ? oneLine(o.title) : '';
  return kind && title ? `From ${kind}: ${title}` : kind ? 'From ' + kind : title ? 'From ' + title : o.url ? 'From a link' : '';
}

/**
 * "Continue in Q4 deck": where Give to Claude goes when the task came from a chat or session
 * with a link. Null without an https link, so the app falls back to Open Claude.
 */
export function continueLink(o: Origin | null | undefined): { url: string; label: string; name: string } | null {
  const url = httpsUrl(o?.url);
  if (!o || !url) return null;
  const name = clip((o.title && oneLine(o.title)) || (o.kind && ORIGIN_LABEL[o.kind]) || 'the original chat', 40);
  return { url, label: 'Continue in ' + name, name };
}

/** "This task came from Cowork 'Q4 deck' (https://…); continue there if you are not already in it." */
export function originSentence(o: Origin | null | undefined): string {
  if (!o) return '';
  const where = [o.kind ? ORIGIN_WORD[o.kind] ?? '' : '', o.title ? `'${oneLine(o.title)}'` : ''].filter(Boolean).join(' ') || 'another chat';
  const url = httpsUrl(o.url);
  return `This task came from ${where}${url ? ` (${url})` : ''}; continue there if you are not already in it.`;
}

const forTask = (verb: string, t: Task, prompt: string): AskSpec => ({ prompt, label: clip(verb + ': ' + t.title, MAX_LABEL), priority: t.priority, taskId: t.id });

export const P = {
  planDay: 'Plan my day. Include tasks carried over from earlier days. If today is over my free time, propose moves for lower-priority tasks to days this week with room. Suggest an order based on energy.',
  balanceWeek: 'Balance my week: propose moves so no day goes over my free time. Keep high-priority tasks near their due dates.',
  review: (ws: string) => `Write my weekly review for the week starting ${ws}: what got done, what slipped, what to focus on next week. Compare it with that week's plan if there is one. Under 80 words. Save it with save_review.`,
  scanGmail: 'Use my Gmail connector to read my recent emails (last 2 days). Call record_emails with them so they show in Docket, then suggest_tasks for tasks and deadlines. Skip newsletters and anything already in Docket; if an email gives a deadline for an existing task, use update_task to set its due.',
  breakDown: (t: Task) => `Break down task ${t.id} into 3-6 concrete steps with set_steps, and update est if needed.`,
  estimate: (t: Task) => `Estimate how long task ${t.id} takes and update est. Tell me the estimate.`,
  draft: (t: Task) => `Write the draft for task ${t.id} and store it with attach_draft. If it's an email, find the thread with my Gmail connector and write the body only, ready to send.`,
  saveDraft: (t: Task) => `Save the draft on task ${t.id} to my Gmail drafts with the Gmail connector, then call attach_draft with the same text and the gmail_draft_id.`,
  give: (t: Task, instruction: string) => {
    const from = originSentence(originOf(t));
    const tail = `.${from ? ' ' + from : ''} Use Gmail, Drive or the web if needed. Put the result on the task with attach_result (or set_steps if it is a breakdown), then complete_request with a one-line reply; if you can't finish, complete_request with outcome needs_owner and say what you need.`;
    const head = `Do task ${t.id}`;
    // A long instruction gives way to the origin and the mechanics, so the prompt stays under the server's cap.
    const i = clip(sentence(instruction), Math.max(20, MAX_PROMPT - head.length - tail.length - 2));
    return `${head}${i ? ': ' + i : ''}${tail}`;
  },
  planWeek: (text: string) => {
    const tail = '. Add missing tasks with add_tasks (days with room, est, area, priority, energy), then propose_moves for existing tasks. Reply in two sentences.';
    const p = `Here is what I want this week: ${sentence(text)}${tail}`;
    // A plan near the 2,000-character cap would push the prompt over it; Claude can read it from the overview instead.
    return p.length <= MAX_PROMPT ? p : `Here is what I want this week: the plan saved in Docket (get_overview, week.plan)${tail}`;
  },
};

/** Ready-made requests with the priorities from the contract (section 2). */
export const Q = {
  planDay: (): AskSpec => ({ prompt: P.planDay, label: 'Plan my day', priority: 'high' }),
  balanceWeek: (): AskSpec => ({ prompt: P.balanceWeek, label: 'Balance my week', priority: 'high' }),
  review: (ws: string): AskSpec => ({ prompt: P.review(ws), label: 'Weekly review', priority: 'med' }),
  scanGmail: (): AskSpec => ({ prompt: P.scanGmail, label: 'Find tasks in Gmail', priority: 'med' }),
  command: (text: string): AskSpec => ({ prompt: clip(text.trim(), MAX_PROMPT), label: clip(text.trim(), MAX_LABEL), priority: 'high' }),
  planWeek: (text: string): AskSpec => ({ prompt: P.planWeek(text), label: 'Plan my week', priority: 'high' }),
  breakDown: (t: Task) => forTask('Break down', t, P.breakDown(t)),
  estimate: (t: Task) => forTask('Estimate', t, P.estimate(t)),
  draft: (t: Task) => forTask('Draft', t, P.draft(t)),
  saveDraft: (t: Task): AskSpec => ({ ...forTask('Save to Gmail', t, P.saveDraft(t)), priority: 'high' }),
  give: (t: Task, instruction: string) => forTask('Give to Claude', t, P.give(t, instruction)),
};

/**
 * Which week the review button reviews. On Monday and Tuesday, last week, unless its review
 * already exists; otherwise the current week.
 */
export function reviewWeek(today: string, lastReviewWeek: string | null | undefined): string {
  const ws = weekStart(today), prev = addDays(ws, -7), dow = dt(today).getDay();
  return (dow === 1 || dow === 2) && lastReviewWeek !== prev ? prev : ws;
}

/** Text to paste into (or prefill) a Claude chat for the queued requests. */
export function claudePrompt(reqs: Pick<PendingRequest, 'id' | 'prompt' | 'override'>[]): string {
  if (reqs.length === 1) {
    const r = reqs[0];
    return `${r.prompt}\n\nThis is Docket request ${r.id}${r.override ? ' (I approved it, so do it even at the reserve)' : ''}. Pass request_id ${r.id} to set_steps, attach_draft, attach_result or save_review, then call complete_request with a one-line reply.`;
  }
  if (!reqs.length) return 'Check Docket.';
  return `Check Docket: handle the ${reqs.length} queued requests (get_pending_requests), then call complete_request for each.`;
}

export function claudeLink(base: string, text: string): string {
  try {
    const u = new URL(base || 'https://claude.ai/new');
    if (u.protocol !== 'https:') throw new Error('not https');
    u.searchParams.set('q', text);
    return u.toString();
  } catch {
    return 'https://claude.ai/new?q=' + encodeURIComponent(text);
  }
}

// ---------- quick add ("+ groceries 45m tomorrow") ----------

const AREA_LIST: Area[] = ['Work', 'Personal', 'Health'];
const DAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const alt = (ws: string[]) => '(' + ws.sort((a, b) => b.length - a.length).join('|') + ')';
const REL = ['today', 'tonight', 'tomorrow', 'tmrw', 'tmr'];
// "sun", "sat" and "wed" are ordinary words too, so on their own they only count after on/next/by/due.
const DAY_ANY = alt([...REL, ...Object.keys(DAYS)]);
const DAY_BARE = alt([...REL, ...Object.keys(DAYS).filter(d => !['sun', 'sat', 'wed'].includes(d))]);
const MIN = '(?:m|min|mins|minutes?)', HRS = '(?:h|hr|hrs|hours?)';
// "Drive to work", "turn it low": an area or priority word right after these is part of the title.
const KEEP_AREA = new Set(['to', 'at', 'from', 'of', 'the', 'my', 'in', 'into', 'after', 'before', 'back']);
const KEEP_PRIORITY = new Set(['to', 'too', 'very', 'so', 'is', 'are', 'run', 'running', 'set', 'turn', 'keep', 'stay', 'go', 'fly', 'aim']);

function resolveDay(word: string, today: string): string {
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tonight') return today;
  if (w.startsWith('tom') || w.startsWith('tmr')) return addDays(today, 1);
  // A weekday name means its next occurrence: 1 to 7 days ahead, never today.
  const ahead = (DAYS[w] - dt(today).getDay() + 7) % 7 || 7;
  return addDays(today, ahead);
}

const lastWord = (s: string) => (/(\S+)$/.exec(s)?.[1] ?? '').toLowerCase();

/**
 * Parses a composer line that starts with "+" into a task, without Claude. Recognises, at the end
 * of the line and in any order: a duration ("45m", "1.5h", "1h30m", "20 minutes", "an hour"), a day
 * ("today", "tonight", "tomorrow", "fri", "on Friday", "next Mon"), a due date ("due Fri", "by
 * Friday"), an area word (work, personal, health), priority ("high", "low", "high priority") and
 * energy ("high energy"). Words earlier in the line stay in the title. Returns null if the line
 * does not start with "+" or has no title.
 */
export function parseQuickAdd(text: string, today: string, defaults: { area?: Area } = {}): TaskInput | null {
  const m = /^\s*\+\s*([\s\S]*)$/.exec(text);
  if (!m) return null;
  let est: number | undefined, day: string | undefined, due: string | undefined, area: Area | undefined, priority: Priority | undefined, energy: Energy | undefined;
  // Each rule looks at the end of the line; on a match it records the value and returns the line without it.
  const tail = (re: RegExp, apply: (g: RegExpExecArray, before: string) => string | null | false) => (rest: string) => {
    const g = re.exec(rest);
    return g && g[0].length ? apply(g, rest.slice(0, g.index)) || null : null;
  };
  const rules = [
    tail(/[\s,;.!]+$/, (_, b) => b),
    tail(new RegExp(`\\s(\\d+(?:\\.\\d+)?)\\s?${HRS}\\s?(\\d+)\\s?${MIN}?$`, 'i'), (g, b) => est === undefined && ((est = +g[1] * 60 + +g[2]), b)),
    tail(new RegExp(`\\s(\\d+(?:\\.\\d+)?)\\s?${HRS}$`, 'i'), (g, b) => est === undefined && ((est = +g[1] * 60), b)),
    tail(new RegExp(`\\s(\\d+(?:\\.\\d+)?)\\s?${MIN}$`, 'i'), (g, b) => est === undefined && ((est = +g[1]), b)),
    tail(/\shalf an hour$/i, (_, b) => est === undefined && ((est = 30), b)),
    tail(/\s(?:an|one) hour$/i, (_, b) => est === undefined && ((est = 60), b)),
    tail(new RegExp(`\\s(?:due|by)\\s${DAY_ANY}$`, 'i'), (g, b) => due === undefined && ((due = resolveDay(g[1], today)), b)),
    tail(new RegExp(`\\s(?:on|next|this)\\s${DAY_ANY}$`, 'i'), (g, b) => day === undefined && ((day = resolveDay(g[1], today)), b)),
    tail(new RegExp(`\\s${DAY_BARE}$`, 'i'), (g, b) => day === undefined && ((day = resolveDay(g[1], today)), b)),
    tail(/\s(high|low) energy$/i, (g, b) => energy === undefined && ((energy = g[1].toLowerCase() as Energy), b)),
    tail(/\s(high|med|medium|low) priority$/i, (g, b) => priority === undefined && ((priority = (g[1].toLowerCase().startsWith('med') ? 'med' : g[1].toLowerCase()) as Priority), b)),
    tail(/\s(high|urgent|low)$/i, (g, b) => priority === undefined && !KEEP_PRIORITY.has(lastWord(b)) && ((priority = g[1].toLowerCase() === 'low' ? 'low' : 'high'), b)),
    tail(/\s(work|personal|health)$/i, (g, b) => {
      if (area !== undefined || KEEP_AREA.has(lastWord(b)) || !lastWord(b)) return null;
      area = AREA_LIST.find(a => a.toLowerCase() === g[1].toLowerCase());
      return lastWord(b) === 'for' ? b.replace(/\s+for$/i, '') : b;
    }),
  ];
  let rest = ' ' + m[1].replace(/\s+/g, ' ').trim();
  for (let next: string | null = rest; next !== null;) {
    next = null;
    for (const rule of rules) if ((next = rule(rest)) !== null) { rest = next; break; }
  }
  const title = rest.trim().replace(/[\s,;:-]+$/, '');
  if (!title) return null;
  const out: TaskInput = {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    area: area ?? defaults.area ?? 'Work',
    day: day ?? today,
    est: Math.min(24 * 60, Math.max(5, Math.round(est ?? 30))),
    priority: priority ?? 'med',
    energy: energy ?? 'low',
  };
  if (due) out.due = due;
  return out;
}
