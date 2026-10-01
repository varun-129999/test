// One set of zod schemas for both the MCP tools and the REST API, so every write is
// validated the same way: enums with forgiving aliases, real dates, and length caps
// (anything stored here is read back into Claude's context, so size is usage).
import { z } from 'zod';
import { isIsoDay } from './dates.js';

export const AREAS = ['Work', 'Personal', 'Health'] as const;
export const PRIORITIES = ['high', 'med', 'low'] as const;
export const ENERGIES = ['high', 'low'] as const;
export type Area = (typeof AREAS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Energy = (typeof ENERGIES)[number];
export const ORIGIN_KINDS = ['chat', 'cowork', 'claude_code', 'email', 'docket'] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

export const CAPS = {
  title: 200, project: 100, notes: 4000, link: 500, step: 300, reason: 300, label: 120, prompt: 2000,
  reply: 500, origin: 120, detail: 2000, draft: 20000, review: 2000, result: 4000, plan: 2000, email: 300, snippet: 500, when: 40, id: 64,
} as const;

// Enums accept the obvious spellings ("medium", "work"); norm() turns them into the stored
// forms. The JSON Schema Claude reads shows only the stored forms (via .meta), because every
// character of the tool list is paid for in every chat.
const PRIORITY_IN = ['high', 'med', 'medium', 'mid', 'low', 'High', 'Med', 'Medium', 'Low'] as const;
const AREA_IN = ['Work', 'Personal', 'Health', 'work', 'personal', 'health'] as const;
const ENERGY_IN = ['high', 'low', 'High', 'Low'] as const;
export const normPriority = (v: string): Priority => { const s = v.toLowerCase(); return s === 'high' ? 'high' : s === 'low' ? 'low' : 'med'; };
export const normArea = (v: string): Area => { const s = v.toLowerCase(); return s === 'personal' ? 'Personal' : s === 'health' ? 'Health' : 'Work'; };
export const normEnergy = (v: string): Energy => (v.toLowerCase() === 'high' ? 'high' : 'low');
const ORIGIN_IN = [...ORIGIN_KINDS, 'claude-code', 'Claude Code', 'code', 'gmail', 'Chat', 'Cowork', 'Email', 'Docket'] as const;
export const normOriginKind = (v: string): OriginKind => {
  const s = v.toLowerCase().replace(/[\s-]+/g, '_');
  return s === 'code' ? 'claude_code' : s === 'gmail' ? 'email' : (ORIGIN_KINDS as readonly string[]).includes(s) ? (s as OriginKind) : 'chat';
};

export const priority = z.enum(PRIORITY_IN).meta({ enum: [...PRIORITIES] });
export const area = z.enum(AREA_IN).meta({ enum: [...AREAS] });
export const energy = z.enum(ENERGY_IN).meta({ enum: [...ENERGIES] });
// isIsoDay checks the format as well as the date, so the schema needs no regex pattern.
export const day = z.string().refine(isIsoDay, {
  error: iss => (/^\d{4}-\d{2}-\d{2}$/.test(String(iss.input)) ? `"${String(iss.input)}" is not a real date` : `"${String(iss.input)}" is not a YYYY-MM-DD date`),
}).meta({ format: 'date' });
export const minutes = z.number().positive().max(24 * 60).describe('Minutes');
// Ids are copied, never typed: their length limit is enforced but not worth showing.
export const id = z.string().trim().min(1).max(CAPS.id).meta({ minLength: undefined, maxLength: undefined });
const requestId = id.optional().describe('The queued request this handles');
/** Links are rendered as hrefs in the app: only web and mail links, never javascript: or data:. */
export const isSafeUrl = (v: string) => /^(https?:\/\/|mailto:)\S+$/i.test(v.trim());
/** Origin links open a chat or session from the app: https only (claude.ai, claude.com or any other https site). */
export const isHttpsUrl = (v: string) => {
  const t = v.trim();
  if (!/^https:\/\/\S+$/i.test(t)) return false;
  try { return new URL(t).protocol === 'https:'; } catch { return false; }
};
const url = (max: number) => z.string().trim().max(max).refine(isSafeUrl, 'must start with https://, http:// or mailto:');
const text = (max: number) => z.string().trim().min(1).max(max);
const str = (max: number) => z.string().trim().max(max);
/** Optional, and null means "not given" (forms send it); Claude sees the plain schema without a null branch. */
function orNull<T extends z.ZodType>(s: T) {
  const { $schema: _, ...json } = z.toJSONSchema(s, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
  return z.preprocess(v => (v === null ? undefined : v), s.optional()).meta(json).optional();
}
/** On a patch, null clears the field. */
const clearable = <T extends z.ZodType>(s: T) => s.nullable().optional();

/** Where a task came from. The link is the context: "Give to Claude" continues there. */
export const Origin = z.object({
  kind: orNull(z.enum(ORIGIN_IN).meta({ enum: [...ORIGIN_KINDS] })),
  title: orNull(str(CAPS.origin)).describe("The chat's or session's title"),
  url: orNull(z.string().trim().max(CAPS.link).refine(isHttpsUrl, 'must be an https:// link')),
});

export const TaskInput = z.object({
  title: text(CAPS.title),
  area,
  project: orNull(str(CAPS.project)),
  day: orNull(day),
  due: orNull(day),
  est: minutes,
  priority,
  energy,
  source: orNull(z.enum(['gmail'])).describe('"gmail" if from an email'),
  notes: orNull(str(CAPS.notes)).describe('Context, what "done" means'),
  link: orNull(url(CAPS.link)),
  origin: orNull(Origin).describe('Where the task came from'),
});
export const TaskPatch = z.object({
  title: text(CAPS.title).optional(),
  area: area.optional(),
  project: clearable(str(CAPS.project)),
  day: day.optional(),
  due: clearable(day),
  est: minutes.optional(),
  priority: priority.optional(),
  energy: energy.optional(),
  source: clearable(z.enum(['gmail'])),
  notes: clearable(str(CAPS.notes)),
  link: clearable(url(CAPS.link)),
  origin: clearable(Origin),
  done: z.boolean().optional(),
  result: z.null().optional().describe('null clears the result'),
});
export const StepIn = z.union([text(CAPS.step), z.object({ text: text(CAPS.step), done: z.boolean().optional() })]);

export const Empty = z.object({});
export const ById = z.object({ id });
export const GetOverview = z.object({ day: day.optional().describe("Any date: returns its Monday-Sunday week. Default today") });
export const AddTask = TaskInput;
export const AddTasks = z.object({ tasks: z.array(TaskInput).min(1).max(25) });
export const UpdateTask = TaskPatch.extend({ id });
export const UpdateTasks = z.object({ ids: z.array(id).min(1).max(50), set: TaskPatch });
export const SetSteps = z.object({ id, steps: z.array(StepIn).max(20), request_id: requestId });
export const AddSteps = z.object({ id, steps: z.array(text(CAPS.step)).min(1).max(20), at: z.number().int().min(0).optional().describe('Position; default the end') });
export const SetStep = z.object({ id, index: z.number().int().min(0), done: z.boolean() });
export const StepDone = z.object({ done: z.boolean() });
export const Approve = z.object({ approve: z.boolean() });
export const Seen = z.object({ ids: z.array(id).max(100).optional() });
export const ProposeMoves = z.object({ moves: z.array(z.object({ id, to_day: day, reason: str(CAPS.reason).optional() })).min(1).max(30) });
export const ResolveMoves = z.object({ move_ids: z.array(id).max(50).optional(), all: z.boolean().optional(), approve: z.boolean() });
export const AttachDraft = z.object({ id, text: text(CAPS.draft), gmail_draft_id: str(200).nullable().optional(), request_id: requestId });
export const AttachResult = z.object({ id, text: text(CAPS.result), url: url(CAPS.link).optional(), request_id: requestId });
export const SetUsage = z.object({
  used_pct: z.number().min(0).max(100),
  resets_at: z.string().max(40).refine(v => Number.isFinite(Date.parse(v)), 'not an ISO date-time').optional().describe('ISO date-time of the weekly reset'),
  source: z.enum(['owner', 'claude', 'statusline']).optional(),
});
export const SetSettings = z.object({
  capacity_hours: z.number().min(0.5).max(24).optional(),
  reserve_pct: z.number().min(0).max(100).optional(),
  high_only: z.boolean().optional(),
  claude_url: str(500).optional(),
  reset: z.string().regex(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{2}:\d{2}$/, 'e.g. "Mon 09:00"').optional(),
});
export const QueueRequest = z.object({ prompt: text(CAPS.prompt), label: str(CAPS.label).optional(), priority: priority.optional(), task_id: id.nullable().optional() });
export const HoldRequest = z.object({ label: text(CAPS.label), prompt: text(CAPS.prompt), task_id: id.optional(), priority: priority.optional() });
export const CompleteRequest = z.object({
  id, reply: str(CAPS.reply).optional(),
  outcome: z.enum(['done', 'needs_owner', 'failed']).optional(),
  detail: str(CAPS.detail).optional().describe('What you need, or what went wrong'),
});
export const SaveReview = z.object({ week_start: day.describe('Monday of the week reviewed'), text: text(CAPS.review), request_id: requestId });
export const SetWeekPlan = z.object({ week_start: day.optional().describe('Monday; default this week'), text: text(CAPS.plan) });
export const RecordEmails = z.object({
  emails: z.array(z.object({
    from: text(CAPS.email), subject: text(CAPS.email), snippet: str(CAPS.snippet).optional(),
    when: str(CAPS.when).optional().describe('e.g. "09:12" or "Yesterday"'), thread_id: str(100).optional(),
  })).max(50),
});
export const SuggestTasks = z.object({
  suggestions: z.array(z.object({
    title: text(CAPS.title), area: area.optional(), project: orNull(str(CAPS.project)), due: orNull(day), est: minutes.optional(),
    priority: priority.optional(), energy: energy.optional(), email_id: id.optional(),
  })).min(1).max(25),
});
export const ListTasks = z.object({
  from: day.optional(), to: day.optional(), area: area.optional(), project: str(CAPS.project).optional(),
  q: str(100).optional().describe('Text in titles, projects or notes'),
  ids: z.array(id).max(50).optional(),
  include_done: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Default 30'),
  detail: z.enum(['compact', 'full']).optional(),
});

type OriginOut = { kind?: OriginKind; title?: string; url?: string };
type Fixed<T> = {
  [K in keyof T]: K extends 'origin' ? OriginOut | Extract<T[K], null | undefined>
    : K extends 'area' ? Area | Extract<T[K], null | undefined>
    : K extends 'priority' ? Priority | Extract<T[K], null | undefined>
    : K extends 'energy' ? Energy | Extract<T[K], null | undefined> : T[K];
};

/** Normalises the forgiving enum spellings to their stored forms. */
export function norm<T extends object>(v: T): Fixed<T> {
  const out = { ...v } as Record<string, unknown>;
  if (typeof out.area === 'string') out.area = normArea(out.area);
  if (typeof out.priority === 'string') out.priority = normPriority(out.priority);
  if (typeof out.energy === 'string') out.energy = normEnergy(out.energy);
  const o = out.origin as Record<string, unknown> | null | undefined;
  if (o && typeof o.kind === 'string') out.origin = { ...o, kind: normOriginKind(o.kind) };
  return out as Fixed<T>;
}

/** "title: Too big: expected string to have <=200 characters; est: ..." for a 400 or a tool error. */
export function issuesText(e: z.ZodError): string {
  return e.issues.map(i => `${i.path.length ? i.path.join('.') : 'body'}: ${i.message}`).join('; ');
}
