# Docket

Docket is a to-do list and planner that you run by talking to Claude on the iPhone and the Mac. Claude adds, breaks down, estimates, schedules and reviews your tasks, turns emails into tasks, writes drafts, and does whole tasks you hand it. Docket also tracks your weekly Claude usage and keeps the last part of it for high-priority work.

**Docket uses your Claude plan, not the API.** The server and the app make no model calls and need no Anthropic API key. All the thinking happens in your own Claude conversations: the Claude apps through a custom connector, or Claude Code through MCP. That counts against your weekly usage limit, so nothing in Docket runs on its own; the app's Claude buttons only queue a request and open Claude with the prompt ready.

```
 Claude on iPhone / Mac / web  ──(custom connector, remote MCP)──┐
 Claude Code on the Mac        ──(MCP, remote)───────────────────┤
                                                                 ▼
                                                  docket-server (MCP + REST API)
                                                                 │
                                                       SQLite on the /data disk
                                                                 ▲
                                    Docket web app (PWA), served by docket-server
```

- `server/` is **docket-server** (TypeScript, the official MCP SDK, `node:sqlite`). It serves remote MCP at `/mcp`, stdio MCP, the REST API with live updates, and the web app.
- `web/` is the **Docket PWA** (React + Vite). Phone and Mac show the same data and update live when Claude changes something.
- `claude-project-instructions.md` is the text for the "Docket" Claude Project.
- `scripts/statusline-docket.sh` syncs your real weekly usage from Claude Code.
- `docs/runbook.md` has the restore drill, token rotation, logs and moving hosts. `docs/contract.md` is the reference for the data model, tools and API. `CLAUDE.md` is for Claude sessions working on the code.

## Your setup (about 10 minutes)

Docket runs at **https://docket-t6dw.onrender.com**. It is a Render Starter web service that was created by hand in the Render dashboard (it is not managed by the `render.yaml` Blueprint). Render builds it with Docker (`docket/Dockerfile`) from the branch `claude/build-from-readme-81ah7g`, keeps the database on a disk mounted at `/data`, and has two environment variables: `TZ=Asia/Kolkata` and `DOCKET_TOKEN`. The Dockerfile sets the rest (`DOCKET_DB=/data/docket.db`, `DOCKET_REQUIRE_DISK=1`, port 8787).

Check that it is up:

```sh
curl https://docket-t6dw.onrender.com/healthz      # {"ok":true,"version":"0.3.0"}
```

### 1. Copy the token and percent-encode it

In the Render dashboard, open the docket service, go to its environment variables and copy `DOCKET_TOKEN`. Treat it like a password.

The token Render generated contains `/` and `=` (and may contain `+`). Inside a URL these must be percent-encoded: `/` becomes `%2F`, `+` becomes `%2B`, `=` becomes `%3D`. On the Mac, with the token on the clipboard, this puts the encoded form on the clipboard (it needs `jq`; `brew install jq` if it is missing):

```sh
pbpaste | jq -Rr @uri | tr -d '\n' | pbcopy
```

Below, `<encoded token>` means this encoded form and `<token>` means the token as Render shows it. If you would rather not deal with encoding, rotate to a hex token (see `docs/runbook.md`).

### 2. Add the connector

In Claude (claude.ai, the Mac app or the iPhone app), go to **Settings → Connectors → Add custom connector**. Name it "Docket" and use this URL:

```
https://docket-t6dw.onrender.com/mcp?token=<encoded token>
```

Use the query form. The path form `/mcp/<token>` only works for tokens without `/`. The connector is tied to your Claude account, so it is available in the apps on both devices.

### 3. Create the Project

In Claude, create a project named "Docket". Paste everything below the line in `claude-project-instructions.md` into its instructions. Make sure the Docket, Gmail and Google Drive connectors are switched on for chats in that project. If Claude lets you set per-tool permissions for Gmail and Drive, leave sending, forwarding and sharing on "needs approval".

### 4. Install the app

On the iPhone, open this link in Safari, then tap **Share → Add to Home Screen**:

```
https://docket-t6dw.onrender.com/#token=<encoded token>
```

The app saves the token and removes it from the address bar. Open the installed app once; if it asks for the token, copy `<token>` and tap **Paste**. On the Mac, open the same link in Safari and choose **File → Add to Dock**. The older `?token=<encoded token>` form also works.

