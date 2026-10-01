# Handoff: Docket, a voice-first task organiser run through Claude

> Historical: this is the original design hand-off the first build was made from. Tool names and shapes have changed since (for example `toggle_step` is `set_step` and `resolve_move` is `resolve_moves`); `docs/contract.md` is the current reference.

## Overview
Docket is a personal to-do list and planner that the owner controls by talking to Claude on iPhone and Mac. Claude adds, breaks down, estimates, schedules, rebalances and reviews tasks, turns emails into tasks, and writes drafts. Docket also tracks the owner's **weekly Claude usage limit** and keeps the remaining budget for high-priority work.

**Goal of this build:** every Claude action should run inside the owner's own Claude plan (Claude apps on iPhone and Mac, or Claude Code), so it counts against their weekly usage. The prototype in this bundle calls Claude through a separate in-browser helper. Replace that with the architecture below.

## About the design files
The files in `design/` are **design references created in HTML**. They are prototypes that show the intended look and behaviour, not production code to ship. Recreate them in a real stack, as described below.
- `design/Docket.dc.html` is the working prototype: all screens, state and the Claude command loop. Open it in a browser next to `support.js`.
- `design/Docket Mockups.dc.html` holds the design exploration. **2a** is the approved direction; **3a** (Week) and **3b** (Mac Today) are the final static references.

## Fidelity
**High-fidelity.** The colours, type, spacing and copy are final. Match them closely.

---

## Target architecture

```
 Claude on iPhone / Mac / web  ──(custom connector, remote MCP)──┐
 Claude Code / Claude Desktop  ──(MCP, stdio or remote)──────────┤
                                                                 ▼
                                                  docket-server (MCP + HTTP API)
                                                                 │
                                                       SQLite / Postgres
                                                                 ▲
                                    Docket web app (PWA), served by docket-server
```

1. **docket-server** is a small TypeScript service, written with the official MCP SDK (`@modelcontextprotocol/sdk`). It exposes:
   - **Remote MCP** (Streamable HTTP, OAuth or a bearer token). Add it as a custom connector in Claude so it works on iPhone and Mac. Connector availability depends on the plan and platform, so check Anthropic's current documentation.
   - **Local stdio MCP** for Claude Code or Claude Desktop on the Mac. This is optional and uses the same tool set.
   - A **REST/JSON API** for the web UI.
2. **Docket web app (PWA)** is a rebuild of `Docket.dc.html` in React + Vite, or similar. It reads and writes through the REST API, so the phone and Mac show the same data. The app makes **no direct model calls**. Its "Ask Claude" buttons either:
   - copy a ready-made prompt and open the Claude app (a deep link to claude.ai or the iOS app), or
   - add the request to a queue that Claude picks up on the next conversation through `get_pending_requests`.

   Either way, the thinking happens in the owner's Claude session, on their plan.
3. **Gmail and Drive:** do not build them into docket-server. Turn on Claude's own Gmail and Google Drive connectors. Claude reads the email with those, then calls Docket tools: `add_task`, `update_task` with `due`, and `attach_draft`. Claude saves drafts with its Gmail connector, if that connector can create drafts on the owner's plan; otherwise it shows the draft for the owner to copy.
4. **Claude Project:** create a Claude Project called "Docket" with the instructions in `claude-project-instructions.md` and the Docket connector turned on. This gives the same behaviour on every device.

### Usage tracking: be honest about the limits
Apps can't read Claude's weekly usage. Docket stores a **self-reported** `used_pct`. The owner sets it with the slider in the UI, or by telling Claude ("I've used 65%"), which calls `set_usage`. Docket also logs each tool call with a rough cost weight, to estimate usage between updates. Show that estimate as "estimated" in the UI.

---

## MCP tools (docket-server)

All dates are `YYYY-MM-DD`. All durations are in minutes. The ids are short strings.

