export type Area = 'Work' | 'Personal' | 'Health';
export type Priority = 'high' | 'med' | 'low';
export type Energy = 'high' | 'low';

export interface Task {
  id: string; title: string; area: Area; project: string | null; day: string; due: string | null;
  est: number; priority: Priority; energy: Energy; done: boolean; source: 'gmail' | null;
  draft: string | null; gmail_draft_id: string | null; steps: { text: string; done: boolean }[];
}
export interface Move { id: string; task_id: string; title: string; from_day: string; to_day: string; reason: string }
export interface Held { id: string; label: string; prompt: string; task_id: string | null; tool: string | null; created_at: string }
export interface Request { id: string; label: string; prompt: string; task_id: string | null; created_at: string }
export interface Email { id: string; from: string; subject: string; snippet: string; when: string }
export interface Find { id: string; title: string; area: Area; due: string | null; est: number; priority: Priority }
export interface Usage {
  period_start: string; resets_at: string; used_pct: number; left_pct: number; updated_at: string | null;
  estimated_used_pct: number; estimated: boolean; calls_since_reset: number; reserve_pct: number; high_only: boolean; at_reserve: boolean;
}
export interface Settings { capacity_hours: number; reserve_pct: number; high_only: boolean; claude_url: string }

export interface State {
  today: string; tasks: Task[]; moves: Move[]; held: Held[]; requests: Request[]; usage: Usage; settings: Settings;
  emails: Email[]; finds: Find[]; review: { week_start: string; text: string } | null;
  last_cmd: string; reply: string; reply_at: string | null; inbox_checked_at: string | null;
}
