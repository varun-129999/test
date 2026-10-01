import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AREAS, DocketError, ENERGIES, PRIORITIES, type Store } from './store.js';
import { version } from './version.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const area = z.enum(AREAS);
const priority = z.enum(PRIORITIES);
const energy = z.enum(ENERGIES);
const minutes = z.number().positive().describe('Minutes');
const requestId = z.string().optional().describe('The id of the pending request this call handles. A released ("Run anyway") request lets the call bypass the budget guard.');

export const INSTRUCTIONS = `Docket is the owner's task organiser. Be brief and direct, 1-2 sentences.
Call get_overview first in every conversation, then get_pending_requests and handle anything queued (call complete_request with a one-line reply for each).
Weeks start Monday. Usage resets Monday 09:00. Areas: Work, Personal, Health. Priority: high, med, low. Energy: high, low. Dates are YYYY-MM-DD, durations are minutes.
When adding tasks, always set est, area, priority and energy; resolve relative dates from today.
Only change a task's day when the owner explicitly asks. When planning or rebalancing, use propose_moves; the owner approves each move.
If a day is over the owner's free time, say by how much and propose moves for lower-priority tasks to days with room.
If usage.at_reserve is true, do not do breakdowns, drafts or reviews for tasks below high priority: tell the owner the request is held.
For email, use Claude's own Gmail connector, then record_emails, suggest_tasks or add_task with source "gmail". Save drafts with the Gmail connector if possible, then attach_draft.`;

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: 'docket', version }, { instructions: INSTRUCTIONS });

  const run = (tool: string, fn: () => unknown): Result => {
    store.logCall(tool);
    try {
      const out = fn();
      return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out) }] };
    } catch (e) {
      if (e instanceof DocketError) return { content: [{ type: 'text', text: e.message }], isError: true };
      throw e;
    }
  };

  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool('get_overview', {
    title: 'Get overview',
    description: 'Today, the week (Monday start) with planned minutes per day, capacity, usage and budget state, pending moves and held requests. Call this first in every conversation.',
    inputSchema: { day: day.optional().describe('Day to focus on; defaults to today') },
    annotations: read,
  }, ({ day }) => run('get_overview', () => store.overview(day)));

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'Lists matching tasks with their steps and drafts. Open tasks only unless include_done is true.',
    inputSchema: { from: day.optional(), to: day.optional(), area: area.optional(), project: z.string().optional(), include_done: z.boolean().optional() },
    annotations: read,
  }, args => run('list_tasks', () => store.listTasks(args)));

  server.registerTool('add_task', {
    title: 'Add task',
    description: 'Creates a task. day defaults to today. Always give an estimate, area, priority and energy.',
    inputSchema: {
      title: z.string().min(1), area, project: z.string().optional(), day: day.optional(), due: day.optional(),
      est: minutes, priority, energy, source: z.enum(['gmail']).optional().describe('"gmail" when the task came from an email'),
    },
    annotations: write,
  }, args => run('add_task', () => store.addTask(args)));

  server.registerTool('update_task', {
    title: 'Update task',
    description: 'Changes fields of a task. Change day only when the owner explicitly asks to move it; otherwise use propose_moves. Pass null to clear project or due.',
    inputSchema: {
      id: z.string(), title: z.string().min(1).optional(), area: area.optional(), project: z.string().nullable().optional(),
      day: day.optional(), due: day.nullable().optional(), est: minutes.optional(), priority: priority.optional(), energy: energy.optional(),
      done: z.boolean().optional(),
    },
    annotations: write,
  }, ({ id, ...patch }) => run('update_task', () => store.updateTask(id, patch)));

  server.registerTool('complete_task', {
    title: 'Complete task', description: 'Marks a task done.', inputSchema: { id: z.string() }, annotations: { ...write, idempotentHint: true },
  }, ({ id }) => run('complete_task', () => store.completeTask(id)));

  server.registerTool('delete_task', {
    title: 'Delete task', description: 'Deletes a task, its steps and its pending moves.', inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, ({ id }) => run('delete_task', () => ({ deleted: store.deleteTask(id).title })));

  server.registerTool('set_steps', {
    title: 'Set steps',
    description: 'Replaces the step list of a task (usually 3-6 concrete steps). Held by the budget guard for tasks below high priority when usage is at the reserve.',
    inputSchema: { id: z.string(), steps: z.array(z.string().min(1)).max(20), request_id: requestId },
    annotations: write,
  }, ({ id, steps, request_id }) => run('set_steps', () => store.setSteps(id, steps, { request_id })));

  server.registerTool('toggle_step', {
    title: 'Toggle step', description: 'Marks one step done or not done. index is 0-based.',
    inputSchema: { id: z.string(), index: z.number().int().min(0) }, annotations: write,
  }, ({ id, index }) => run('toggle_step', () => store.toggleStep(id, index)));

  server.registerTool('propose_moves', {
    title: 'Propose moves',
    description: 'Suggests moving tasks to other days. The owner approves or skips each one; this never moves tasks directly. Only propose days with room under the daily free time.',
    inputSchema: { moves: z.array(z.object({ id: z.string().describe('Task id'), to_day: day, reason: z.string().describe('Short reason') })).min(1) },
    annotations: write,
  }, ({ moves }) => run('propose_moves', () => ({ proposed: store.proposeMoves(moves), note: 'Ask the owner: "Move these?"' })));

  server.registerTool('resolve_move', {
    title: 'Resolve move', description: 'Call when the owner approves or skips a suggested move in chat.',
    inputSchema: { move_id: z.string(), approve: z.boolean() }, annotations: write,
  }, ({ move_id, approve }) => run('resolve_move', () => store.resolveMove(move_id, approve)));

  server.registerTool('attach_draft', {
    title: 'Attach draft',
    description: 'Stores a draft (for example an email body) on a task. Pass gmail_draft_id if you saved it with the Gmail connector. Held by the budget guard for tasks below high priority at the reserve.',
    inputSchema: { id: z.string(), text: z.string().min(1), gmail_draft_id: z.string().optional(), request_id: requestId },
    annotations: write,
  }, ({ id, text, gmail_draft_id, request_id }) => run('attach_draft', () => store.attachDraft(id, text, gmail_draft_id, { request_id })));

  server.registerTool('get_usage', {
    title: 'Get usage', description: 'Self-reported weekly Claude usage, the call-based estimate since the last report, and the budget state.',
    inputSchema: {}, annotations: read,
  }, () => run('get_usage', () => ({ ...store.usage(), docket_version: version })));

  server.registerTool('set_usage', {
    title: 'Set usage', description: 'Records the owner\'s weekly Claude usage when they tell you ("I\'ve used 65%").',
    inputSchema: { used_pct: z.number().min(0).max(100) }, annotations: { ...write, idempotentHint: true },
  }, ({ used_pct }) => run('set_usage', () => store.setUsage(used_pct)));

  server.registerTool('set_settings', {
    title: 'Set settings', description: 'Changes free time per day (hours), the reserve kept for high priority (%), and high-priority-only mode.',
    inputSchema: { capacity_hours: z.number().min(0.5).max(24).optional(), reserve_pct: z.number().min(0).max(100).optional(), high_only: z.boolean().optional() },
    annotations: { ...write, idempotentHint: true },
  }, args => run('set_settings', () => store.setSettings(args)));

  server.registerTool('get_pending_requests', {
    title: 'Get pending requests',
    description: 'Requests the owner queued from the Docket app. Handle each one (pass its id as request_id to set_steps, attach_draft or save_review), then call complete_request.',
    inputSchema: {}, annotations: read,
  }, () => run('get_pending_requests', () => {
    const reqs = store.pendingRequests();
    return reqs.length ? reqs.map(r => ({ id: r.id, prompt: r.prompt, task_id: r.task_id ?? undefined, priority: r.priority, budget_override: r.override || undefined, created_at: r.created_at })) : 'No pending requests.';
  }));

  server.registerTool('complete_request', {
    title: 'Complete request', description: 'Marks a queued request handled. reply is shown in the Docket app (1-2 short sentences).',
    inputSchema: { id: z.string(), reply: z.string().optional() }, annotations: { ...write, idempotentHint: true },
  }, ({ id, reply }) => run('complete_request', () => store.completeRequest(id, reply)));

  server.registerTool('save_review', {
    title: 'Save weekly review', description: 'Stores the weekly review (under 80 words: done, slipped, focus next). Held by the budget guard at the reserve.',
    inputSchema: { week_start: day.describe('Monday of the week reviewed'), text: z.string().min(1), request_id: requestId },
    annotations: { ...write, idempotentHint: true },
  }, ({ week_start, text, request_id }) => run('save_review', () => store.saveReview(week_start, text, { request_id })));

  server.registerTool('record_emails', {
    title: 'Record emails',
    description: 'Shows the emails you read with the Gmail connector in Docket\'s Inbox screen. Replaces the previous list.',
    inputSchema: {
      emails: z.array(z.object({ from: z.string(), subject: z.string(), snippet: z.string().optional(), when: z.string().optional().describe('Display time, e.g. "09:12" or "Yesterday"'), thread_id: z.string().optional() })).max(50),
    },
    annotations: write,
  }, ({ emails }) => run('record_emails', () => store.recordEmails(emails).map(e => ({ id: e.id, from: e.from, subject: e.subject }))));

  server.registerTool('suggest_tasks', {
    title: 'Suggest tasks from email',
    description: 'Adds tasks found in email as suggestions the owner can Add or Skip in the Inbox. Skip newsletters and tasks that already exist; for a deadline on an existing task, use update_task with due instead.',
    inputSchema: {
      suggestions: z.array(z.object({ title: z.string().min(1), area: area.optional(), project: z.string().optional(), due: day.optional(), est: minutes.optional(), priority: priority.optional(), energy: energy.optional(), email_id: z.string().optional() })).min(1),
    },
    annotations: write,
  }, ({ suggestions }) => run('suggest_tasks', () => store.suggestTasks(suggestions)));

  return server;
}
