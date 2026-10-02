// Claude app links. The Claude desktop app answers claude:// links (support.claude.com, "Open
// Claude Desktop with a link"): claude://claude.ai/<path> for a chat, a project or a new chat with
// ?q=. The same form with a claude.ai/code/session_<id> path opens that Cowork or Claude Code
// session in the app (checked by the owner on the Mac, 2 Oct 2026; it is not documented), so a
// session origin reopens where the task came from, with the request copied since an existing
// session can't be prefilled. Nothing here is verified against the iPhone app, so the phone keeps https.

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

/** The claude:// form of an https claude.ai link (same path and query), or null when there is none. */
export function appLink(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'claude.ai') return null;
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
