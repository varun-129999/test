// The prompts the app's "Ask Claude" buttons queue. Claude runs them in the owner's own
// Claude chat (on their plan), never from this app.
import type { Request, Task } from './types';

export const P = {
  planDay: 'Plan my day. If today is over my free time, propose moves for lower-priority tasks to days this week with room. Suggest an order based on energy.',
  balanceWeek: 'Balance my week: propose moves so no day goes over my free time. Keep high-priority tasks near their due dates.',
  review: (ws: string) => `Write my weekly review for the week starting ${ws}: what got done, what slipped, what to focus on next week. Under 80 words. Save it with save_review.`,
  scanGmail: 'Use my Gmail connector to read my recent emails (last 2 days). Call record_emails with them so they show in Docket, then suggest_tasks for tasks and deadlines. Skip newsletters and anything already in Docket; if an email gives a deadline for an existing task, use update_task to set its due.',
  breakDown: (t: Task) => `Break down task ${t.id} "${t.title}" into 3-6 concrete steps with set_steps, and update est if needed.`,
  estimate: (t: Task) => `Estimate how long task ${t.id} "${t.title}" takes and update est. Tell me the estimate.`,
  draft: (t: Task) => `Write the draft for task ${t.id} "${t.title}" and store it with attach_draft. If it's an email, find the thread with my Gmail connector and write the body only, ready to send.`,
  saveDraft: (t: Task) => `Save the draft on task ${t.id} "${t.title}" to my Gmail drafts with the Gmail connector, then call attach_draft with the same text and the gmail_draft_id.`,
};

/** Text to paste into (or prefill) a Claude chat for the queued requests. */
export function claudePrompt(reqs: Request[]): string {
  if (reqs.length === 1) return `${reqs[0].prompt}\n\n(Docket request ${reqs[0].id}: call complete_request with a one-line reply when done.)`;
  return 'Check Docket: get_pending_requests, handle each one, then complete_request.';
}

export function claudeLink(base: string, text: string): string {
  try {
    const u = new URL(base || 'https://claude.ai/new');
    u.searchParams.set('q', text);
    return u.toString();
  } catch {
    return 'https://claude.ai/new?q=' + encodeURIComponent(text);
  }
}
