import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { type DB, tx } from './db.js';
import { DOWL, addDays, ago, dt, fmtDay, fmtMoment, iso, isIsoDay, isoWeek, localIso, periodStart, tzName, weekDays, weekStart } from './dates.js';
import { AREAS, CAPS, ENERGIES, ORIGIN_KINDS, PRIORITIES, isHttpsUrl, isSafeUrl, type Area, type Energy, type OriginKind, type Priority } from './schemas.js';
import { REPEAT_FORMS, REPEAT_FROM, describeRepeat, nextOccurrence, parseRepeat, type RepeatFrom } from './repeat.js';
import { askClaude, parseQuickAdd } from './quick.js';
import { version } from './version.js';

export { AREAS, ENERGIES, ORIGIN_KINDS, PRIORITIES, type Area, type Energy, type OriginKind, type Priority };

export interface Step { text: string; done: boolean }
export interface Task {
  id: string; title: string; area: Area; project: string | null; day: string; due: string | null;
  est: number; priority: Priority; energy: Energy; done: boolean; completed_at: string | null; source: 'gmail' | null;
  draft: string | null; gmail_draft_id: string | null; notes: string | null; link: string | null;
  result: string | null; result_url: string | null; result_at: string | null;
  origin_kind: OriginKind | null; origin_title: string | null; origin_url: string | null;
  at: string | null; repeat: string | null; repeat_from: RepeatFrom; series_id: string | null;
  steps: Step[]; created_at: string; updated_at: string;
}
/** Where a task came from; only the fields that are set. */
export interface Origin { kind?: OriginKind; title?: string; url?: string }
export interface OriginIn { kind?: OriginKind | null; title?: string | null; url?: string | null }
export interface TaskInput {
  title: string; area: Area; project?: string | null; day?: string; due?: string | null;
  est: number; priority: Priority; energy: Energy; source?: 'gmail' | null; notes?: string | null; link?: string | null;
  origin?: OriginIn | null; at?: string | null; repeat?: string | null; repeat_from?: RepeatFrom | null;
}
export type TaskPatch = Partial<TaskInput> & { done?: boolean; result?: null };
/** The instance a completed recurring task created. */
export interface NextInstance { id: string; day: string }
export type StepIn = string | { text: string; done?: boolean };

export interface Settings {
  capacity_hours: number; reserve_pct: number; high_only: boolean; week_start: string; reset: string;
  pct_per_call: number; claude_url: string;
}
export type UsageSource = 'owner' | 'claude' | 'statusline';
export interface Usage {
  period_start: string; resets_at: string; resets_label: string; used_pct: number; left_pct: number;
  updated_at: string | null; source: UsageSource | null; est_pct: number; estimated: boolean; calls_since_reset: number;
  reserve_pct: number; high_only: boolean; at_reserve: boolean; near_reserve: boolean;
}
export interface Move { id: string; task_id: string; title: string; from_day: string; to_day: string; reason: string; status: string; created_at: string }
export interface HeldRequest { id: string; label: string; prompt: string; task_id: string | null; priority: Priority; created_at: string; tool?: string }
export type Outcome = 'done' | 'needs_owner' | 'failed' | 'held' | 'cancelled';
export interface PendingRequest {
  id: string; label: string; prompt: string; task_id: string | null; priority: Priority; override: boolean; created_at: string;
  status: 'pending' | 'done' | 'cancelled'; reply: string | null; outcome: Outcome | null; detail: string | null; seen: boolean; completed_at: string | null;
  /** Pending requests only: the task's origin, so Claude in another session leaves it for that one. */
  origin?: Origin;
}
export interface WeekPlan { week_start: string; text: string; updated_at: string }
export interface Email { id: string; from: string; subject: string; snippet: string; when: string; thread_id: string | null }
export interface Find { id: string; email_id: string | null; title: string; area: Area; project: string | null; due: string | null; est: number; priority: Priority; energy: Energy }
export interface TaskFilter {
  from?: string; to?: string; area?: Area; project?: string; q?: string; ids?: string[]; include_done?: boolean; limit?: number;
}

/** A user-facing error: the message is safe to show to Claude and the owner. */
export class DocketError extends Error {}

/** Rough relative cost of each tool call, used to estimate usage between self-reports. */
export const CALL_WEIGHTS: Record<string, number> = {
  get_overview: 1, list_tasks: 1, add_task: 1, add_tasks: 1.5, update_task: 0.5, update_tasks: 0.5, complete_task: 0.5, delete_task: 0.5,
  set_steps: 2, add_steps: 0.5, set_step: 0.25, propose_moves: 2, resolve_moves: 0.25, attach_draft: 3, attach_result: 3,
  get_usage: 0.25, set_usage: 0.25, set_settings: 0.25, get_pending_requests: 0.5, complete_request: 0.5, hold_request: 0.25,
  save_review: 2, set_week_plan: 0.5, record_emails: 2, suggest_tasks: 1,
};

export const BUDGET_NOTE = "Saved. You're at your reserve: no more below-high breakdowns, drafts or reviews in this chat unless the owner approved them.";

/** "Open Claude" only ever points at Claude itself, so a leaked token cannot turn it into a phishing link. */
export function isClaudeUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && /^(.*\.)?(claude\.ai|claude\.com)$/.test(u.hostname);
  } catch { return false; }
}

/** A link that does not say what it is: Claude Code session links are recognisable, email ones too. */
const guessKind = (url: string): OriginKind | null =>
  /^https:\/\/claude\.ai\/code\//i.test(url) ? 'claude_code' : /^https:\/\/claude\.ai\/chat\//i.test(url) ? 'chat' : /^https:\/\/mail\.google\.com\//i.test(url) ? 'email' : null;

/** The stored columns for an origin; null or an empty object clears all three. */
function originCols(o: OriginIn | null | undefined) {
  const url = o?.url?.trim() || null, title = o?.title?.trim().slice(0, 120) || null;
  return { origin_kind: o?.kind || (url ? guessKind(url) : null), origin_title: title, origin_url: url };
}

const pick = (kind: unknown, title: unknown, url: unknown): Origin | undefined =>
  kind || title || url ? { ...(kind ? { kind: kind as OriginKind } : {}), ...(title ? { title: String(title) } : {}), ...(url ? { url: String(url) } : {}) } : undefined;

export const originOf = (t: Task) => pick(t.origin_kind, t.origin_title, t.origin_url);

/** "cowork: Q4 deck" for the compact shapes: kind and title, never the link (it is long and Claude rarely needs it). */
export function originLabel(t: Task): string | undefined {
  if (!t.origin_kind && !t.origin_title && !t.origin_url) return;
  return [t.origin_kind, t.origin_title].filter(Boolean).join(': ') || 'link';
}

const id = (prefix = '') => prefix + randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toLowerCase().padEnd(6, '0');
const nowIso = (d: Date) => d.toISOString();
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const WEEK_MS = 7 * 864e5;
const RANK_SQL = `CASE priority WHEN 'high' THEN 0 WHEN 'med' THEN 1 ELSE 2 END`;
// Within a day: timed tasks first, by time, then by priority.
const ORDER_SQL = `day, at IS NULL, at, ${RANK_SQL}, created_at`;
const isTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isClaudeLink = (v: string) => /^https:\/\/claude\.ai\/(code|chat)\//i.test(v.trim());
const MAX_STEPS = 30;

type Row = Record<string, any>;

export interface Flags { sample: boolean }

/** The short task shape Claude reads in the overview and list_tasks. */
export function compactTask(t: Task, o: { day?: boolean; done?: boolean } = {}) {
  return {
    id: t.id, title: t.title, ...(o.day ? { day: t.day } : {}), area: t.area, ...(t.project ? { project: t.project } : {}),
    ...(t.due ? { due: t.due } : {}), ...(t.at ? { at: t.at } : {}), est: t.est, priority: t.priority, energy: t.energy,
    ...(o.done && t.done ? { done: true } : {}), ...(t.source ? { source: t.source } : {}),
    ...(t.steps.length ? { steps: `${t.steps.filter(x => x.done).length}/${t.steps.length}` } : {}),
    ...(t.draft ? { has_draft: true } : {}), ...(t.notes ? { has_notes: true } : {}), ...(t.result ? { has_result: true } : {}),
    ...(t.link ? { link: t.link } : {}), ...(originLabel(t) ? { origin: originLabel(t) } : {}),
    ...(t.repeat ? { repeat: t.repeat } : {}),
  };
}

