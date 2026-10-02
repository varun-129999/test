// Shapes of GET /api/state (contract sections 1 and 6). normalizeState() in api.ts fills
// anything an older server leaves out, so screens can rely on every field being present.
export type Area = 'Work' | 'Personal' | 'Health';
export type Priority = 'high' | 'med' | 'low';
export type Energy = 'high' | 'low';
export type Outcome = 'done' | 'needs_owner' | 'failed' | 'held' | 'cancelled';
export type OriginKind = 'chat' | 'cowork' | 'claude_code' | 'email' | 'docket';
/** Where a task came from. On requests the server sends only the fields that are set. */
export interface Origin { kind?: OriginKind | null; title?: string | null; url?: string | null }

export interface Step { text: string; done: boolean }
export interface Task {
  id: string; title: string; area: Area; project: string | null; day: string; due: string | null;
  est: number; priority: Priority; energy: Energy; done: boolean; completed_at: string | null; source: 'gmail' | null;
  draft: string | null; gmail_draft_id: string | null; notes: string | null; link: string | null;
  result: string | null; result_url: string | null; result_at: string | null;
  origin_kind: OriginKind | null; origin_title: string | null; origin_url: string | null;
  /** Schema v4 (0.4.0): time of day "HH:MM" (24h, local), the repeat rule in canonical form, and its series. */
  at: string | null; repeat: string | null; repeat_from: 'planned' | 'done'; series_id: string | null;
  steps: Step[]; created_at: string; updated_at: string;
}
/** Body of POST /api/tasks. */
export interface TaskInput {
  title: string; area: Area; project?: string | null; day?: string; due?: string | null;
  est: number; priority: Priority; energy: Energy; notes?: string | null; link?: string | null; origin?: Origin | null;
  at?: string | null; repeat?: string | null; repeat_from?: 'planned' | 'done';
}
/** Body of PATCH /api/tasks/:id. */
export type TaskPatch = Partial<TaskInput> & { done?: boolean; result?: null };
/** PATCH /api/tasks/:id answers with the task, plus the next instance when completing a recurring one created it. */
export type PatchResult = Task & { next?: { id: string; day: string } };

export interface Move { id: string; task_id: string; title: string; from_day: string; to_day: string; reason: string }
export interface HeldRequest { id: string; label: string; prompt: string; task_id: string | null; priority: Priority; created_at: string; tool?: string | null }
export interface PendingRequest {
  id: string; label: string; prompt: string; task_id: string | null; priority: Priority; override: boolean; created_at: string;
  status: 'pending' | 'done' | 'cancelled'; reply: string | null; outcome: Outcome | null; detail: string | null; seen: boolean; completed_at: string | null;
  origin: Origin | null;
}
export interface WeekPlan { week_start: string; text: string; updated_at: string }
export interface Email { id: string; from: string; subject: string; snippet: string; when: string; thread_id?: string | null }
export interface Find { id: string; title: string; area: Area; due: string | null; est: number; priority: Priority }
export interface Usage {
  period_start: string; resets_at: string; resets_label: string; used_pct: number; left_pct: number; updated_at: string | null;
  source: 'owner' | 'claude' | 'statusline' | null; est_pct: number; estimated: boolean; calls_since_reset: number;
  reserve_pct: number; high_only: boolean; at_reserve: boolean; near_reserve: boolean;
}
/** A soft-deleted task (0.5.0): restorable for 30 days. */
export interface DeletedTask { id: string; title: string; day: string; area: Area; deleted_at: string }
export interface Settings { capacity_hours: number; reserve_pct: number; high_only: boolean; week_start: string; reset: string; pct_per_call: number; claude_url: string }

export interface State {
  today: string; now: string; tz: string; tasks: Task[]; moves: Move[]; held: HeldRequest[];
  requests: PendingRequest[]; recent: PendingRequest[]; usage: Usage; settings: Settings;
  emails: Email[]; finds: Find[]; review: { week_start: string; text: string } | null;
  week_plan: WeekPlan | null; reset_notice: { n: number; at: string } | null;
  last_cmd: string; reply: string; reply_at: string | null; inbox_checked_at: string | null;
  /** 0.5.0: tasks deleted in the last 30 days, newest first. */
  deleted: DeletedTask[];
  /** `trash`: the server sent `deleted`, so it soft-deletes and Undo / Restore work (set by normalizeState). */
  flags: { sample: boolean; trash: boolean }; version: string;
}

/** Response of POST /api/requests. */
export type QueueResult = { status: 'pending'; request: PendingRequest; existing?: boolean } | { status: 'held'; held: HeldRequest };