| Tool | Input | Effect |
|---|---|---|
| `get_overview` | `{ day? }` | Returns today, the week (Monday start), capacity, usage, pending moves and held requests. **Claude calls this first in every conversation.** |
| `list_tasks` | `{ from?, to?, area?, project?, include_done? }` | Lists matching tasks |
| `add_task` | `{ title, area, project?, day?, due?, est, priority, energy, source? }` | Creates a task. `day` defaults to today. |
| `update_task` | `{ id, ...fields }` | Changes fields. Change `day` only when the owner explicitly asks to move a task. |
| `complete_task` / `delete_task` | `{ id }` | Marks the task done, or deletes it |
| `set_steps` | `{ id, steps: string[] }` | Replaces the task's step list |
| `toggle_step` | `{ id, index }` | Marks one step done or not done |
| `propose_moves` | `{ moves: [{ id, to_day, reason }] }` | Adds suggestions that need approval. **Never moves tasks directly.** |
| `resolve_move` | `{ move_id, approve: boolean }` | Called when the owner approves or skips a move, in chat or in the UI |
| `attach_draft` | `{ id, text, gmail_draft_id? }` | Stores a draft on the task |
| `get_usage` / `set_usage` | `{ used_pct }` | Self-reported weekly usage |
| `set_settings` | `{ capacity_hours?, reserve_pct?, high_only? }` | Changes settings |
| `get_pending_requests` | `{}` | Requests queued from the UI. Claude handles them, then calls `complete_request`. |
| `save_review` | `{ week_start, text }` | Stores the weekly review |

**Budget guard (server side):** if `high_only` is on and `100 - used_pct <= reserve_pct`, then `set_steps`, `attach_draft` and `save_review` for tasks below `high` priority return an error such as "Budget at reserve: request held." The server also saves the request to `held_requests`. Claude should pass that on to the owner. The UI's "Run anyway" button releases the held request.

## Data model

```
tasks(id, title, area['Work'|'Personal'|'Health'], project, day, due, est_min,
      priority['high'|'med'|'low'], energy['high'|'low'], done, source['gmail'|null],
      draft, gmail_draft_id, created_at, updated_at)
steps(task_id, idx, text, done)
moves(id, task_id, to_day, reason, status['pending'|'approved'|'skipped'], created_at)
held_requests(id, label, prompt, task_id, created_at, status)
pending_requests(id, prompt, created_at, status)
usage(period_start, used_pct, updated_at, est_calls)
settings(capacity_hours=6, reserve_pct=20, high_only=true, week_start='monday', reset='Mon 09:00')
reviews(week_start, text)
```
The usage period starts on Monday at 09:00, local time. Reset `used_pct` to 0 when a new period begins.

---

## Screens (from `Docket.dc.html`; see mockups 2a, 3a, 3b)

### Layout
- **Wide (≥1000px, Mac):** a 232px sidebar, a main column (content max-width 820px, padding 36/40px), and a 340px Claude panel. The sidebar and the panel are sticky and full height.
- **Narrow (phone):** one column with padding 20/18px and 140px at the bottom. A fixed bottom tab bar holds Today · Week · **mic (72px circle, raised 34px)** · Inbox · Usage. The Claude panel becomes a bottom sheet: 80vh tall, 24px top corners, backdrop rgba(0,0,0,.3). After a command, a toast shows Claude's reply for 6s.

### Today
- Header: the weekday (12px, uppercase, letter-spacing .14em, muted), then the date in Instrument Serif 48px, line-height 1.
- Below it: the area legend (8px squares) and the summary "N tasks · Xh / 6h" on the right.
- Banner (card) when the day is over capacity: "You're 1h 40m over today." with a **Rebalance** button. On a phone, when moves are pending: "N moves suggested." with a **Review** button.
- **Time blocks:** the open tasks, sorted by priority, in a vertical stack with a 5px gap and 14px corners.
  - Tasks of 30m or more are filled with the area colour. Their height is `clamp(48, est*0.7, 130)px`.
  - Tasks under 30m are cards (card background, 1px line border) with a check ring in the area colour.
  - Once the running total passes capacity, insert a dashed accent line with Instrument Serif italic 17px "your 6 hours end here". Every block after it is **hatched**: a 135° stripe of the area colour at 70% and 28% mixed with the background, 6px each.
  - Each block shows a check ring (18px), the title (15/500), and meta (12px, opacity .85: project · energy · "n of m steps"). Pills (2px 8px, 99px radius) show High / Draft ready / Gmail / Due Fri / Suggest Sat. The duration sits on the right (14/500).
  - Tap a block to expand it on a card background. The expanded block shows the steps checklist, the draft (with "Save to Gmail drafts" and "Copy"), and the action pills Break down · Estimate · Draft it · Tomorrow · Priority · Area · Delete.