export class Store {
  readonly events = new EventEmitter();
  readonly flags: Flags;
  private readonly now: () => Date;

  constructor(readonly db: DB, opts: { now?: () => Date; flags?: Partial<Flags> } = {}) {
    this.now = opts.now ?? (() => new Date());
    this.flags = { sample: false, ...opts.flags };
    this.events.setMaxListeners(100);
  }

  today() { return iso(this.now()); }
  private changed() { this.events.emit('change'); }
  private stamp() { return nowIso(this.now()); }

  // ---------- settings ----------

  settings(): Settings {
    const r = this.db.prepare('SELECT * FROM settings WHERE id = 1').get() as Row;
    return { capacity_hours: r.capacity_hours, reserve_pct: r.reserve_pct, high_only: !!r.high_only, week_start: r.week_start, reset: r.reset, pct_per_call: r.pct_per_call, claude_url: r.claude_url };
  }

  setSettings(p: { capacity_hours?: number; reserve_pct?: number; high_only?: boolean; claude_url?: string; reset?: string }): Settings {
    const cur = this.settings();
    const next = {
      capacity_hours: p.capacity_hours !== undefined ? clamp(Math.round(p.capacity_hours * 2) / 2, 0.5, 24) : cur.capacity_hours,
      reserve_pct: p.reserve_pct !== undefined ? clamp(Math.round(p.reserve_pct), 0, 100) : cur.reserve_pct,
      high_only: p.high_only !== undefined ? p.high_only : cur.high_only,
      claude_url: p.claude_url !== undefined ? p.claude_url.trim() || 'https://claude.ai/new' : cur.claude_url,
      reset: p.reset !== undefined ? p.reset : cur.reset,
    };
    if (!isClaudeUrl(next.claude_url)) throw new DocketError('claude_url must be an https link on claude.ai or claude.com');
    if (p.reset !== undefined && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2}$/.test(p.reset)) throw new DocketError('reset must look like "Mon 09:00"');
    this.db.prepare('UPDATE settings SET capacity_hours = ?, reserve_pct = ?, high_only = ?, claude_url = ?, reset = ? WHERE id = 1')
      .run(next.capacity_hours, next.reserve_pct, next.high_only ? 1 : 0, next.claude_url, next.reset);
    this.changed();
    return this.settings();
  }

  // ---------- usage ----------

  /**
   * The current weekly window. A reset moment reported by Claude Code's status line wins
   * (rolled by whole weeks so start <= now < start + 7d); otherwise the weekly reset spec.
   */
  private bounds(now: Date): { start: Date; resets: Date } {
    const ra = Date.parse(this.meta('resets_at') ?? '');
    if (Number.isFinite(ra)) {
      const base = ra - WEEK_MS;
      const start = base + Math.floor((now.getTime() - base) / WEEK_MS) * WEEK_MS;
      return { start: new Date(start), resets: new Date(start + WEEK_MS) };
    }
    const start = periodStart(now, this.settings().reset);
    const resets = new Date(start); resets.setDate(resets.getDate() + 7);
    return { start, resets };
  }

  private period() {
    const { start, resets } = this.bounds(this.now());
    const key = nowIso(start);
    let row = this.db.prepare('SELECT * FROM usage WHERE period_start = ?').get(key) as Row | undefined;
    const curKey = this.meta('usage_period');
    if (!row) {
      const prev = (curKey
        ? this.db.prepare('SELECT * FROM usage WHERE period_start = ?').get(curKey)
        : this.db.prepare('SELECT * FROM usage WHERE period_start < ? ORDER BY period_start DESC LIMIT 1').get(key)) as Row | undefined;
      // A boundary that moved without a reset (a first status-line report, a new reset time)
      // is still the same week: carry the figure over instead of dropping to 0%.
      const sameWeek = prev && Math.abs(start.getTime() - Date.parse(prev.period_start)) < WEEK_MS - 2 * 3600e3;
      if (sameWeek) {
        this.db.prepare('INSERT INTO usage (period_start, used_pct, updated_at, est_calls, source) VALUES (?, ?, ?, ?, ?)')
          .run(key, prev.used_pct, prev.updated_at, prev.est_calls, prev.source ?? null);
      } else {
        this.db.prepare('INSERT INTO usage (period_start, used_pct, updated_at, est_calls) VALUES (?, 0, NULL, 0)').run(key);
        // Held requests are not queued automatically: the owner decides (Usage › Queue all).
        const n = (this.db.prepare(`SELECT COUNT(*) n FROM held_requests WHERE status = 'held'`).get() as Row).n as number;
        if (prev && n) this.setMeta({ reset_notice: JSON.stringify({ n, at: key }) });
      }
      row = this.db.prepare('SELECT * FROM usage WHERE period_start = ?').get(key) as Row;
    }
    if (curKey !== key) this.setMeta({ usage_period: key });
    return { start, resets, key, row };
  }

  usage(): Usage {
    const s = this.settings();
    const { start, resets, row } = this.period();
    const used = row.used_pct as number;
    const est = Math.min(100, Math.round(used + (row.est_calls as number) * s.pct_per_call));
    const calls = (this.db.prepare('SELECT COUNT(*) n FROM call_log WHERE at >= ?').get(nowIso(start)) as Row).n as number;
    const atReserve = s.high_only && 100 - used <= s.reserve_pct;
    return {
      period_start: nowIso(start),
      resets_at: nowIso(resets),
      resets_label: fmtMoment(resets),
      used_pct: used,
      left_pct: 100 - used,
      updated_at: (row.updated_at as string | null) ?? null,
      source: (row.source as UsageSource | null) ?? null,
      est_pct: est,
      estimated: est !== used,
      calls_since_reset: calls,
      reserve_pct: s.reserve_pct,
      high_only: s.high_only,
      // The guard uses the reported figure only; the estimate is a guess and only nudges.
      at_reserve: atReserve,
      near_reserve: s.high_only && !atReserve && 100 - est <= s.reserve_pct,
    };
  }

  /** Weekly usage as reported by the owner, Claude or the status line. Also calibrates the per-call estimate. */
  setUsage(usedPct: number, o: { resets_at?: string; source?: UsageSource } = {}): Usage {
    if (!Number.isFinite(usedPct)) throw new DocketError('used_pct must be a number from 0 to 100');
    const pct = clamp(Math.round(usedPct), 0, 100);
    tx(this.db, () => {
      if (o.resets_at !== undefined) {
        const t = Math.round(Date.parse(o.resets_at) / 60000) * 60000;
        if (!Number.isFinite(t)) throw new DocketError('resets_at must be an ISO date-time');
        // The same weekly moment reported again (give or take a few minutes, any week) keeps the
        // stored one, so the period key, and its usage row, stay put.
        const old = Date.parse(this.meta('resets_at') ?? '');
        const drift = Number.isFinite(old) ? Math.abs(((((t - old) % WEEK_MS) + WEEK_MS * 1.5) % WEEK_MS) - WEEK_MS / 2) : Infinity;
        if (drift > 15 * 60000) this.setMeta({ resets_at: nowIso(new Date(t)) });
      }
      const { key, row } = this.period();
      const s = this.settings();
      // Only a recent report in this window teaches anything: a stale one would charge days of
      // other Claude use to Docket's calls. An unchanged figure is a sample too.
      const fresh = row.updated_at && this.now().getTime() - Date.parse(row.updated_at) < 3 * 864e5;
      if (fresh && row.est_calls >= 4 && pct >= row.used_pct) {
        const observed = (pct - row.used_pct) / row.est_calls;
        const next = clamp(0.8 * s.pct_per_call + 0.2 * observed, 0.05, 1.0);
        this.db.prepare('UPDATE settings SET pct_per_call = ? WHERE id = 1').run(Math.round(next * 1000) / 1000);
      }
      this.db.prepare('UPDATE usage SET used_pct = ?, updated_at = ?, est_calls = 0, source = ? WHERE period_start = ?')
        .run(pct, this.stamp(), o.source ?? 'owner', key);
    });
    this.changed();
    return this.usage();
  }

  logCall(tool: string) {
    const w = CALL_WEIGHTS[tool] ?? 0.5;
    const { key } = this.period();
    this.db.prepare('INSERT INTO call_log (at, tool, weight) VALUES (?, ?, ?)').run(this.stamp(), tool, w);
    this.db.prepare('UPDATE usage SET est_calls = est_calls + ? WHERE period_start = ?').run(w, key);
  }

  /** For tools that save below-high work at the reserve: a reminder, never a block. */
  budgetNote(task: Task | null, requestId?: string): string | undefined {
    if (task?.priority === 'high' || !this.usage().at_reserve) return;
    const r = requestId ? this.request(requestId) : undefined;
    if (r && (r.override || r.priority === 'high')) return;
    return BUDGET_NOTE;
  }

  // ---------- tasks ----------

  private rowToTask(r: Row): Task {
    const steps = (this.db.prepare('SELECT text, done FROM steps WHERE task_id = ? ORDER BY idx').all(r.id) as Row[])
      .map(s => ({ text: s.text as string, done: !!s.done }));
    return {
      id: r.id, title: r.title, area: r.area, project: r.project || null, day: r.day, due: r.due || null, est: r.est_min,
      priority: r.priority, energy: r.energy, done: !!r.done, completed_at: r.completed_at || null, source: r.source || null,
      draft: r.draft || null, gmail_draft_id: r.gmail_draft_id || null, notes: r.notes || null, link: r.link || null,
      result: r.result || null, result_url: r.result_url || null, result_at: r.result_at || null,
      origin_kind: r.origin_kind || null, origin_title: r.origin_title || null, origin_url: r.origin_url || null,
      at: r.at || null, repeat: r.repeat || null, repeat_from: r.repeat_from === 'done' ? 'done' : 'planned', series_id: r.series_id || null,
      steps, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  getTask(taskId: string): Task {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!r) throw new DocketError(`No task with id "${taskId}". Call list_tasks or get_overview for current ids.`);
    return this.rowToTask(r);
  }

  private taskWhere(f: TaskFilter) {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.ids?.length) { where.push(`id IN (${f.ids.map(() => '?').join(', ')})`); args.push(...f.ids); }
    if (f.from) { where.push('day >= ?'); args.push(f.from); }
    if (f.to) { where.push('day <= ?'); args.push(f.to); }
    if (f.area) { where.push('area = ?'); args.push(f.area); }
    if (f.project) { where.push('project = ? COLLATE NOCASE'); args.push(f.project); }
    if (f.q?.trim()) {
      const like = '%' + f.q.trim().replace(/[\\%_]/g, c => '\\' + c) + '%';
      where.push(`(title LIKE ? ESCAPE '\\' OR project LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    // Asking for tasks by id means those tasks, done or not.
    if (!(f.include_done ?? !!f.ids?.length)) where.push('done = 0');
    return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
  }

  /** Tasks by day, then time (timed first), then priority. */
  listTasks(f: TaskFilter = {}): Task[] {
    const { sql, args } = this.taskWhere(f);
    const limit = f.limit ? ` LIMIT ${Math.max(1, Math.floor(f.limit))}` : '';
    return (this.db.prepare(`SELECT * FROM tasks${sql} ORDER BY ${ORDER_SQL}${limit}`).all(...args) as Row[]).map(r => this.rowToTask(r));
  }

  /** list_tasks: bounded, with counts, compact unless asked for everything. */
  searchTasks(f: TaskFilter & { detail?: 'compact' | 'full' } = {}) {
    const { sql, args } = this.taskWhere(f);
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM tasks${sql}`).get(...args) as Row).n as number;
    const tasks = this.listTasks({ ...f, limit: f.limit ?? 30 });
    return {
      total, returned: tasks.length, truncated: total > tasks.length,
      tasks: f.detail === 'full' ? tasks : tasks.map(t => compactTask(t, { day: true, done: true })),
    };
  }

  /** Open minutes per day. */
  dayLoad(days: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    const q = this.db.prepare('SELECT COALESCE(SUM(est_min), 0) n FROM tasks WHERE day = ? AND done = 0');
    for (const d of [...new Set(days)].sort()) out[d] = (q.get(d) as Row).n as number;
    return out;
  }

  private checkFields(p: Partial<TaskInput>) {
    if (p.title !== undefined && !p.title.trim()) throw new DocketError('title is empty');
    if (p.area !== undefined && !AREAS.includes(p.area)) throw new DocketError(`area must be one of ${AREAS.join(', ')}`);
    if (p.priority !== undefined && !PRIORITIES.includes(p.priority)) throw new DocketError('priority must be high, med or low');
    if (p.energy !== undefined && !ENERGIES.includes(p.energy)) throw new DocketError('energy must be high or low');
    if (p.day !== undefined && !isIsoDay(p.day)) throw new DocketError('day must be YYYY-MM-DD');
    if (p.due && !isIsoDay(p.due)) throw new DocketError('due must be YYYY-MM-DD');
    if (p.est !== undefined && !(p.est > 0)) throw new DocketError('est must be a positive number of minutes');
    if (p.link && !isSafeUrl(p.link)) throw new DocketError('link must start with https://, http:// or mailto:');
    if (p.origin?.url && !isHttpsUrl(p.origin.url)) throw new DocketError('origin.url must be an https:// link');
    if (p.origin?.kind && !ORIGIN_KINDS.includes(p.origin.kind)) throw new DocketError(`origin.kind must be one of ${ORIGIN_KINDS.join(', ')}`);
    if (p.at && !isTime(p.at)) throw new DocketError('at must be a 24-hour time, "HH:MM"');
    if (p.repeat_from && !REPEAT_FROM.includes(p.repeat_from)) throw new DocketError('repeat_from must be planned or done');
  }

  /** The stored (canonical) form of a repeat rule; "weekly" and "monthly" take the task's day. */
  private repeatRule(v: string | null | undefined, day: string): string | null {
    if (!v?.trim()) return null;
    const r = parseRepeat(v, day);
    if (!r) throw new DocketError(`repeat "${v}" is not a rule Docket knows. Use ${REPEAT_FORMS}.`);
    return r;
  }

  private insertTask(t: TaskInput & { series_id?: string | null }): string {
    this.checkFields(t);
    const taskId = id(), stamp = this.stamp(), o = originCols(t.origin), day = t.day || this.today();
    this.db.prepare(`INSERT INTO tasks (id, title, area, project, day, due, est_min, priority, energy, done, source, notes, link, origin_kind, origin_title, origin_url,
      at, repeat, repeat_from, series_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      taskId, t.title.trim(), t.area, t.project?.trim() || null, day, t.due || null,
      Math.max(5, Math.round(t.est)), t.priority, t.energy, t.source || null, t.notes?.trim() || null, t.link?.trim() || null,
      o.origin_kind, o.origin_title, o.origin_url, t.at || null, this.repeatRule(t.repeat, day), t.repeat_from || 'planned', t.series_id ?? null, stamp, stamp);
    return taskId;
  }

  addTask(t: TaskInput): Task {
    const taskId = this.insertTask(t);
    this.changed();
    return this.getTask(taskId);
  }

  /** A brain dump in one transaction: all or nothing. */
  addTasks(list: TaskInput[]) {
    const added = tx(this.db, () => list.map(t => this.getTask(this.insertTask(t))));
    this.changed();
    return { added: added.map(t => ({ id: t.id, title: t.title, day: t.day })), day_load: this.dayLoad(added.map(t => t.day)) };
  }

  private patchTask(cur: Task, p: TaskPatch): { changed: boolean; next?: NextInstance } {
    this.checkFields(p);
    const cols: Record<string, string | number | null> = {};
    if (p.title !== undefined) cols.title = p.title.trim();
    if (p.area !== undefined) cols.area = p.area;
    if (p.project !== undefined) cols.project = p.project?.trim() || null;
    if (p.day !== undefined) cols.day = p.day;
    if (p.due !== undefined) cols.due = p.due || null;
    if (p.est !== undefined) cols.est_min = Math.max(5, Math.round(p.est));
    if (p.priority !== undefined) cols.priority = p.priority;
    if (p.energy !== undefined) cols.energy = p.energy;
    if (p.source !== undefined) cols.source = p.source || null;
    if (p.notes !== undefined) cols.notes = p.notes?.trim() || null;
    if (p.link !== undefined) cols.link = p.link?.trim() || null;
    // An origin replaces the old one as a whole: a new chat is a new place to continue.
    if (p.origin !== undefined) Object.assign(cols, originCols(p.origin));
    if (p.at !== undefined) cols.at = p.at || null;
    // null stops this task repeating; the instances already made stay.
    if (p.repeat !== undefined) cols.repeat = this.repeatRule(p.repeat, p.day ?? cur.day);
    if (p.repeat_from !== undefined) cols.repeat_from = p.repeat_from || 'planned';
    if (p.done !== undefined) {
      cols.done = p.done ? 1 : 0;
      if (!p.done) cols.completed_at = null;
      else if (!cur.done) cols.completed_at = this.stamp();
    }
    if (p.result === null) Object.assign(cols, { result: null, result_url: null, result_at: null });
    const keys = Object.keys(cols);
    if (!keys.length) return { changed: false };
    const next = tx(this.db, () => {
      this.db.prepare(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...Object.values(cols), this.stamp(), cur.id);
      // A manual move or completion makes pending suggestions for the task stale.
      if ((p.day !== undefined && p.day !== cur.day) || (p.done && !cur.done)) {
        this.db.prepare(`UPDATE moves SET status = 'skipped' WHERE task_id = ? AND status = 'pending'`).run(cur.id);
      }
      // Completing a recurring task makes the next one in the same transaction.
      return p.done && !cur.done ? this.spawnNext(this.getTask(cur.id)) : undefined;
    });
    return { changed: true, ...(next ? { next } : {}) };
  }

  /**
   * The next instance of a completed recurring task: a copy with its steps unticked, on the rule's
   * next day, in the same series. Made once: if the series already has an instance on or after
   * that day (the task was reopened and completed again), nothing is added.
   */
  private spawnNext(t: Task): NextInstance | undefined {
    if (!t.repeat) return;
    const series = t.series_id ?? t.id;
    const day = nextOccurrence(t.repeat, t.day, t.repeat_from, this.today());
    if (this.db.prepare('SELECT 1 FROM tasks WHERE series_id = ? AND id != ? AND day >= ? LIMIT 1').get(series, t.id, day)) return;
    if (!t.series_id) this.db.prepare('UPDATE tasks SET series_id = ? WHERE id = ?').run(series, t.id);
    const nextId = this.insertTask({
      title: t.title, area: t.area, project: t.project, day, est: t.est, priority: t.priority, energy: t.energy, notes: t.notes, link: t.link,
      origin: { kind: t.origin_kind, title: t.origin_title, url: t.origin_url }, at: t.at, repeat: t.repeat, repeat_from: t.repeat_from, series_id: series,
    });
    const ins = this.db.prepare('INSERT INTO steps (task_id, idx, text, done) VALUES (?, ?, ?, 0)');
    t.steps.forEach((s, i) => ins.run(nextId, i, s.text));
    return { id: nextId, day };
  }

  /** The task, plus `next` when completing it created the next instance of a recurring task. */
  updateTask(taskId: string, p: TaskPatch): Task & { next?: NextInstance } {
    const r = this.patchTask(this.getTask(taskId), p);
    if (r.changed) this.changed();
    return r.next ? { ...this.getTask(taskId), next: r.next } : this.getTask(taskId);
  }

  /** One change to many tasks, with the old values so Claude can put them back. */
  updateTasks(ids: string[], set: TaskPatch) {
    const keys = (Object.keys(set) as (keyof TaskPatch)[]).filter(k => set[k] !== undefined);
    let updated = 0;
    const next: NextInstance[] = [];
    const before = tx(this.db, () => [...new Set(ids)].map(taskId => {
      const cur = this.getTask(taskId);
      const old: Record<string, unknown> = { id: taskId };
      for (const k of keys) old[k] = k === 'origin' ? originOf(cur) ?? null : cur[k as keyof Task];
      const r = this.patchTask(cur, set);
      if (r.changed) updated++;
      if (r.next) next.push(r.next);
      return old;
    }));
    if (updated) this.changed();
    return { updated, before, ...(next.length ? { next } : {}) };
  }

  completeTask(taskId: string, done = true) { return this.updateTask(taskId, { done }); }

  /**
   * Capture from anywhere (an Apple Shortcut, Siri, the share sheet): one line of text becomes a
   * task with the quick-add grammar, or, after "ask Claude", a high-priority request. Nothing is
   * dropped: a link that can't be stored as one goes into the notes, and so does an over-long line.
   */
  quickAdd(q: { text: string; link?: string; source?: string }): { task: Task; message: string } | { request: PendingRequest; message: string } {
    // A leading "+" is the app's quick-add marker; typed into a Shortcut it means the same.
    const text = q.text.replace(/\s+/g, ' ').trim().replace(/^\+\s*/, '');
    const link = q.link?.trim() || undefined;
    const ask = askClaude(text);
    if (ask !== null) {
      if (!ask) throw new DocketError('Say what Claude should do after "ask Claude".');
      const prompt = (link ? `${ask}\n\nLink: ${link}` : ask).slice(0, CAPS.prompt);
      const r = this.queueRequest({ prompt, priority: 'high' });
      if (r.status !== 'pending') throw new DocketError('The request could not be queued.');
      return { request: r.request, message: `Queued for Claude: "${ask.slice(0, 40)}${ask.length > 40 ? '…' : ''}". Open Claude to run it.` };
    }
    const today = this.today(), p = parseQuickAdd(text, today, { now: this.now() });
    if (!p.title) throw new DocketError('Nothing to add: say what the task is, e.g. "Call Sam tomorrow 5pm".');
    const notes: string[] = [];
    let title = p.title;
    if (title.length > CAPS.title) { notes.push(text); title = title.slice(0, CAPS.title - 1).trimEnd() + '…'; }
    // A Claude chat or session link is where the task came from; any other web link is the task's link.
    let taskLink: string | undefined, origin: OriginIn | undefined;
    for (const u of new Set([p.link, link].filter((x): x is string => !!x))) {
      if (!origin && isClaudeLink(u) && isHttpsUrl(u)) origin = { url: u };
      else if (!taskLink && isSafeUrl(u) && u.length <= CAPS.link) taskLink = u;
      else notes.push('Link: ' + u);
    }
    const day = p.day ?? today;
    const task = this.addTask({
      title, area: p.area ?? 'Work', project: p.project, day, due: p.due, est: Math.min(24 * 60, Math.max(5, p.est ?? 30)),
      priority: p.priority ?? 'med', energy: p.energy ?? 'low', at: p.at, repeat: p.repeat, repeat_from: p.repeat_from,
      link: taskLink, origin, notes: notes.join('\n').slice(0, CAPS.notes) || undefined,
      source: /^(gmail|email|mail)$/i.test(q.source ?? '') ? 'gmail' : undefined,
    });
    const when = day === today ? 'today' : day === addDays(today, 1) ? 'tomorrow' : fmtDay(day);
    const rep = task.repeat ? '; ' + describeRepeat(task.repeat, task.repeat_from).replace(/^R/, 'r') : '';
    return { task, message: `Added "${task.title}" for ${when}${task.at ? ' at ' + task.at : ''}${rep}.` };
  }

  deleteTask(taskId: string) {
    const t = this.getTask(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    this.changed();
    return t;
  }

  private writeSteps(taskId: string, steps: Step[]) {
    if (steps.length > MAX_STEPS) throw new DocketError(`A task can have at most ${MAX_STEPS} steps.`);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM steps WHERE task_id = ?').run(taskId);
      const ins = this.db.prepare('INSERT INTO steps (task_id, idx, text, done) VALUES (?, ?, ?, ?)');
      steps.forEach((s, i) => ins.run(taskId, i, s.text, s.done ? 1 : 0));
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(this.stamp(), taskId);
    });
    this.changed();
    return this.getTask(taskId);
  }

  /** Replaces the checklist. A step whose text is unchanged keeps its done state. */
  setSteps(taskId: string, steps: StepIn[]) {
    const old = this.getTask(taskId).steps.map(s => ({ ...s, used: false }));
    const next = steps
      .map(s => (typeof s === 'string' ? { text: s.trim(), done: undefined } : { text: String(s.text ?? '').trim(), done: s.done }))
      .filter(s => s.text)
      .map(s => {
        const match = old.find(o => !o.used && o.text === s.text);
        if (match) match.used = true;
        return { text: s.text, done: s.done ?? match?.done ?? false };
      });
    return this.writeSteps(taskId, next);
  }

  addSteps(taskId: string, steps: string[], at?: number) {
    const cur = this.getTask(taskId).steps;
    const pos = at === undefined ? cur.length : clamp(Math.floor(at), 0, cur.length);
    const add = steps.map(s => String(s).trim()).filter(Boolean).map(text => ({ text, done: false }));
    return this.writeSteps(taskId, [...cur.slice(0, pos), ...add, ...cur.slice(pos)]);
  }

  private stepIndex(t: Task, index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= t.steps.length) {
      throw new DocketError(t.steps.length ? `Task has ${t.steps.length} steps; index must be 0 to ${t.steps.length - 1}.` : 'Task has no steps.');
    }
  }

  setStep(taskId: string, index: number, done: boolean) {
    this.stepIndex(this.getTask(taskId), index);
    this.db.prepare('UPDATE steps SET done = ? WHERE task_id = ? AND idx = ?').run(done ? 1 : 0, taskId, index);
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(this.stamp(), taskId);
    this.changed();
    return this.getTask(taskId);
  }

  toggleStep(taskId: string, index: number) {
    const t = this.getTask(taskId);
    this.stepIndex(t, index);
    return this.setStep(taskId, index, !t.steps[index].done);
  }

  attachDraft(taskId: string, text: string, gmailDraftId?: string | null) {
    const t = this.getTask(taskId);
    // Re-attaching the same text keeps the Gmail draft id it already had.
    this.db.prepare('UPDATE tasks SET draft = ?, gmail_draft_id = ?, updated_at = ? WHERE id = ?')
      .run(text, gmailDraftId ?? (text === t.draft ? t.gmail_draft_id : null), this.stamp(), taskId);
    this.changed();
    return this.getTask(taskId);
  }

  /** What Claude produced for a task the owner gave it; the owner reviews it. */
  attachResult(taskId: string, text: string, url?: string | null) {
    this.getTask(taskId);
    if (url && !isSafeUrl(url)) throw new DocketError('url must start with https://, http:// or mailto:');
    this.db.prepare('UPDATE tasks SET result = ?, result_url = ?, result_at = ?, updated_at = ? WHERE id = ?')
      .run(text.trim(), url?.trim() || null, this.stamp(), this.stamp(), taskId);
    this.changed();
    return this.getTask(taskId);
  }

  // ---------- moves ----------

  private moves(status = 'pending'): Move[] {
    return (this.db.prepare(`SELECT m.*, t.title, t.day AS from_day FROM moves m JOIN tasks t ON t.id = m.task_id WHERE m.status = ? ORDER BY m.created_at, m.rowid`).all(status) as Row[])
      .map(r => ({ id: r.id, task_id: r.task_id, title: r.title, from_day: r.from_day, to_day: r.to_day, reason: r.reason, status: r.status, created_at: r.created_at }));
  }

  pendingMoves() { return this.moves('pending'); }

  proposeMoves(moves: { id: string; to_day: string; reason?: string }[]) {
    const out: Move[] = [];
    tx(this.db, () => {
      for (const m of moves) {
        const t = this.getTask(m.id);
        if (!isIsoDay(m.to_day)) throw new DocketError(`to_day for ${m.id} must be YYYY-MM-DD`);
        if (t.done) throw new DocketError(`Task ${m.id} is already done`);
        // A newer proposal replaces an older one, including "stay where it is".
        this.db.prepare(`UPDATE moves SET status = 'skipped' WHERE task_id = ? AND status = 'pending'`).run(t.id);
        if (m.to_day === t.day) continue;
        const moveId = id('m');
        this.db.prepare('INSERT INTO moves (id, task_id, to_day, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(moveId, t.id, m.to_day, (m.reason || '').trim(), 'pending', this.stamp());
        out.push({ id: moveId, task_id: t.id, title: t.title, from_day: t.day, to_day: m.to_day, reason: (m.reason || '').trim(), status: 'pending', created_at: this.stamp() });
      }
    });
    this.changed();
    return out;
  }

  private applyMove(m: Row, approve: boolean) {
    if (m.status !== 'pending') throw new DocketError(`Move ${m.id} is already ${m.status}`);
    this.db.prepare('UPDATE moves SET status = ? WHERE id = ?').run(approve ? 'approved' : 'skipped', m.id);
    if (approve) this.db.prepare('UPDATE tasks SET day = ?, updated_at = ? WHERE id = ?').run(m.to_day, this.stamp(), m.task_id);
  }

  private moveRow(moveId: string) {
    const m = this.db.prepare('SELECT * FROM moves WHERE id = ?').get(moveId) as Row | undefined;
    if (!m) throw new DocketError(`No move with id "${moveId}"`);
    return m;
  }

  resolveMove(moveId: string, approve: boolean) {
    const m = this.moveRow(moveId);
    tx(this.db, () => this.applyMove(m, approve));
    this.changed();
    return { move_id: moveId, approved: approve, task: this.getTask(m.task_id) };
  }

  /** Several moves, or every pending one, in one transaction. */
  resolveMoves(sel: { move_ids?: string[]; all?: boolean }, approve: boolean) {
    if (!sel.all && !sel.move_ids?.length) throw new DocketError('Pass move_ids, or all: true for every pending move.');
    const resolved = tx(this.db, () => {
      const rows = sel.all
        ? this.db.prepare(`SELECT * FROM moves WHERE status = 'pending'`).all() as Row[]
        : [...new Set(sel.move_ids)].map(x => this.moveRow(x));
      for (const m of rows) this.applyMove(m, approve);
      return rows.length;
    });
    this.changed();
    return { resolved };
  }

  // ---------- held and pending requests ----------

  /** Parks a request for later. One per (task, label): asking twice updates it. */
  holdRequest(h: { label: string; prompt: string; task_id?: string | null; priority?: Priority }): HeldRequest {
    const task = h.task_id ? this.getTask(h.task_id) : null;
    const held = this.hold({ label: h.label.trim().slice(0, 120), prompt: h.prompt.trim(), task_id: task?.id ?? null, priority: h.priority ?? task?.priority ?? 'med' });
    this.changed();
    return held;
  }

  private hold(h: { label: string; prompt: string; task_id: string | null; priority: Priority }): HeldRequest {
    const existing = this.db.prepare(`SELECT id FROM held_requests WHERE status = 'held' AND label = ? AND task_id IS ?`).get(h.label, h.task_id) as Row | undefined;
    if (existing) {
      this.db.prepare('UPDATE held_requests SET prompt = ?, priority = ? WHERE id = ?').run(h.prompt, h.priority, existing.id);
      return this.held(existing.id)!;
    }
    const heldId = id('h');
    this.db.prepare('INSERT INTO held_requests (id, label, prompt, task_id, priority, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(heldId, h.label, h.prompt, h.task_id, h.priority, this.stamp(), 'held');
    return this.held(heldId)!;
  }

  private rowToHeld(r: Row): HeldRequest {
    return { id: r.id, label: r.label, prompt: r.prompt, task_id: r.task_id ?? null, priority: r.priority, created_at: r.created_at, ...(r.tool ? { tool: r.tool } : {}) };
  }

  private held(heldId: string): HeldRequest | undefined {
    const r = this.db.prepare(`SELECT * FROM held_requests WHERE id = ? AND status = 'held'`).get(heldId) as Row | undefined;
    return r && this.rowToHeld(r);
  }

  heldRequests(): HeldRequest[] {
    return (this.db.prepare(`SELECT * FROM held_requests WHERE status = 'held' ORDER BY created_at, rowid`).all() as Row[]).map(r => this.rowToHeld(r));
  }

  dropHeld(heldId: string) {
    const r = this.db.prepare(`UPDATE held_requests SET status = 'dropped' WHERE id = ? AND status = 'held'`).run(heldId);
    if (!r.changes) throw new DocketError(`No held request "${heldId}"`);
    this.changed();
  }

  /**
   * "Run anyway". Holds from before 0.3.0 may carry the content Claude already wrote:
   * apply it now (no second Claude call). Otherwise queue the request with a budget override.
   */
  runHeld(heldId: string): { applied: boolean; request?: PendingRequest } {
    const r = this.db.prepare(`SELECT * FROM held_requests WHERE id = ? AND status = 'held'`).get(heldId) as Row | undefined;
    if (!r) throw new DocketError(`No held request "${heldId}"`);
    if (r.tool && r.args) {
      // Apply in one transaction, so a failure leaves the hold (and the content) in place.
      const a = JSON.parse(r.args);
      try {
        tx(this.db, () => {
          this.db.prepare(`UPDATE held_requests SET status = 'released' WHERE id = ?`).run(heldId);
          if (r.tool === 'set_steps') this.setSteps(a.id, a.steps);
          else if (r.tool === 'attach_draft') this.attachDraft(a.id, a.text, a.gmail_draft_id);
          else if (r.tool === 'save_review') this.saveReview(a.week_start, a.text);
          else throw new DocketError(`Don't know how to apply a held "${r.tool}" request`);
          const reply = 'Done. Applied what Claude had already written.';
          this.db.prepare(`INSERT INTO pending_requests (id, label, prompt, task_id, priority, override, created_at, status, reply, outcome, seen, completed_at)
            VALUES (?, ?, ?, ?, ?, 1, ?, 'done', ?, 'done', 1, ?)`).run(id('r'), r.label, r.prompt, r.task_id, r.priority, this.stamp(), reply, this.stamp());
          this.setMeta({ last_cmd: r.label, last_reply: reply });
        });
      } catch (e) {
        if (e instanceof DocketError && /^No task/.test(e.message)) {
          this.db.prepare(`UPDATE held_requests SET status = 'dropped' WHERE id = ?`).run(heldId);
          this.changed();
          throw new DocketError('The task this request was for no longer exists, so the request was removed.');
        }
        throw e;
      }
      this.changed();
      return { applied: true };
    }
    const req = tx(this.db, () => {
      this.db.prepare(`UPDATE held_requests SET status = 'released' WHERE id = ?`).run(heldId);
      const q = this.enqueue({ label: r.label, prompt: r.prompt, task_id: r.task_id, priority: r.priority, override: true });
      this.setMeta({ last_cmd: r.label, last_reply: 'Released. Claude runs it next time you open the chat.' });
      return q;
    });
    this.changed();
    return { applied: false, request: req };
  }

  /** After a reset: every held request back into the queue, approved by the owner. */
  queueAllHeld() {
    const queued = tx(this.db, () => {
      let n = 0;
      for (const h of this.heldRequests()) {
        try { this.runHeld(h.id); n++; } catch (e) { if (!(e instanceof DocketError)) throw e; }
      }
      this.deleteMeta('reset_notice');
      if (n) this.setMeta({ last_cmd: 'Queue all', last_reply: `Queued ${n} request${n === 1 ? '' : 's'}. Open Claude to run them.` });
      return n;
    });
    this.changed();
    return { queued };
  }

  resetNotice(): { n: number; at: string } | null {
    this.period(); // the notice is written when a new week's period starts
    try { const v = JSON.parse(this.meta('reset_notice') ?? 'null'); return v && typeof v.n === 'number' ? v : null; } catch { return null; }
  }

  dismissResetNotice() {
    this.deleteMeta('reset_notice');
    this.changed();
  }

  private enqueue(q: { label: string; prompt: string; task_id: string | null; priority: Priority; override?: boolean }): PendingRequest {
    const reqId = id('r');
    this.db.prepare(`INSERT INTO pending_requests (id, label, prompt, task_id, priority, override, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(reqId, q.label, q.prompt, q.task_id, q.priority, q.override ? 1 : 0, this.stamp());
    return this.request(reqId)!;
  }

  private rowToRequest(r: Row): PendingRequest {
    return {
      id: r.id, label: r.label, prompt: r.prompt, task_id: r.task_id ?? null, priority: r.priority, override: !!r.override, created_at: r.created_at,
      status: r.status, reply: r.reply ?? null, outcome: r.outcome ?? null, detail: r.detail ?? null, seen: !!r.seen, completed_at: r.completed_at ?? null,
    };
  }

  request(reqId: string): PendingRequest | undefined {
    const r = this.db.prepare('SELECT * FROM pending_requests WHERE id = ?').get(reqId) as Row | undefined;
    return r && this.rowToRequest(r);
  }

  /**
   * A request from the app. The same (label, task) already waiting is returned (with the
   * newest wording) rather than queued twice; below-high work at the reserve is held instead.
   */
  queueRequest(q: { prompt: string; label?: string; priority?: Priority; task_id?: string | null }):
    { status: 'pending'; request: PendingRequest; existing?: true } | { status: 'held'; held: HeldRequest } {
    const prompt = q.prompt.trim();
    if (!prompt) throw new DocketError('prompt is empty');
    const label = (q.label?.trim() || prompt).slice(0, 120);
    const task = q.task_id ? this.getTask(q.task_id) : null;
    const priority = q.priority ?? task?.priority ?? 'high';
    const dup = this.db.prepare(`SELECT id FROM pending_requests WHERE status = 'pending' AND label = ? AND task_id IS ?`).get(label, task?.id ?? null) as Row | undefined;
    if (dup) {
      this.db.prepare('UPDATE pending_requests SET prompt = ? WHERE id = ?').run(prompt, dup.id);
      this.changed();
      return { status: 'pending', request: this.request(dup.id)!, existing: true };
    }
    if (priority !== 'high' && this.usage().at_reserve) {
      const held = this.hold({ label, prompt, task_id: task?.id ?? null, priority });
      this.setMeta({ last_cmd: label, last_reply: 'Held: below high priority and your budget is at the reserve. Run it from Usage when you want.' });
      this.changed();
      return { status: 'held', held };
    }
    const request = this.enqueue({ label, prompt, task_id: task?.id ?? null, priority });
    this.setMeta({ last_cmd: label, last_reply: 'Ready for Claude. Open Claude to run it.' });
    this.changed();
    return { status: 'pending', request };
  }

  pendingRequests(): PendingRequest[] {
    return (this.db.prepare(`SELECT p.*, t.origin_kind AS t_kind, t.origin_title AS t_title, t.origin_url AS t_url
      FROM pending_requests p LEFT JOIN tasks t ON t.id = p.task_id WHERE p.status = 'pending' ORDER BY p.created_at, p.rowid`).all() as Row[])
      .map(r => {
        const origin = pick(r.t_kind, r.t_title, r.t_url);
        return origin ? { ...this.rowToRequest(r), origin } : this.rowToRequest(r);
      });
  }

  /**
   * The guard at pickup: a below-high request queued before the budget hit the reserve
   * leaves the queue for Usage › Waiting for budget, unless the owner approved it.
   * Returns how many were moved.
   */
  holdAtPickup(): number {
    if (!this.usage().at_reserve) return 0;
    const moved = tx(this.db, () => {
      let n = 0;
      for (const r of this.pendingRequests()) {
        if (r.priority === 'high' || r.override) continue;
        this.db.prepare(`UPDATE pending_requests SET status = 'cancelled', outcome = 'held', seen = 1, completed_at = ? WHERE id = ?`).run(this.stamp(), r.id);
        this.hold({ label: r.label, prompt: r.prompt, task_id: r.task_id, priority: r.priority });
        n++;
      }
      return n;
    });
    if (moved) this.changed();
    return moved;
  }

  completeRequest(reqId: string, o: { reply?: string; outcome?: 'done' | 'needs_owner' | 'failed'; detail?: string } = {}) {
    const r = this.request(reqId);
    if (!r) throw new DocketError(`No request "${reqId}"`);
    if (r.status !== 'pending') {
      const why = r.outcome === 'held' ? 'it is waiting for budget' : r.status === 'cancelled' ? 'the owner removed it' : 'it is already complete';
      throw new DocketError(`Request ${reqId} is not pending (${why}); nothing to complete.`);
    }
    const outcome = o.outcome ?? 'done';
    const reply = o.reply?.trim() || (outcome === 'done' ? 'Done.' : outcome === 'needs_owner' ? 'Claude needs something from you.' : "Claude couldn't finish this.");
    tx(this.db, () => {
      this.db.prepare(`UPDATE pending_requests SET status = 'done', reply = ?, outcome = ?, detail = ?, seen = 0, completed_at = ? WHERE id = ?`)
        .run(reply, outcome, o.detail?.trim() || null, this.stamp(), reqId);
      this.setMeta({ last_cmd: r.label, last_reply: reply, reply_at: this.stamp() });
    });
    this.changed();
    return this.request(reqId)!;
  }

  cancelRequest(reqId: string) {
    const r = this.db.prepare(`UPDATE pending_requests SET status = 'cancelled', outcome = 'cancelled', seen = 1, completed_at = ? WHERE id = ? AND status = 'pending'`).run(this.stamp(), reqId);
    if (!r.changes) throw new DocketError(`No pending request "${reqId}"`);
    this.changed();
  }

  /** The last finished requests, newest first: what Claude did (or why not). */
  recentRequests(limit = 10): PendingRequest[] {
    return (this.db.prepare(`SELECT * FROM pending_requests WHERE status != 'pending' ORDER BY COALESCE(completed_at, created_at) DESC, rowid DESC LIMIT ?`).all(limit) as Row[])
      .map(r => this.rowToRequest(r));
  }

  markSeen(ids?: string[]) {
    const list = ids?.length ? ` AND id IN (${ids.map(() => '?').join(', ')})` : '';
    const r = this.db.prepare(`UPDATE pending_requests SET seen = 1 WHERE status != 'pending' AND seen = 0${list}`).run(...(ids ?? []));
    if (r.changes) this.changed();
    return { seen: Number(r.changes) };
  }

  // ---------- reviews and week plans ----------

  saveReview(weekStartDay: string, text: string) {
    if (!isIsoDay(weekStartDay)) throw new DocketError('week_start must be YYYY-MM-DD');
    const ws = weekStart(weekStartDay);
    this.db.prepare('INSERT INTO reviews (week_start, text, created_at, dismissed) VALUES (?, ?, ?, 0) ON CONFLICT(week_start) DO UPDATE SET text = excluded.text, created_at = excluded.created_at, dismissed = 0')
      .run(ws, text.trim(), this.stamp());
    this.changed();
    return { week_start: ws, text: text.trim() };
  }

  private review(ws: string): string | null {
    return ((this.db.prepare('SELECT text FROM reviews WHERE week_start = ?').get(ws) as Row | undefined)?.text as string | undefined) ?? null;
  }

  latestReview() {
    const r = this.db.prepare('SELECT * FROM reviews WHERE dismissed = 0 AND week_start >= ? ORDER BY week_start DESC LIMIT 1').get(addDays(weekStart(this.today()), -7)) as Row | undefined;
    return r ? { week_start: r.week_start as string, text: r.text as string, created_at: r.created_at as string } : null;
  }

  dismissReview(weekStartDay: string) {
    this.db.prepare('UPDATE reviews SET dismissed = 1 WHERE week_start = ?').run(weekStartDay);
    this.changed();
  }

  private weekOf(day?: string) {
    if (day !== undefined && !isIsoDay(day)) throw new DocketError('week_start must be YYYY-MM-DD');
    return weekStart(day ?? this.today());
  }

  /** What the owner wants from a week, in their words. */
  weekPlan(day?: string): WeekPlan | null {
    const r = this.db.prepare('SELECT * FROM week_plans WHERE week_start = ?').get(this.weekOf(day)) as Row | undefined;
    return r ? { week_start: r.week_start, text: r.text, updated_at: r.updated_at } : null;
  }

  setWeekPlan(day: string | undefined, text: string): WeekPlan {
    const ws = this.weekOf(day);
    if (!text.trim()) throw new DocketError('text is empty');
    this.db.prepare('INSERT INTO week_plans (week_start, text, updated_at) VALUES (?, ?, ?) ON CONFLICT(week_start) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at')
      .run(ws, text.trim(), this.stamp());
    this.changed();
    return this.weekPlan(ws)!;
  }

  deleteWeekPlan(day: string) {
    this.db.prepare('DELETE FROM week_plans WHERE week_start = ?').run(this.weekOf(day));
    this.changed();
  }

  // ---------- inbox (emails Claude read with its Gmail connector) ----------

  recordEmails(emails: { from: string; subject: string; snippet?: string; when?: string; thread_id?: string | null }[], replace = true) {
    tx(this.db, () => {
      if (replace) this.db.prepare('DELETE FROM emails').run();
      const ins = this.db.prepare('INSERT INTO emails (id, sender, subject, snippet, received, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const e of emails) ins.run(id('e'), e.from, e.subject, e.snippet ?? '', e.when ?? '', e.thread_id ?? null, this.stamp());
      this.setMeta({ inbox_checked_at: this.stamp() });
    });
    this.changed();
    return this.emails();
  }

  emails(): Email[] {
    return (this.db.prepare('SELECT * FROM emails ORDER BY rowid').all() as Row[])
      .map(r => ({ id: r.id, from: r.sender, subject: r.subject, snippet: r.snippet, when: r.received, thread_id: r.thread_id }));
  }

  suggestTasks(finds: { title: string; area?: Area; project?: string | null; due?: string | null; est?: number; priority?: Priority; energy?: Energy; email_id?: string | null }[]) {
    tx(this.db, () => {
      const ins = this.db.prepare('INSERT INTO finds (id, email_id, title, area, project, due, est_min, priority, energy, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const f of finds) {
        this.checkFields({ title: f.title, area: f.area, due: f.due ?? undefined, priority: f.priority, energy: f.energy });
        ins.run(id('f'), f.email_id ?? null, f.title.trim(), f.area ?? 'Work', f.project ?? null, f.due ?? null, Math.max(5, Math.round(f.est ?? 30)), f.priority ?? 'med', f.energy ?? 'low', 'open', this.stamp());
      }
    });
    this.changed();
    return this.finds();
  }

  finds(): Find[] {
    return (this.db.prepare(`SELECT * FROM finds WHERE status = 'open' ORDER BY created_at`).all() as Row[])
      .map(r => ({ id: r.id, email_id: r.email_id, title: r.title, area: r.area, project: r.project, due: r.due, est: r.est_min, priority: r.priority, energy: r.energy }));
  }

  resolveFind(findId: string, add: boolean) {
    const f = this.finds().find(x => x.id === findId);
    if (!f) throw new DocketError(`No suggestion "${findId}"`);
    const task = tx(this.db, () => {
      this.db.prepare('UPDATE finds SET status = ? WHERE id = ?').run(add ? 'added' : 'skipped', findId);
      return add ? this.addTask({ title: f.title, area: f.area, project: f.project, est: f.est, priority: f.priority, energy: f.energy, due: f.due, source: 'gmail', day: this.today() }) : null;
    });
    this.changed();
    return task;
  }

  // ---------- meta ----------

  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? r.value : null;
  }

  setMeta(kv: Record<string, string>) {
    const st = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(kv)) st.run(k, v);
  }

  private deleteMeta(key: string) { this.db.prepare('DELETE FROM meta WHERE key = ?').run(key); }

  // ---------- overview ----------

  /** What Claude reads at the start of a Docket conversation: small on purpose, it is paid for every time. */
  overview(day?: string) {
    const now = this.now();
    const today = this.today();
    const d = day && isIsoDay(day) ? day : today;
    const s = this.settings();
    const capMin = Math.round(s.capacity_hours * 60);
    const days = weekDays(d);
    const all = this.listTasks({ from: days[0], to: days[6], include_done: true });
    // Capacity is about work still to do: today and future days count open minutes;
    // past days are history (no task list, never "over").
    const week = days.map(x => {
      const items = all.filter(t => t.day === x);
      const past = x < today;
      const doneMin = items.filter(t => t.done).reduce((a, t) => a + t.est, 0);
      const openMin = items.filter(t => !t.done).reduce((a, t) => a + t.est, 0);
      return {
        date: x, label: fmtDay(x), ...(x === today ? { today: true as const } : {}), ...(past ? { past: true as const } : {}),
        open_min: openMin, done_min: doneMin,
        over_min: past ? 0 : Math.max(0, openMin - capMin), free_min: past ? 0 : Math.max(0, capMin - openMin),
        ...(past ? {} : { tasks: items.filter(t => !t.done).map(t => compactTask(t)) }),
      };
    });
    const focus = week.find(x => x.date === d)!;
    const plan = this.weekPlan(days[0]);
    // The week to review on Sunday is this one; Monday to Saturday, the one before.
    const lastReview = this.review(weekStart(addDays(today, -6)));
    const u = this.usage();
    const pending = this.pendingRequests();
    const inbox = this.finds().length;
    return {
      now: localIso(now), tz: tzName(), today, weekday: DOWL[dt(today).getDay()], capacity_hours: s.capacity_hours,
      day: { date: d, open_min: focus.open_min, over_min: focus.over_min, free_min: focus.free_min },
      week: {
        number: isoWeek(d), start: days[0], end: days[6], ...(plan ? { plan: plan.text } : {}), ...(lastReview ? { last_review: lastReview } : {}),
        planned_min: week.reduce((a, x) => a + x.open_min + x.done_min, 0), days_over: week.filter(x => !x.past && x.over_min > 0).length, days: week,
      },
      overdue: this.listTasks({ to: addDays(today, -1) }).map(t => compactTask(t, { day: true })),
      usage: { used_pct: u.used_pct, est_pct: u.est_pct, left_pct: u.left_pct, at_reserve: u.at_reserve, near_reserve: u.near_reserve, resets: u.resets_label, updated: ago(u.updated_at, now) },
      pending_moves: this.pendingMoves().map(m => ({ id: m.id, task_id: m.task_id, title: m.title, from_day: m.from_day, to_day: m.to_day, reason: m.reason })),
      held_requests: this.heldRequests().map(h => ({ id: h.id, label: h.label })),
      pending_requests: pending.slice(0, 5).map(r => ({
        id: r.id, prompt: r.prompt, ...(r.task_id ? { task_id: r.task_id } : {}), priority: r.priority, ...(r.override ? { budget_override: true } : {}),
        ...(r.origin ? { origin: r.origin } : {}),
      })),
      ...(pending.length > 5 ? { more_requests: pending.length - 5 } : {}),
      ...(inbox ? { inbox_suggestions: inbox } : {}),
    };
  }

  /** Everything the web app renders. */
  state() {
    const today = this.today();
    const since = addDays(today, -60);
    const tasks = (this.db.prepare('SELECT * FROM tasks WHERE done = 0 OR day >= ? OR completed_at >= ? ORDER BY day, created_at').all(since, since) as Row[]).map(r => this.rowToTask(r));
    return {
      today,
      now: localIso(this.now()),
      tz: tzName(),
      tasks,
      moves: this.pendingMoves(),
      held: this.heldRequests(),
      requests: this.pendingRequests(),
      recent: this.recentRequests(),
      usage: this.usage(),
      settings: this.settings(),
      emails: this.emails(),
      finds: this.finds(),
      review: this.latestReview(),
      week_plan: this.weekPlan(),
      reset_notice: this.resetNotice(),
      last_cmd: this.meta('last_cmd') ?? '',
      reply: this.meta('last_reply') ?? 'Tell me what to add, move or plan. Tap the mic or type.',
      reply_at: this.meta('reply_at'),
      inbox_checked_at: this.meta('inbox_checked_at'),
      flags: this.flags,
      version,
    };
  }

  // ---------- sample data ----------

  loadSample() {
    tx(this.db, () => {
      for (const t of ['steps', 'moves', 'tasks', 'held_requests', 'pending_requests', 'emails', 'finds', 'reviews', 'week_plans', 'meta']) this.db.prepare(`DELETE FROM ${t}`).run();
      this.loadSampleRows();
    });
    this.changed();
  }

  private loadSampleRows() {
    const t = this.today(), n = (k: number) => addDays(t, k);
    const add = (o: Partial<TaskInput> & { title: string; steps?: [string, boolean][]; done?: boolean }) => {
      const taskId = this.insertTask({ area: 'Work', est: 30, priority: 'med', energy: 'low', day: t, ...o });
      if (o.steps) {
        const ins = this.db.prepare('INSERT INTO steps (task_id, idx, text, done) VALUES (?, ?, ?, ?)');
        o.steps.forEach(([s, done], i) => ins.run(taskId, i, s, done ? 1 : 0));
      }
      if (o.done) this.db.prepare('UPDATE tasks SET done = 1, completed_at = ? WHERE id = ?').run(this.stamp(), taskId);
    };
    add({ title: 'Finish Q4 budget deck', project: 'Q4 planning', est: 150, priority: 'high', energy: 'high', steps: [['Gather numbers', true], ['Outline', true], ['Revenue slides', false], ['Send to Priya', false]] });
    add({ title: 'Team sync', est: 60, at: '11:00', repeat: 'weekdays' });
    add({ title: "Review Sam's contract", est: 55, priority: 'high', source: 'gmail' });
    add({ title: 'Reply to Sam about contract renewal', est: 15, priority: 'high', source: 'gmail' });
    add({ title: 'Pay Acme invoice', est: 10, priority: 'high', due: n(1), source: 'gmail' });
    add({ title: 'Call mum', area: 'Personal', est: 20, at: '18:30' });
    add({ title: 'Book dentist', area: 'Health', est: 5, priority: 'low' });
    add({ title: 'Groceries', area: 'Personal', est: 45 });
    add({ title: 'Plan Lisbon trip', area: 'Personal', project: 'Lisbon trip', est: 60, priority: 'low', origin: { kind: 'chat', title: 'Lisbon ideas' } });
    add({ title: 'Gym', area: 'Health', est: 40, energy: 'high' });
    add({ title: 'Laundry', area: 'Personal', est: 30, day: n(1), priority: 'low' });
    add({ title: 'Book Lisbon flights', area: 'Personal', project: 'Lisbon trip', est: 30, day: n(2) });
    add({ title: 'Run', area: 'Health', est: 45, day: n(2), energy: 'high', repeat: 'every:2:days' });
    add({ title: 'Prep Monday planning', est: 45, day: n(4) });
    add({ title: 'Send weekly update', est: 30, day: n(-1), done: true });
    add({ title: 'Pharmacy', area: 'Health', est: 20, day: n(-1), done: true });
    this.recordEmails([
      { from: 'Priya Shah', subject: 'Q4 deck: feedback by Monday?', snippet: 'Could you send the deck over by Monday so I can review it before the board pre-read?', when: '09:12' },
      { from: 'Acme Billing', subject: 'Invoice #2291 due Friday', snippet: 'A reminder that invoice #2291 is due this Friday. You can pay online or by bank transfer.', when: '08:40' },
      { from: 'Sam Okafor', subject: 'Contract renewal', snippet: 'Attached is the renewal. Let me know if clause 4 works for you. Keen to sign this week.', when: 'Yesterday' },
      { from: 'Bright Dental', subject: 'Your check-up is overdue', snippet: 'It has been 14 months since your last visit. Book online any time.', when: 'Mon' },
      { from: 'The Weekly Brief', subject: '10 links worth your time', snippet: 'This week: product strategy, a better standup, and more.', when: 'Mon' },
    ]);
  }
}
