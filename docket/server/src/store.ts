import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { type DB, tx } from './db.js';
import { DOWL, addDays, dt, fmtDay, iso, isIsoDay, isoWeek, periodStart, weekDays, weekStart } from './dates.js';

export const AREAS = ['Work', 'Personal', 'Health'] as const;
export const PRIORITIES = ['high', 'med', 'low'] as const;
export const ENERGIES = ['high', 'low'] as const;
export type Area = (typeof AREAS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Energy = (typeof ENERGIES)[number];
const RANK: Record<Priority, number> = { high: 0, med: 1, low: 2 };

export interface Step { text: string; done: boolean }
export interface Task {
  id: string; title: string; area: Area; project: string | null; day: string; due: string | null;
  est: number; priority: Priority; energy: Energy; done: boolean; source: 'gmail' | null;
  draft: string | null; gmail_draft_id: string | null; steps: Step[]; created_at: string; updated_at: string;
}
export interface TaskInput {
  title: string; area: Area; project?: string | null; day?: string; due?: string | null;
  est: number; priority: Priority; energy: Energy; source?: 'gmail' | null;
}
export type TaskPatch = Partial<Omit<TaskInput, 'title' | 'area' | 'est' | 'priority' | 'energy'>> &
  Partial<Pick<TaskInput, 'title' | 'area' | 'est' | 'priority' | 'energy'>> & { done?: boolean };

export interface Settings {
  capacity_hours: number; reserve_pct: number; high_only: boolean; week_start: string; reset: string;
  pct_per_call: number; claude_url: string;
}
export interface Move { id: string; task_id: string; title: string; from_day: string; to_day: string; reason: string; status: string; created_at: string }
export interface HeldRequest { id: string; label: string; prompt: string; task_id: string | null; priority: Priority; tool: string | null; created_at: string; status: string }
export interface PendingRequest { id: string; label: string; prompt: string; task_id: string | null; priority: Priority; override: boolean; created_at: string; status: string; reply: string | null }
export interface Email { id: string; from: string; subject: string; snippet: string; when: string; thread_id: string | null }
export interface Find { id: string; email_id: string | null; title: string; area: Area; project: string | null; due: string | null; est: number; priority: Priority; energy: Energy }

/** A user-facing error: the message is safe to show to Claude and the owner. */
export class DocketError extends Error {}
/** Thrown by the budget guard after it saves the request to held_requests. */
export class HeldError extends DocketError {
  constructor(public held: HeldRequest) {
    super(`Budget at reserve: request held ("${held.label}", id ${held.id}). Tell the owner it is waiting in Docket under Usage › Waiting for budget, where they can tap Run anyway.`);
  }
}

/** Rough relative cost of each tool call, used to estimate usage between self-reports. */
export const CALL_WEIGHTS: Record<string, number> = {
  get_overview: 1, list_tasks: 1, add_task: 1, update_task: 0.5, complete_task: 0.5, delete_task: 0.5,
  set_steps: 2, toggle_step: 0.25, propose_moves: 2, resolve_move: 0.25, attach_draft: 3,
  get_usage: 0.25, set_usage: 0.25, set_settings: 0.25, get_pending_requests: 0.5, complete_request: 0.5,
  save_review: 2, record_emails: 2, suggest_tasks: 1,
};

const id = (prefix = '') => prefix + randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 6).toLowerCase().padEnd(6, '0');
const nowIso = (d: Date) => d.toISOString();
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

type Row = Record<string, any>;

export class Store {
  readonly events = new EventEmitter();
  private readonly now: () => Date;