- Done list: an Instrument Serif 22px heading "Done · n", with struck-through rows.

### Week
- Header: "Week 40", then "28 Sep – 4 Oct" in serif 44px, then the summary "34h planned · 2 days over · Claude 38% left".
- Seven rows: the day label and date, then a 30px bar split by area. The scale is `max(8h, the busiest day)`, with a dashed accent capacity line. The total sits on the right and turns accent when over capacity. Past days are shown at 55% opacity, and the selected day gets a card background.
- Buttons: **Balance my week** (primary) and **Weekly review**. Below them is the selected day's task list.

### Inbox
- Shows the emails Claude found through the Gmail connector. Each row has the sender, subject, snippet and time.
- **Find tasks and deadlines** starts a Claude request. The resulting suggestions appear in a "Claude found" card with Skip / Add.

### Usage
- "38% left" in serif 80px, then "Resets Monday 09:00 · 3 days 15 hours", then a pace line ("At this pace you run out Sunday afternoon").
- A 20×5 grid of 100 cells: used (ink), free (chip), and held for high priority (an outlined accent ring).
- Three cards:
  - Used-so-far slider, with "Updated 2h ago".
  - The "Save for high priority" toggle (48×28) and a 0–50% reserve slider.
  - Free time per day, 2–12h in steps of 0.5.
- "Waiting for budget" list: each held request has Remove / Run anyway.

### Claude panel (Mac) / sheet (phone)
- The reply card shows the "Claude" label with a 7px accent dot, the last command in muted quotes, and the reply.
- The suggested moves card shows "Title → Fri 2 Oct", the reason, and Skip / Move.
- Links for finds and held requests, and a weekly review card.
- Chips: Plan my day · Balance week · Weekly review · Scan Gmail.
- Composer: a 58px ink pill with the input (placeholder "Say or type a command") and a 48px accent mic button. While listening, the mic gets a 6px accent ring at 30%.
- In the real build, voice input on the phone and Mac goes through the Claude apps' own voice dictation. The Web Speech API in the prototype is only a fallback.

## Copy and tone
Claude's replies are brief and direct, at most 1–2 sentences. Approval language: "Move these?", "Skip" / "Move". Use plain words throughout and no emoji.

## Design tokens
| Token | Light | Dark |
|---|---|---|
| bg | #F4F1EA | #161512 |
| card | #FFFDF8 | #211F1B |
| side | #ECE7DC | #1B1A17 |
| ink | #1C1B19 | #EEEAE2 |
| muted | #6B675F | #A39E94 |
| line | #E2DDD2 | #302D29 |
| chip | #DED8CC | #3D3934 |
| accent | #D9481C | #EE6436 |
| accent-soft / accent-ink | #F8DCD0 / #9A2E0C | #3E2319 / #FFB59A |
| work | oklch(0.52 0.08 250), text #F7F4EE | same |
| personal | oklch(0.78 0.1 75), text #1C1B19 | oklch(0.72 0.1 72) |
| health | oklch(0.70 0.08 150), text #141712 | oklch(0.64 0.08 150) |

- The theme follows the system setting (`prefers-color-scheme`).
- **Type:** Instrument Serif (dates, big numbers, section titles) and Geist 400/500/600 (everything else), both from Google Fonts.
- **Radii:** 99px pills · 18px panel cards · 14px big blocks · 12px small blocks · 8–10px nav items and week bars.
- **Shadows:** only on the phone mic (`0 10px 24px rgba(217,72,28,.35)`) and the sheet (`0 -20px 50px rgba(0,0,0,.25)`).

## Assets
None besides an inline mic icon: a 24px viewBox with a rounded rect at 9,3 (6×11, rx 3) and the path `M5 11a7 7 0 0 0 14 0M12 18v3`, stroke 2.

## Build order (suggested)
1. docket-server: the database, the MCP tools above, and the stdio transport. Test it in Claude Code.
2. Add the remote MCP transport with auth. Deploy it (Fly, Railway or Cloudflare) and add it as a Claude custom connector.
3. Create the Claude Project with `claude-project-instructions.md`, and turn on the Gmail and Drive connectors.
4. The PWA UI, recreated from `Docket.dc.html`, on the REST API, with the request queue and deep links.
