// Claude app links. The Claude desktop app answers claude:// links (support.claude.com, "Open
// Claude Desktop with a link"): claude://claude.ai/<path> for a chat, a project or a new chat with
// ?q=, and claude://cowork/new or claude://code/new with ?q= for a session with the composer filled
// in. No link resumes an existing Cowork or Claude Code session by id yet (anthropics/claude-code
// issue 81202), so a session origin opens the app with the request ready and the owner picks the
// session in its sidebar. Nothing here is verified against the iPhone app, so the phone keeps https.
import type { OriginKind } from './types';

export type LinkPref = 'app' | 'browser';
const KEY = 'docket.links';

/** A Mac or a Windows PC, where the Claude desktop app can be installed. iPadOS reports itself as a Mac. */
export const isDesktop = () => typeof navigator !== 'undefined' && /Macintosh|Windows NT/.test(navigator.userAgent) && !/iPhone|iPad|Android/.test(navigator.userAgent);

/** Where Claude links open on this device; the owner's choice under Usage, otherwise the app on a desktop. */
export function linkPref(): LinkPref {
  try { const v = localStorage.getItem(KEY); if (v === 'app' || v === 'browser') return v; } catch { /* private mode */ }
  return isDesktop() ? 'app' : 'browser';
}
export function setLinkPref(v: LinkPref) { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } }

/** True when the link is a Cowork or Claude Code session, which the app can't reopen by link. */
export const isSessionLink = (url: string) => /^https:\/\/claude\.ai\/code\/session_[\w-]+/i.test(url);

/**
 * The claude:// form of an https claude.ai link, or null when there is none. A session link
 * becomes a new Cowork or Claude Code composer (by origin kind; a claude.ai/code link without a
 * kind is Claude Code) holding `prompt`, which the documented links take as ?q=.
 */
export function appLink(url: string, kind?: OriginKind | null, prompt?: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'claude.ai') return null;
  if (isSessionLink(url)) {
    const q = prompt ? '?q=' + encodeURIComponent(prompt) : '';
    return (kind === 'cowork' ? 'claude://cowork/new' : 'claude://code/new') + q;
  }
  return 'claude://claude.ai' + u.pathname + u.search;
}

/**
 * Opens an app link from the page, then calls `fallback` if the page is still in front a moment
 * later, which is how a browser without the app behaves (it does nothing, or shows its own note).
 */
export function openInApp(app: string, fallback: () => void, ms = 1500): void {
  let left = false;
  const gone = () => { left = true; };
  document.addEventListener('visibilitychange', gone);
  window.addEventListener('blur', gone);
  window.setTimeout(() => {
    document.removeEventListener('visibilitychange', gone);
    window.removeEventListener('blur', gone);
    if (!left && document.visibilityState === 'visible') fallback();
  }, ms);
  window.location.href = app;
}