  constructor(readonly db: DB, opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
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
    if (!/^https:\/\//.test(next.claude_url)) throw new DocketError('claude_url must start with https://');
    this.db.prepare('UPDATE settings SET capacity_hours = ?, reserve_pct = ?, high_only = ?, claude_url = ?, reset = ? WHERE id = 1')
      .run(next.capacity_hours, next.reserve_pct, next.high_only ? 1 : 0, next.claude_url, next.reset);
    this.changed();
    return this.settings();
  }

  // ---------- usage ----------

  private period() {
    const ps = periodStart(this.now(), this.settings().reset);
    const key = nowIso(ps);
    this.db.prepare('INSERT OR IGNORE INTO usage (period_start, used_pct, updated_at, est_calls) VALUES (?, 0, NULL, 0)').run(key);
    const row = this.db.prepare('SELECT * FROM usage WHERE period_start = ?').get(key) as Row;
    return { start: ps, key, row };
  }

  usage() {
    const s = this.settings();
    const { start, row } = this.period();
    const used = row.used_pct as number;
    const estCalls = row.est_calls as number;
    const estimated = Math.min(100, Math.round(used + estCalls * s.pct_per_call));
    const calls = (this.db.prepare('SELECT COUNT(*) n FROM call_log WHERE at >= ?').get(nowIso(start)) as Row).n as number;
    const resets = new Date(start); resets.setDate(resets.getDate() + 7);
    return {
      period_start: nowIso(start),
      resets_at: nowIso(resets),
      used_pct: used,
      left_pct: 100 - used,
      updated_at: (row.updated_at as string | null) ?? null,
      estimated_used_pct: estimated,
      estimated: estimated !== used,
      calls_since_reset: calls,
      reserve_pct: s.reserve_pct,
      high_only: s.high_only,
      at_reserve: this.atReserve(used, s),
    };
  }

  private atReserve(used: number, s: Settings) { return s.high_only && 100 - used <= s.reserve_pct; }

  /** Self-reported weekly usage. Also calibrates the per-call estimate from the change since the last report. */
  setUsage(usedPct: number) {
    const pct = clamp(Math.round(usedPct), 0, 100);
    const { key, row } = this.period();
    const s = this.settings();
    if (row.updated_at && row.est_calls >= 4 && pct > row.used_pct) {
      const observed = (pct - row.used_pct) / row.est_calls;
      const calibrated = clamp(0.7 * s.pct_per_call + 0.3 * observed, 0.05, 5);
      this.db.prepare('UPDATE settings SET pct_per_call = ? WHERE id = 1').run(Math.round(calibrated * 1000) / 1000);
    }
    this.db.prepare('UPDATE usage SET used_pct = ?, updated_at = ?, est_calls = 0 WHERE period_start = ?').run(pct, this.stamp(), key);
    this.changed();
    return this.usage();
  }

  logCall(tool: string) {
    const w = CALL_WEIGHTS[tool] ?? 0.5;
    const { key } = this.period();
    this.db.prepare('INSERT INTO call_log (at, tool, weight) VALUES (?, ?, ?)').run(this.stamp(), tool, w);
    this.db.prepare('UPDATE usage SET est_calls = est_calls + ? WHERE period_start = ?').run(w, key);
  }

  // ---------- tasks ----------

  private rowToTask(r: Row): Task {
    const steps = (this.db.prepare('SELECT text, done FROM steps WHERE task_id = ? ORDER BY idx').all(r.id) as Row[])
      .map(s => ({ text: s.text as string, done: !!s.done }));
    return {
      id: r.id, title: r.title, area: r.area, project: r.project || null, day: r.day, due: r.due || null, est: r.est_min,
      priority: r.priority, energy: r.energy, done: !!r.done, source: r.source || null, draft: r.draft || null,
      gmail_draft_id: r.gmail_draft_id || null, steps, created_at: r.created_at, updated_at: r.updated_at,
    };
  }

  getTask(taskId: string): Task {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Row | undefined;
    if (!r) throw new DocketError(`No task with id "${taskId}". Call list_tasks or get_overview for current ids.`);
    return this.rowToTask(r);
  }

  listTasks(f: { from?: string; to?: string; area?: Area; project?: string; include_done?: boolean } = {}): Task[] {
    const where: string[] = [], args: (string | number)[] = [];
    if (f.from) { where.push('day >= ?'); args.push(f.from); }
    if (f.to) { where.push('day <= ?'); args.push(f.to); }
    if (f.area) { where.push('area = ?'); args.push(f.area); }
    if (f.project) { where.push('project = ?'); args.push(f.project); }
    if (!f.include_done) where.push('done = 0');
    const sql = 'SELECT * FROM tasks' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY day, created_at';
    return (this.db.prepare(sql).all(...args) as Row[]).map(r => this.rowToTask(r)).sort((a, b) => a.day.localeCompare(b.day) || RANK[a.priority] - RANK[b.priority]);
  }

  private checkFields(p: Partial<TaskInput>) {
    if (p.title !== undefined && !p.title.trim()) throw new DocketError('title is empty');
    if (p.area !== undefined && !AREAS.includes(p.area)) throw new DocketError(`area must be one of ${AREAS.join(', ')}`);
    if (p.priority !== undefined && !PRIORITIES.includes(p.priority)) throw new DocketError('priority must be high, med or low');
    if (p.energy !== undefined && !ENERGIES.includes(p.energy)) throw new DocketError('energy must be high or low');
    if (p.day !== undefined && !isIsoDay(p.day)) throw new DocketError('day must be YYYY-MM-DD');
    if (p.due && !isIsoDay(p.due)) throw new DocketError('due must be YYYY-MM-DD');
    if (p.est !== undefined && !(p.est > 0)) throw new DocketError('est must be a positive number of minutes');
  }

  addTask(t: TaskInput): Task {
    this.checkFields(t);
    const taskId = id(), at = this.stamp();
    this.db.prepare(`INSERT INTO tasks (id, title, area, project, day, due, est_min, priority, energy, done, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
      taskId, t.title.trim(), t.area, t.project?.trim() || null, t.day || this.today(), t.due || null,
      Math.max(5, Math.round(t.est)), t.priority, t.energy, t.source || null, at, at);
    this.changed();
    return this.getTask(taskId);
  }

  updateTask(taskId: string, p: TaskPatch): Task {
    this.getTask(taskId);
    this.checkFields(p);
    const cols: Record<string, unknown> = {};
    if (p.title !== undefined) cols.title = p.title.trim();
    if (p.area !== undefined) cols.area = p.area;
    if (p.project !== undefined) cols.project = p.project?.trim() || null;
    if (p.day !== undefined) cols.day = p.day;
    if (p.due !== undefined) cols.due = p.due || null;
    if (p.est !== undefined) cols.est_min = Math.max(5, Math.round(p.est));
    if (p.priority !== undefined) cols.priority = p.priority;
    if (p.energy !== undefined) cols.energy = p.energy;
    if (p.source !== undefined) cols.source = p.source || null;
    if (p.done !== undefined) cols.done = p.done ? 1 : 0;
    const keys = Object.keys(cols);
    if (keys.length) {
      tx(this.db, () => {
        this.db.prepare(`UPDATE tasks SET ${keys.map(k => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`)
          .run(...(Object.values(cols) as (string | number | null)[]), this.stamp(), taskId);
        // A manual move or completion makes pending suggestions for the task stale.
        if (p.day !== undefined || p.done) this.db.prepare(`UPDATE moves SET status = 'skipped' WHERE task_id = ? AND status = 'pending'`).run(taskId);
      });
      this.changed();
    }
    return this.getTask(taskId);
  }

  completeTask(taskId: string, done = true) { return this.updateTask(taskId, { done }); }

  deleteTask(taskId: string) {
    const t = this.getTask(taskId);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    this.changed();
    return t;
  }

  setSteps(taskId: string, steps: string[], opts: { request_id?: string } = {}) {
    const t = this.getTask(taskId);
    this.guard('set_steps', { id: taskId, steps }, { task: t, label: 'Break down: ' + t.title, prompt: `Break down task ${t.id} "${t.title}" into 3-6 concrete steps.`, requestId: opts.request_id });
    tx(this.db, () => {
      this.db.prepare('DELETE FROM steps WHERE task_id = ?').run(taskId);
      const ins = this.db.prepare('INSERT INTO steps (task_id, idx, text, done) VALUES (?, ?, ?, 0)');
      steps.map(s => String(s).trim()).filter(Boolean).forEach((s, i) => ins.run(taskId, i, s));
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(this.stamp(), taskId);
    });
    this.changed();
    return this.getTask(taskId);
  }

  toggleStep(taskId: string, index: number) {
    const t = this.getTask(taskId);
    if (!Number.isInteger(index) || index < 0 || index >= t.steps.length) throw new DocketError(`Task has ${t.steps.length} steps; index must be 0 to ${t.steps.length - 1}.`);
    this.db.prepare('UPDATE steps SET done = 1 - done WHERE task_id = ? AND idx = ?').run(taskId, index);
    this.changed();
    return this.getTask(taskId);
  }

  attachDraft(taskId: string, text: string, gmailDraftId?: string | null, opts: { request_id?: string } = {}) {
    const t = this.getTask(taskId);
    // Recording a Gmail draft id for the draft already stored is free; new draft text is guarded.
    if (text !== t.draft) {
      this.guard('attach_draft', { id: taskId, text, gmail_draft_id: gmailDraftId ?? null }, { task: t, label: 'Draft: ' + t.title, prompt: `Write the draft for task ${t.id} "${t.title}".`, requestId: opts.request_id });
    }
    this.db.prepare('UPDATE tasks SET draft = ?, gmail_draft_id = ?, updated_at = ? WHERE id = ?')
      .run(text, gmailDraftId ?? (text === t.draft ? t.gmail_draft_id : null), this.stamp(), taskId);
    this.changed();
    return this.getTask(taskId);
  }

  // ---------- moves ----------

  private moves(status = 'pending'): Move[] {
    return (this.db.prepare(`SELECT m.*, t.title, t.day AS from_day FROM moves m JOIN tasks t ON t.id = m.task_id WHERE m.status = ? ORDER BY m.created_at`).all(status) as Row[])
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
        if (m.to_day === t.day) continue;
        this.db.prepare(`UPDATE moves SET status = 'skipped' WHERE task_id = ? AND status = 'pending'`).run(t.id);
        const moveId = id('m');
        this.db.prepare('INSERT INTO moves (id, task_id, to_day, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(moveId, t.id, m.to_day, (m.reason || '').trim(), 'pending', this.stamp());
        out.push({ id: moveId, task_id: t.id, title: t.title, from_day: t.day, to_day: m.to_day, reason: m.reason || '', status: 'pending', created_at: this.stamp() });
      }
    });
    this.changed();
    return out;
  }

  resolveMove(moveId: string, approve: boolean) {
    const m = this.db.prepare('SELECT * FROM moves WHERE id = ?').get(moveId) as Row | undefined;
    if (!m) throw new DocketError(`No move with id "${moveId}"`);
    if (m.status !== 'pending') throw new DocketError(`Move ${moveId} is already ${m.status}`);
    tx(this.db, () => {
      this.db.prepare('UPDATE moves SET status = ? WHERE id = ?').run(approve ? 'approved' : 'skipped', moveId);
      if (approve) this.db.prepare('UPDATE tasks SET day = ?, updated_at = ? WHERE id = ?').run(m.to_day, this.stamp(), m.task_id);
    });
    this.changed();
    return { move_id: moveId, approved: approve, task: this.getTask(m.task_id) };
  }

  // ---------- budget guard, held and pending requests ----------

  private guard(tool: string, args: unknown, o: { task?: Task; label: string; prompt: string; requestId?: string }) {
    const s = this.settings();
    if (!this.atReserve(this.usage().used_pct, s)) return;
    if (o.task?.priority === 'high') return;
    if (o.requestId) {
      const r = this.db.prepare(`SELECT override FROM pending_requests WHERE id = ? AND status = 'pending'`).get(o.requestId) as Row | undefined;
      if (r?.override) return;
    }
    const held = this.hold({ label: o.label, prompt: o.prompt, task_id: o.task?.id ?? null, priority: o.task?.priority ?? 'low', tool, args });
    throw new HeldError(held);
  }

  private hold(h: { label: string; prompt: string; task_id: string | null; priority: Priority; tool?: string; args?: unknown }): HeldRequest {
    const heldId = id('h');
    this.db.prepare('INSERT INTO held_requests (id, label, prompt, task_id, priority, tool, args, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(heldId, h.label, h.prompt, h.task_id, h.priority, h.tool ?? null, h.args === undefined ? null : JSON.stringify(h.args), this.stamp(), 'held');
    this.changed();
    return this.heldRequests().find(x => x.id === heldId)!;
  }

  heldRequests(): HeldRequest[] {
    return (this.db.prepare(`SELECT * FROM held_requests WHERE status = 'held' ORDER BY created_at`).all() as Row[])
      .map(r => ({ id: r.id, label: r.label, prompt: r.prompt, task_id: r.task_id, priority: r.priority, tool: r.tool, created_at: r.created_at, status: r.status }));
  }

  dropHeld(heldId: string) {
    const r = this.db.prepare(`UPDATE held_requests SET status = 'dropped' WHERE id = ? AND status = 'held'`).run(heldId);
    if (!r.changes) throw new DocketError(`No held request "${heldId}"`);
    this.changed();
  }

  /**
   * "Run anyway". If Claude's output is already stored with the hold, apply it now
   * (no second Claude call). Otherwise queue the request with a budget override.
   */
  runHeld(heldId: string): { applied: boolean; request?: PendingRequest } {
    const r = this.db.prepare(`SELECT * FROM held_requests WHERE id = ? AND status = 'held'`).get(heldId) as Row | undefined;
    if (!r) throw new DocketError(`No held request "${heldId}"`);
    this.db.prepare(`UPDATE held_requests SET status = 'released' WHERE id = ?`).run(heldId);
    if (r.tool && r.args) {
      const a = JSON.parse(r.args);
      const bypass = { request_id: this.enqueue({ label: r.label, prompt: r.prompt, task_id: r.task_id, priority: r.priority, override: true }).id };
      try {
        if (r.tool === 'set_steps') this.setSteps(a.id, a.steps, bypass);
        else if (r.tool === 'attach_draft') this.attachDraft(a.id, a.text, a.gmail_draft_id, bypass);
        else if (r.tool === 'save_review') this.saveReview(a.week_start, a.text, bypass);
      } finally {
        this.db.prepare(`UPDATE pending_requests SET status = 'done', completed_at = ? WHERE id = ?`).run(this.stamp(), bypass.request_id);
      }
      this.setMeta({ last_cmd: r.label, last_reply: 'Done. Applied what Claude had already written.' });
      this.changed();
      return { applied: true };
    }
    const req = this.enqueue({ label: r.label, prompt: r.prompt, task_id: r.task_id, priority: r.priority, override: true });
    this.setMeta({ last_cmd: r.label, last_reply: 'Released. Claude runs it next time you open the chat.' });
    this.changed();
    return { applied: false, request: req };
  }

  private enqueue(q: { label: string; prompt: string; task_id: string | null; priority: Priority; override?: boolean; status?: string }): PendingRequest {
    const reqId = id('r');
    this.db.prepare('INSERT INTO pending_requests (id, label, prompt, task_id, priority, override, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(reqId, q.label, q.prompt, q.task_id, q.priority, q.override ? 1 : 0, this.stamp(), q.status ?? 'pending');
    return this.request(reqId)!;
  }

  private request(reqId: string): PendingRequest | undefined {
    const r = this.db.prepare('SELECT * FROM pending_requests WHERE id = ?').get(reqId) as Row | undefined;
    return r && { id: r.id, label: r.label, prompt: r.prompt, task_id: r.task_id, priority: r.priority, override: !!r.override, created_at: r.created_at, status: r.status, reply: r.reply };
  }

  /** A request from the UI's "Ask Claude" buttons. Low-priority requests at the reserve are held instead. */
  queueRequest(q: { prompt: string; label?: string; priority?: Priority; task_id?: string | null }): { status: 'pending'; request: PendingRequest } | { status: 'held'; held: HeldRequest } {
    const prompt = q.prompt.trim();
    if (!prompt) throw new DocketError('prompt is empty');
    const label = (q.label || prompt).trim().slice(0, 120);
    const task = q.task_id ? this.getTask(q.task_id) : null;
    const priority = q.priority ?? task?.priority ?? 'high';
    if (priority !== 'high' && this.atReserve(this.usage().used_pct, this.settings())) {
      const held = this.hold({ label, prompt, task_id: task?.id ?? null, priority });
      this.setMeta({ last_cmd: label, last_reply: 'Held: low priority and your budget is at the reserve. Run it from Usage when you want.' });
      this.changed();
      return { status: 'held', held };
    }
    const request = this.enqueue({ label, prompt, task_id: task?.id ?? null, priority });
    this.setMeta({ last_cmd: label, last_reply: 'Queued for Claude. Open Claude to run it.' });
    this.changed();
    return { status: 'pending', request };
  }

  pendingRequests(): PendingRequest[] {
    return (this.db.prepare(`SELECT id FROM pending_requests WHERE status = 'pending' ORDER BY created_at`).all() as Row[]).map(r => this.request(r.id)!);
  }

  completeRequest(reqId: string, reply?: string) {
    const r = this.request(reqId);
    if (!r) throw new DocketError(`No request "${reqId}"`);
    if (r.status !== 'pending') return r;
    this.db.prepare(`UPDATE pending_requests SET status = 'done', reply = ?, completed_at = ? WHERE id = ?`).run(reply ?? null, this.stamp(), reqId);
    this.setMeta({ last_cmd: r.label, last_reply: reply?.trim() || 'Done.', reply_at: this.stamp() });
    this.changed();
    return this.request(reqId)!;
  }

  cancelRequest(reqId: string) {
    const r = this.db.prepare(`UPDATE pending_requests SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(reqId);
    if (!r.changes) throw new DocketError(`No pending request "${reqId}"`);
    this.changed();
  }

  // ---------- reviews ----------

  saveReview(weekStartDay: string, text: string, opts: { request_id?: string } = {}) {
    if (!isIsoDay(weekStartDay)) throw new DocketError('week_start must be YYYY-MM-DD');
    const ws = weekStart(weekStartDay);
    this.guard('save_review', { week_start: ws, text }, { label: 'Weekly review', prompt: `Write my weekly review for the week starting ${ws} and save it with save_review.`, requestId: opts.request_id });
    this.db.prepare('INSERT INTO reviews (week_start, text, created_at, dismissed) VALUES (?, ?, ?, 0) ON CONFLICT(week_start) DO UPDATE SET text = excluded.text, created_at = excluded.created_at, dismissed = 0')
      .run(ws, text.trim(), this.stamp());
    this.changed();
    return { week_start: ws, text: text.trim() };
  }

  latestReview() {
    const r = this.db.prepare('SELECT * FROM reviews WHERE dismissed = 0 AND week_start >= ? ORDER BY week_start DESC LIMIT 1').get(addDays(weekStart(this.today()), -7)) as Row | undefined;
    return r ? { week_start: r.week_start as string, text: r.text as string, created_at: r.created_at as string } : null;
  }

  dismissReview(weekStartDay: string) {
    this.db.prepare('UPDATE reviews SET dismissed = 1 WHERE week_start = ?').run(weekStartDay);
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
    this.db.prepare('UPDATE finds SET status = ? WHERE id = ?').run(add ? 'added' : 'skipped', findId);
    const t = this.today();
    const task = add ? this.addTask({ title: f.title, area: f.area, project: f.project, est: f.est, priority: f.priority, energy: f.energy, due: f.due, source: 'gmail', day: t }) : null;
    this.changed();
    return task;
  }

  // ---------- meta ----------

  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
    return r ? r.value : null;
  }

  private setMeta(kv: Record<string, string>) {
    const st = this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(kv)) st.run(k, v);
  }

  // ---------- overview ----------

  /** What Claude reads at the start of every conversation. */
  overview(day?: string) {
    const today = this.today();
    const d = day && isIsoDay(day) ? day : today;
    const s = this.settings();
    const capMin = Math.round(s.capacity_hours * 60);
    const days = weekDays(d);
    const all = this.listTasks({ from: days[0], to: days[6], include_done: true });
    const compact = (t: Task) => ({
      id: t.id, title: t.title, area: t.area, ...(t.project ? { project: t.project } : {}), day: t.day,
      ...(t.due ? { due: t.due } : {}), est: t.est, priority: t.priority, energy: t.energy,
      ...(t.done ? { done: true } : {}), ...(t.source ? { source: t.source } : {}),
      ...(t.steps.length ? { steps: `${t.steps.filter(x => x.done).length}/${t.steps.length}` } : {}),
      ...(t.draft ? { has_draft: true } : {}),
    });
    const dayTasks = all.filter(t => t.day === d);
    const open = dayTasks.filter(t => !t.done);
    const openMin = open.reduce((a, t) => a + t.est, 0);
    const week = days.map(x => {
      const items = all.filter(t => t.day === x);
      const planned = items.reduce((a, t) => a + t.est, 0);
      return { date: x, label: fmtDay(x), planned_min: planned, free_min: Math.max(0, capMin - planned), over_min: Math.max(0, planned - capMin), past: x < today, tasks: items.map(compact) };
    });
    const overdue = this.listTasks({ to: addDays(today, -1) }).map(compact);
    return {
      today, weekday: DOWL[dt(today).getDay()],
      capacity_hours: s.capacity_hours,
      day: { date: d, open_min: openMin, capacity_min: capMin, over_min: Math.max(0, openMin - capMin), open: open.map(compact), done: dayTasks.filter(t => t.done).map(t => t.title) },
      week: { number: isoWeek(d), start: days[0], end: days[6], planned_min: week.reduce((a, x) => a + x.planned_min, 0), days_over: week.filter(x => x.over_min > 0).length, days: week },
      overdue,
      usage: this.usage(),
      pending_moves: this.pendingMoves(),
      held_requests: this.heldRequests().map(h => ({ id: h.id, label: h.label, created_at: h.created_at })),
      pending_requests: this.pendingRequests().length,
      open_inbox_suggestions: this.finds().length,
    };
  }

  /** Everything the web app renders. */
  state() {
    const today = this.today();
    const tasks = (this.db.prepare('SELECT * FROM tasks WHERE done = 0 OR day >= ? ORDER BY day, created_at').all(addDays(today, -60)) as Row[]).map(r => this.rowToTask(r));
    return {
      today,
      tasks,
      moves: this.pendingMoves(),
      held: this.heldRequests(),
      requests: this.pendingRequests(),
      usage: this.usage(),
      settings: this.settings(),
      emails: this.emails(),
      finds: this.finds(),
      review: this.latestReview(),
      last_cmd: this.meta('last_cmd') ?? '',
      reply: this.meta('last_reply') ?? 'Tell me what to add, move or plan. Tap the mic or type.',
      reply_at: this.meta('reply_at'),
      inbox_checked_at: this.meta('inbox_checked_at'),
    };
  }

  // ---------- sample data ----------

  loadSample() {
    tx(this.db, () => {
      for (const t of ['steps', 'moves', 'tasks', 'held_requests', 'pending_requests', 'emails', 'finds', 'reviews', 'meta']) this.db.prepare(`DELETE FROM ${t}`).run();
    });
    const t = this.today(), n = (k: number) => addDays(t, k);
    const add = (o: Partial<TaskInput> & { title: string; steps?: [string, boolean][]; done?: boolean }) => {
      const task = this.addTask({ area: 'Work', est: 30, priority: 'med', energy: 'low', day: t, ...o });
      if (o.steps) {
        const ins = this.db.prepare('INSERT INTO steps (task_id, idx, text, done) VALUES (?, ?, ?, ?)');
        o.steps.forEach(([s, done], i) => ins.run(task.id, i, s, done ? 1 : 0));
      }
      if (o.done) this.db.prepare('UPDATE tasks SET done = 1 WHERE id = ?').run(task.id);
    };
    add({ title: 'Finish Q4 budget deck', project: 'Q4 planning', est: 150, priority: 'high', energy: 'high', steps: [['Gather numbers', true], ['Outline', true], ['Revenue slides', false], ['Send to Priya', false]] });
    add({ title: 'Team sync', est: 60 });
    add({ title: "Review Sam's contract", est: 55, priority: 'high', source: 'gmail' });
    add({ title: 'Reply to Sam about contract renewal', est: 15, priority: 'high', source: 'gmail' });
    add({ title: 'Pay Acme invoice', est: 10, priority: 'high', due: n(1), source: 'gmail' });
    add({ title: 'Call mum', area: 'Personal', est: 20 });
    add({ title: 'Book dentist', area: 'Health', est: 5, priority: 'low' });
    add({ title: 'Groceries', area: 'Personal', est: 45 });
    add({ title: 'Plan Lisbon trip', area: 'Personal', project: 'Lisbon trip', est: 60, priority: 'low' });
    add({ title: 'Gym', area: 'Health', est: 40, energy: 'high' });
    add({ title: 'Laundry', area: 'Personal', est: 30, day: n(1), priority: 'low' });
    add({ title: 'Book Lisbon flights', area: 'Personal', project: 'Lisbon trip', est: 30, day: n(2) });
    add({ title: 'Run', area: 'Health', est: 45, day: n(2), energy: 'high' });
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
    this.changed();
  }
}
