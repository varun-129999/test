// Mac keyboard shortcuts (wide layout only). keyAction is pure so the typing guard can be tested;
// the small emitter lets screens with local state (Today's open block) take the keys they own.
export type KeyAction = 'help' | 'escape' | 'blur' | 'add' | 'search' | 'composer' | 'today' | 'week' | 'inbox' | 'usage' | 'prev-week' | 'next-week' | 'done' | 'delete';

export interface KeyLike { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean; target?: unknown }

const NOT_TEXT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/** True when keys go into a field: text inputs, textareas, selects and editable content. */
export function isTyping(t: unknown): boolean {
  if (!t || typeof t !== 'object') return false;
  const el = t as { tagName?: unknown; type?: unknown; isContentEditable?: unknown };
  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TEXT.has(String(el.type || 'text').toLowerCase());
  return el.isContentEditable === true;
}

const MAP: Record<string, KeyAction> = {
  '?': 'help', n: 'add', '/': 'search', c: 'composer', t: 'today', w: 'week', i: 'inbox', u: 'usage',
  '[': 'prev-week', ']': 'next-week', e: 'done', x: 'delete',
};

/**
 * The action for a key press, or null. Never fires with ⌘, Ctrl or Option (so ⌘R, ⌘F work) or
 * mid-composition. While typing in a field only Esc does anything: it leaves the field.
 */
export function keyAction(e: KeyLike): KeyAction | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isTyping(e.target)) return e.key === 'Escape' ? 'blur' : null;
  if (e.key === 'Escape') return 'escape';
  return MAP[e.key.length === 1 ? e.key.toLowerCase() : ''] ?? null;
}

export const SHORTCUTS: [string[], string][] = [
  [['n'], 'Add a task (Today) or type to Claude'],
  [['/'], 'Search tasks'],
  [['c'], 'Type to Claude'],
  [['t', 'w', 'i', 'u'], 'Today, Week, Inbox, Usage'],
  [['[', ']'], 'Previous or next week (Week)'],
  [['e'], 'Mark the open task done'],
  [['x'], 'Delete the open task'],
  [['Esc'], 'Close this, the open task, or leave a field'],
  [['?'], 'Show or hide this list'],
];

type Handler = (a: KeyAction) => boolean | void;
const subs = new Set<Handler>();
/** Listen for actions; return true to say the action was handled. */
export function onKey(fn: Handler): () => void { subs.add(fn); return () => { subs.delete(fn); }; }
/** Offers an action to the listeners, newest first; true when one handled it. */
export function emitKey(a: KeyAction): boolean {
  for (const fn of [...subs].reverse()) if (fn(a) === true) return true;
  return false;
}