### 5. Point "Open Claude" at the project

In Docket, open **Usage → Open Claude at** and paste the URL of your Docket project from claude.ai. Only `https://claude.ai/...` and `https://claude.com/...` links are accepted.

### 6. On the Mac: the usage sync

Install the status-line script so your real weekly usage reaches Docket whenever you use Claude Code (see [Usage and the status-line sync](#usage-and-the-status-line-sync)). It takes two minutes.

Claude Code may already list Docket among your claude.ai connectors (run `/mcp` in Claude Code to see). If it does not and you want Docket there, add it once:

```sh
claude mcp add --transport http docket https://docket-t6dw.onrender.com/mcp --header "Authorization: Bearer <token>"
```

Keep only one Docket connector in Claude Code; two copies double the tool list in every session.

### 7. Turn on the off-site backup

In GitHub, open the repository's **Settings → Secrets and variables → Actions** and add three repository secrets:

| Secret | Value |
|---|---|
| `DOCKET_URL` | `https://docket-t6dw.onrender.com` (no trailing slash) |
| `DOCKET_TOKEN` | `<token>`, exactly as Render shows it |
| `BACKUP_PASSPHRASE` | a long passphrase you keep in your password manager. Without it the backups cannot be opened. |

GitHub runs scheduled workflows only from the repository's default branch, and the default branch is currently `claude/new-session-0dj488` (the Scrabble solver), which does not have the workflow. In **Settings → General → Default branch**, switch it to `claude/build-from-readme-81ah7g` (that branch already contains the Scrabble solver too). Then open **Actions → Docket backup → Run workflow** once and check that the run is green and has an artifact.

### 8. Check it works

In a chat in the Docket project, say "What's on today?". Claude should call `get_overview` and answer in a sentence or two.

## Using it day to day

**The app.** Today shows your blocks for the day, with a "Carried over" card for unfinished tasks from earlier days (Today, Pick day, Done, Delete, or Move all to today). They don't count toward today's capacity until you move them. Week shows each day's load, with ‹ › to move between weeks and a "Later" list for anything after the visible week. Both have a search box. Inbox shows the emails Claude read and the tasks it suggested from them. Usage shows your budget. Buttons that use Claude have a small dot. Everything else (done, steps, editing, approving moves) is free.

**Adding tasks without Claude.** Use "Add a task" at the end of Today or under a day in Week. In the composer, start with `+` to add without Claude, for example `+Groceries 45m personal tomorrow low`; it understands durations (`30m`, `1h`), the areas, today, tomorrow, weekday names, and "high" or "low". Open a block and tap **Edit** to change its title, estimate, day, due date, priority, area, energy, project, notes or link.

**Asking Claude.** Talk to Claude in the Docket project ("add call the bank, 15 minutes, Friday, high"), or use the buttons (Plan my day, Balance my week, Break down, Draft, Scan Gmail, Weekly review) and the composer. A button doesn't spend anything by itself:

1. It queues a request. You see "Ready for Claude: …" with an **Open Claude** action, and a "n waiting" chip on Today.
2. **Open Claude** opens Claude at your project link with the prompt. On the web the prompt is filled in; on the iPhone it is also copied, so paste it if it isn't.
3. Claude sees the queued requests in `get_overview`, does them, and calls `complete_request`. The reply shows in the "Done by Claude" card, and the app tells you when Claude finished something.

You can queue several requests and open Claude once; one chat handles all of them.

**Giving a task to Claude.** Open a block and tap **Give to Claude**, then type one line ("reply to Asha saying Thursday works"). Claude does it with Gmail, Drive or the web, puts the result on the task, and replies. The block shows "With Claude" while it waits, a **Result** card when Claude is done (Copy, Mark done, Clear), or "Claude replied" with what it needs if it couldn't finish.

**Planning the week.** On Week, write what you want this week in the "This week" card, then tap **Plan my week from this**. Claude adds the missing tasks and proposes moves for the existing ones. Claude never moves a task by itself: you approve each move, or use Move all / Skip all.

**Weekly review.** On Monday or Tuesday, if last week has no review, Docket offers one. Claude writes a short review (what got done, what slipped, what to focus on) and saves it.

**Keeping usage low.**
- Add simple tasks by hand or with `+`; tick things off in the app.
- Batch requests and open Claude once, rather than one chat per request.
- Long chats cost more per message. Start a new Docket chat each day.
- Keep "Save for high priority" on (below).

## The budget guard

Two settings on the Usage screen control it: **Save for high priority** (`high_only`, on by default) and **Keep back** (`reserve_pct`, 20% by default).

- You are **at your reserve** when Save for high priority is on and `100 − used_pct ≤ reserve_pct`, where `used_pct` is the last figure you, Claude or the status line reported. The estimate never triggers it.
- You are **near your reserve** when the estimate (below) says you would be. The Usage screen then asks you to check claude.ai/settings/usage and update the figure.
- At the reserve, Claude does high-priority work as usual. Below-high breakdowns, drafts and reviews wait: Claude calls `hold_request` instead of doing them, and says the request is waiting under Usage.
- Tools never throw away content Claude already wrote. If a below-high breakdown, draft, result or review arrives at the reserve anyway, it is saved and the reply carries a note telling Claude to stop doing more of them in that chat.
- A request you queue from the app below high priority at the reserve is held instead of queued. A request queued before you hit the reserve doesn't slip through either: when Claude reads the overview or fetches the queue, Docket moves anything below high that you didn't approve to the held list and tells Claude how many (`held_now`).
- **Run anyway** on a held request queues it with your approval (`budget_override`); Claude then does it even at the reserve. When your weekly limit resets and requests are waiting, Docket shows "Your budget reset. N requests were waiting" with **Queue all**. Held requests are never queued automatically.

The app sets request priorities like this: Plan my day, Balance my week and anything typed in the composer are high; Scan Gmail and Weekly review are med; Break down, Estimate, Draft and Give to Claude use the task's own priority.

## Usage and the status-line sync

Apps cannot read your Claude usage, so Docket keeps a reported figure and an estimate:

- **Reported:** what you set with the slider, what you tell Claude ("I've used 65%", which calls `set_usage`), or what the status-line script sends. The Usage screen's headline is `100 − used_pct`, with how long ago it was reported, and "synced from Claude Code" when the script sent it.
- **Estimated:** between reports, Docket counts its own tool calls with a rough weight each and shows "about N% now, estimated from Docket calls". A new report adjusts the per-call rate a little, but only when the previous report is under 3 days old, enough calls happened in between and the figure went up.
- **Reset time:** once the status line has reported, Docket uses your real weekly reset moment from Claude Code and rolls it forward by whole weeks. Until then it uses the `reset` setting, Monday 09:00 local time by default. The overview and the app show it as, for example, "Mon 5 Oct 09:00".

On the Mac, Claude Code's status line receives your real weekly figure (`rate_limits.seven_day`), which is the same limit as claude.ai/settings/usage. `scripts/statusline-docket.sh` prints a status line (`Opus | ctx 8% | 7d: 41%`) and, when the rounded figure changes, sends it to Docket in the background with a 5-second timeout, so it never slows Claude Code down. Claude Code only provides `rate_limits` for Pro and Max subscribers, and only after the first response in a session.

To install it:

```sh
cp docket/scripts/statusline-docket.sh ~/.claude/statusline-docket.sh
chmod +x ~/.claude/statusline-docket.sh
# with <token> (not encoded) on the clipboard:
( umask 077; printf 'DOCKET_URL=https://docket-t6dw.onrender.com\nDOCKET_TOKEN=%s\n' "$(pbpaste)" > ~/.claude/docket.env )
chmod 600 ~/.claude/docket.env
```

Then add this to `~/.claude/settings.json` (keep whatever else is in the file):

```json
{
  "statusLine": { "type": "command", "command": "~/.claude/statusline-docket.sh" }
}
```

The script reads `model.display_name`, `context_window.used_percentage` and `rate_limits.seven_day.used_percentage` / `resets_at` from the JSON Claude Code sends, and keeps the last value it sent in `~/.claude/docket-statusline.last`. If a send fails, it retries on the next update and writes the HTTP status (or `000` for no answer) to `~/.claude/docket-statusline.err`. It needs `curl` and either `jq` or `node`.

On iPhone-only days, update the slider from claude.ai/settings/usage now and then.

## Backups and restore

Besides the live database, your data is copied in three ways:

1. **Hourly snapshots on the disk**, in `/data/backups` (`docket-YYYYMMDD-HHMMSS-hourly.db`, local time). Docket takes one at boot if the last is over an hour old, then every hour. It keeps every snapshot from the last 48 hours, then one per day for 30 days. It also takes a `pre-migration` snapshot before upgrading the schema and a `pre-reset` one before a sample-data reset; those are kept for 30 days. These protect against mistakes, but they live on the same disk as the database.
2. **A nightly off-site copy** from the GitHub Actions workflow `.github/workflows/docket-backup.yml`. Every night at 03:00 IST, and whenever you run it by hand, it downloads `/api/backup` (the database file) and `/api/export.json` (every table as JSON), checks that the database opens, packs both into `docket-YYYYMMDD-HHMM.tgz`, encrypts it with your `BACKUP_PASSPHRASE` and keeps it as a workflow artifact for 90 days. It needs the three secrets and the default-branch change from setup step 7.
3. **Any time by hand**, from the Mac:

```sh
curl --fail -H "Authorization: Bearer <token>" https://docket-t6dw.onrender.com/api/backup -o docket.db
curl --fail -H "Authorization: Bearer <token>" https://docket-t6dw.onrender.com/api/export.json -o docket-export.json
```

**Opening an off-site backup.** In GitHub, open **Actions → Docket backup**, pick a run and download its artifact (a zip containing `docket-….tgz.gpg`); unzip it. Then, with GnuPG installed (`brew install gnupg`):

```sh
read -rs BACKUP_PASSPHRASE        # type the passphrase, then Enter
gpg --batch --passphrase "$BACKUP_PASSPHRASE" -o docket.tgz -d docket-20261001-2130.tgz.gpg
tar xzf docket.tgz                # gives docket.db and docket-export.json
sqlite3 docket.db "PRAGMA integrity_check; SELECT 'tasks: ' || COUNT(*) FROM tasks;"
```

**Restoring.** Docket restores at boot: set `DOCKET_RESTORE_FROM` to the path of a snapshot on the disk and let the service restart. Docket checks the snapshot, moves the current database aside (it never deletes it), copies the snapshot in, upgrades its schema if needed and logs `restored … (N tasks)`. It restores a given path only once, so a forgotten variable is harmless, but unset it afterwards. The snapshot is either one of the hourly ones in `/data/backups` or a file you copy onto the disk from an off-site backup. The full steps, including getting a file onto the Render disk, are in `docs/runbook.md`.

**Do the drill once now**, while nothing is wrong: take a backup, restore it, check the app (`docs/runbook.md`, "Restore drill"). It takes about 15 minutes and proves that the backups open.

## Updating Docket

1. Change the code, then from `docket/` run `npm test`, `npm run typecheck` and `npm run build`.
2. Push to `claude/build-from-readme-81ah7g`. Render builds the Docker image and deploys it (if auto-deploy is on for the service; otherwise start a deploy in the Render dashboard). Do not change the branch Render deploys from.
3. Expect a short gap while the old instance stops and the new one starts; a service with a disk runs one instance at a time.
4. The data survives: it lives on the `/data` disk, not in the image. On boot, Docket applies any new schema migrations (they only add columns and tables) after taking a `pre-migration` snapshot.
5. Check `https://docket-t6dw.onrender.com/healthz` shows the new version (Claude's `get_usage` also returns `docket_version`), and look for `opened existing database (N tasks, …)` in the Render logs.

Rolling back: an older build refuses to open a database that a newer build has migrated ("newer than this build"). To go back across a migration, deploy the older commit and restore the `pre-migration` snapshot with `DOCKET_RESTORE_FROM`; anything written after the upgrade is then lost.

Because the service was created by hand, `render.yaml` does not change it. If you want its build filter (only rebuild for changes under `docket/`) or its health check (`/healthz`), set them on the service in the Render dashboard. `render.yaml` is for creating a new service from the Blueprint ([Deploy to Render](https://render.com/deploy?repo=https://github.com/varun-129999/test/tree/claude/build-from-readme-81ah7g)); see "Moving hosts" in `docs/runbook.md` first, because a new service starts with an empty disk.

## MCP tools

All dates are `YYYY-MM-DD` and all durations are minutes. Enum fields accept the obvious spellings ("medium", "work") and normalise them.

| Tool | Input | What it does |
|---|---|---|
| `get_overview` | `{ day? }` | Today, the week with per-day load and the tasks for today onwards, overdue tasks, usage and the reserve state, pending moves, held requests, and up to 5 queued requests. Claude calls it once per conversation. At the reserve it also moves queued below-high requests you didn't approve to the held list and reports `held_now`. |
| `list_tasks` | `{ from?, to?, area?, project?, q?, ids?, include_done?, limit?, detail? }` | Finds tasks; returns `{ total, returned, truncated, tasks }`. `limit` defaults to 30. `detail: "compact"` (default) gives each task's `day` and flags such as `steps: "1/4"`, `has_notes`, `has_draft`, `has_result` and `done`; `"full"` adds the steps, notes, draft and result themselves. |
| `add_task` | `{ title, area, est, priority, energy, day?, due?, project?, source?, notes?, link? }` | Creates a task. `day` defaults to today. |
| `add_tasks` | `{ tasks: [...] }` | Creates up to 25 tasks; returns what was added and the open minutes of each affected day. |
| `update_task` | `{ id, ...fields }` | Changes fields, including `done`. `null` clears `project`, `due`, `notes`, `link` or `result`. |
| `update_tasks` | `{ ids, set }` | Applies the same change to up to 50 tasks; returns the old values. |
| `complete_task` | `{ id }` | Marks a task done. |
| `delete_task` | `{ id }` | Deletes a task. |
| `set_steps` | `{ id, steps }` | Replaces the steps. A step whose text is unchanged keeps its done state. |
| `add_steps` | `{ id, steps, at? }` | Adds steps at the end, or at position `at`. |
| `set_step` | `{ id, index, done }` | Ticks or unticks one step (0-based). |
| `propose_moves` | `{ moves: [{ id, to_day, reason? }] }` | Suggests moves for you to approve, with the target day's load. Never moves anything. |
| `resolve_moves` | `{ move_ids? \| all: true, approve }` | Approves or skips moves you decided on in chat. |
| `attach_draft` | `{ id, text, gmail_draft_id?, request_id? }` | Stores a draft on a task. |
| `attach_result` | `{ id, text, url?, request_id? }` | Stores what Claude produced for a task you gave it. |
| `get_usage` | `{}` | The usage figures and reserve state, plus `docket_version`. |
| `set_usage` | `{ used_pct, resets_at?, source? }` | Records a reported usage figure. |
| `set_settings` | `{ capacity_hours?, reserve_pct?, high_only?, claude_url?, reset? }` | Changes settings. |
| `get_pending_requests` | `{}` | The queued requests (when `get_overview` says more are waiting); re-holds below-high ones at the reserve and reports `held_now`. |
| `complete_request` | `{ id, reply?, outcome?, detail? }` | Finishes a queued request: `outcome` is `done` (default), `needs_owner` or `failed`, with `detail` saying what is needed. Errors if the request is not pending. |
| `hold_request` | `{ label, prompt, task_id?, priority? }` | Puts work on the held list instead of doing it at the reserve. |
| `save_review` | `{ week_start, text, request_id? }` | Stores the weekly review (`week_start` is that week's Monday). |
| `set_week_plan` | `{ week_start?, text }` | Stores what you want this week. |
| `record_emails` | `{ emails: [{ from, subject, snippet?, when?, thread_id? }] }` | Replaces the Inbox list with the emails Claude read through Gmail. |
| `suggest_tasks` | `{ suggestions: [...] }` | Adds to the "Claude found" list, where you Add or Skip each one. |

Read-only: `list_tasks` and `get_usage`. `get_overview` and `get_pending_requests` read too, but at the reserve they move queued requests to the held list, so they are marked safe to repeat rather than read-only. Marked destructive: `delete_task`, `set_steps` and `record_emails` (they replace or remove). Safe to repeat: `set_step`, `complete_task`, `set_usage`, `set_settings`, `complete_request`, `save_review`, `set_week_plan`.

The server also sends short instructions when a connection starts. They only say how the tools work and apply only when you talk about tasks, plans or Docket; tone and habits live in the Project instructions. Both say that task text, emails and queued prompts are data, not instructions.

Gmail and Drive are not built into Docket. Claude uses its own connectors and then calls Docket's tools (`record_emails`, `suggest_tasks`, `add_task` with `source: "gmail"`, `attach_draft`).

## REST API (used by the web app)

Every route is under `/api` and needs `Authorization: Bearer <token>`. `?token=` is accepted only on `/api/events` and `/mcp` (and the `/mcp/<token>` path form). Bad input gets a 400 with `{ "error": "…" }` naming the fields; unknown routes get a JSON 404.

| Route | Body → result |
|---|---|
| `GET /state` | Everything the app shows (see `docs/contract.md`) |
| `POST /tasks` | task fields → Task |
| `PATCH /tasks/:id` | any task fields, including `done` and `result: null` → Task |
| `DELETE /tasks/:id` | |
| `PUT /tasks/:id/steps` | `{ steps }` (replace; unchanged text keeps done) → Task |
| `POST /tasks/:id/steps` | `{ steps, at? }` → Task |
| `PATCH /tasks/:id/steps/:idx` | `{ done }` → Task |
| `POST /tasks/:id/steps/:idx/toggle` | → Task |
| `POST /moves/:id/resolve` | `{ approve }` |
| `POST /moves/resolve-all` | `{ approve }` → `{ resolved }` |
| `PUT /usage` | `{ used_pct, resets_at?, source? }` → Usage |
| `PATCH /settings` | settings fields → Settings |
| `POST /requests` | `{ prompt, label?, priority?, task_id? }` → `{ status: "pending", request, existing? }` or `{ status: "held", held }` |
| `DELETE /requests/:id` | |
| `POST /requests/seen` | `{ ids? }` (all when omitted) |
| `POST /held/:id/run` | → `{ applied, request? }` |
| `DELETE /held/:id` | |
| `POST /held/queue-all` | → `{ queued }` |
| `POST /reset-notice/dismiss` | |
| `PUT /week-plan` | `{ week_start?, text }` → WeekPlan |
| `DELETE /week-plan/:week` | |
| `POST /finds/:id/add` | → Task |
| `POST /finds/:id/skip` | |
| `POST /reviews/:week/dismiss` | |
| `POST /sample` | `{ "confirm": "wipe" }`; only when the server runs with `DOCKET_SAMPLE=1` |
| `GET /backup` | the database file (a consistent snapshot) |
| `GET /export.json` | every table as JSON |
| `GET /events` | server-sent events: `change` after any write |

`GET /healthz` (outside `/api`, no token) returns `{ ok, version }` and fails with 503 if the database doesn't answer.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DOCKET_TOKEN` | none | Shared secret for the API and remote MCP. Required to listen on anything but localhost. A new one: `openssl rand -hex 32`. |
| `TZ` | system | Your IANA time zone (`Asia/Kolkata`). "Today", the Monday-start week and the default reset use it. Docket refuses to start on an invalid or unapplied value such as `IST`. |
| `DOCKET_DB` | `server/data/docket.db` (Docker: `/data/docket.db`) | The SQLite file. |
| `DOCKET_BACKUP_DIR` | `backups/` next to the database | Where hourly snapshots go. |
| `DOCKET_REQUIRE_DISK` | off (Docker: `1`) | `1` refuses to start unless the database folder is a mounted disk, so data never lands on the container's own filesystem. |
| `DOCKET_RESTORE_FROM` | none | Path of a snapshot to restore at boot, once. Unset it afterwards. |
| `DOCKET_SAMPLE` | off | `1` loads the sample data into an empty database and allows the sample reset. Never set it on the live service. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` (`0.0.0.0` with a token) | Listen address. |
| `WEB_DIR` | `web/dist` | The built web app. |

## Running it locally

Needs Node 22.13 or later; Docket uses the built-in `node:sqlite`.

```sh
cd docket
npm install
npm run build                 # builds web/dist and server/dist
DOCKET_SAMPLE=1 npm start     # http://localhost:8787 with sample data on first run
npm test                      # server tests
npm run typecheck
```

Without `DOCKET_TOKEN` the server listens on 127.0.0.1 only and accepts only local `Host` headers. For development, run `npm run dev` (server with reload) and `npm run dev:web` (Vite on :5173, which proxies `/api`).

A local stdio MCP server for Claude Code uses a local database file, not the live service, so use it only for development:

```sh
claude mcp add docket-dev -- node --disable-warning=ExperimentalWarning /path/to/docket/server/dist/stdio.js
```

Docker, anywhere with a persistent disk (from `docket/`):

```sh
docker build -t docket .
docker run -p 8787:8787 -v docket-data:/data -e DOCKET_TOKEN=$(openssl rand -hex 32) -e TZ=Asia/Kolkata docket
```

## If something goes wrong

| What you see | What to do |
|---|---|
| Claude says it can't reach Docket, or the connector shows an error | Run `curl https://docket-t6dw.onrender.com/healthz`. If that fails, the service is down: look at the Render logs. If it works, test the token: `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <token>" https://docket-t6dw.onrender.com/api/state` should print `200`. If it does, the connector URL is wrong: rebuild it with the encoded token in the query form (setup steps 1 and 2). |
| The app says "That token didn't work" | Open the `#token=` link again, or paste the token on the sign-in card. After a token rotation, every device needs this once. |
| The app shows "Offline, showing data from …" | The server didn't answer; the app retries when you come back to it. Check `/healthz`. |
| The app is suddenly empty, or the logs say `CREATED NEW EMPTY DATABASE` after a deploy | Stop and don't add tasks. The disk isn't where Docket expects it. Check in the Render dashboard that the disk is attached at `/data`, then restore (`docs/runbook.md`). |
| A deploy fails with `DOCKET_REQUIRE_DISK=1 but /data …` | The disk isn't mounted at `/data`. Attach it there; nothing was written. |
| A deploy fails with `TZ="…" is not a valid IANA time zone name` or `is not applied` | Set `TZ` to exactly `Asia/Kolkata`. |
| A deploy fails with `schema version N, newer than this build` | You deployed an older commit after an upgrade. Deploy the newer one, or see "Rolling back" above. |
| "Today" changes at 05:30, or the week starts on Sunday evening | `TZ` isn't applied. The boot log should say `TZ Asia/Kolkata (…)`; the name in brackets may read `Asia/Calcutta`, which is the same zone. |
| The usage figure looks wrong | Check claude.ai/settings/usage and set the slider. On the Mac, check that the status line shows `7d: N%` and look at `~/.claude/docket-statusline.err`. |
| Requests keep being held | You are at your reserve. Use Run anyway for the ones you want, lower Keep back, or turn off Save for high priority. After the weekly reset, use Queue all. |
| A queued request never gets done | Nothing runs until you open Claude. Open the Docket project and say "Do my Docket requests". |
| Docket's tools appear twice in Claude Code | Remove one: `claude mcp list`, then `claude mcp remove docket`. |
| The backup workflow is red or never runs | Check the three secrets and that the default branch has the workflow (setup step 7). The run log says which step failed. |
| You deleted or changed something by mistake | For one task, open a backup and look it up: `sqlite3 docket.db "SELECT title, day, est_min, area, priority FROM tasks WHERE title LIKE '%word%';"`, then add it back by hand. For a bigger mess, restore the last good snapshot (`docs/runbook.md`); everything after it is rolled back. |

## Limits

- Auth is one shared token, and the claude.ai connector carries it in its URL. There is no OAuth. Rotate the token if the URL leaks (`docs/runbook.md`).
- Nothing runs in the background. Claude works only in a chat you open, so queued requests wait until then.
- The usage figure is real only when the status line syncs it (the Mac, Claude Code, Pro or Max, after the first response in a session). Otherwise it is what you report, plus an estimate that only sees Docket's own tool calls.
- Opening Claude with the prompt filled in works on the web. On the iPhone the prompt is also copied, in case the app doesn't fill it in.
- Gmail and Drive go through Claude's own connectors; what they can do (for example creating drafts) depends on your plan.
- SQLite on one disk means one instance. Deploys have a short gap.
- `export.json` is for reading or for moving to another tool; there is no importer. Restores use the `.db` snapshot.
- Off-site backups are kept for 90 days. The hourly snapshots live on the same disk as the database.
