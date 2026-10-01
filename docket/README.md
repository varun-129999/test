# Docket

A voice-first to-do list and planner that you run by talking to Claude on iPhone and Mac. Claude adds, breaks down, estimates, schedules and reviews your tasks, turns emails into tasks, and writes drafts. Docket also tracks your weekly Claude usage and keeps the last part of it for high-priority work.

**Docket uses your Claude plan, not the API.** The server and the app make no model calls and need no Anthropic API key. All the thinking happens in your own Claude conversations (the Claude apps through a custom connector, or Claude Code and Claude Desktop through MCP), so it counts against your weekly usage limit. The app's "Ask Claude" buttons only queue the request, then open Claude with the prompt ready.

```
 Claude on iPhone / Mac / web  ──(custom connector, remote MCP)──┐
 Claude Code / Claude Desktop  ──(MCP, stdio or remote)──────────┤
                                                                 ▼
                                                  docket-server (MCP + HTTP API)
                                                                 │
                                                              SQLite
                                                                 ▲
                                    Docket web app (PWA), served by docket-server
```

- `server/` is **docket-server**, a TypeScript service built on the official MCP SDK. It serves remote MCP (Streamable HTTP), stdio MCP, a REST/JSON API with live updates (server-sent events), and the web app.
- `web/` is the **Docket PWA** in React + Vite, rebuilt from the design handoff in `design-handoff/`. It reads and writes through the REST API, so your phone and your Mac show the same data, and it updates live when Claude changes something.
- `claude-project-instructions.md` holds the instructions for the "Docket" Claude Project.

## Set up in about 10 minutes

1. **Deploy.** Open [Deploy to Render](https://render.com/deploy?repo=https://github.com/varun-129999/test/tree/claude/build-from-readme-81ah7g) and sign in with GitHub. Enter your time zone for `TZ` (for example `Europe/London`), then click **Apply**. The Blueprint (`render.yaml` at the repo root) creates the service, a 1 GB disk and a random `DOCKET_TOKEN`. The disk needs a paid "Starter" instance. Once this branch is merged, drop the `/tree/...` part of the link.
2. **Get your token.** In Render, open the docket service, then **Environment**, and copy `DOCKET_TOKEN`. Your address is the `https://docket-xxxx.onrender.com` URL at the top of the page.
3. **Add the connector.** In Claude, go to **Settings → Connectors → Add custom connector**. Name it "Docket", with the URL `https://<your-address>/mcp/<DOCKET_TOKEN>`.
4. **Create the Project.** In Claude, choose **Projects → New project** and name it "Docket". Paste everything below the line in `claude-project-instructions.md` into the project instructions. In the project, turn on Docket, Gmail and Google Drive.
5. **Install the app.** On your iPhone, open `https://<your-address>/?token=<DOCKET_TOKEN>` in Safari, then tap **Share → Add to Home Screen**. Do the same on your Mac (Safari: **File → Add to Dock**).
6. **Point "Open Claude" at the project.** In Docket, go to **Usage → Open Claude at** and paste the URL of your Docket project from claude.ai.
7. **Check it works.** In the Docket project, say "What's on today?". Claude should call `get_overview`.

## Quick start (local)

Needs Node 22.13 or later. Docket uses the built-in `node:sqlite`, so there are no native modules to build.

```sh
cd docket
npm install
npm run build                 # builds web/dist and server/dist
DOCKET_SAMPLE=1 npm start     # http://localhost:8787 with sample data on first run
```

Without `DOCKET_TOKEN`, the server listens on 127.0.0.1 only and accepts only local `Host` headers. For development, run `npm run dev` (server with reload) and `npm run dev:web` (Vite on :5173, which proxies `/api`).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DOCKET_TOKEN` | *(none)* | Shared secret for the API and remote MCP. **Required** to listen on anything other than localhost. Generate one with `openssl rand -hex 32`. |
| `DOCKET_DB` | `server/data/docket.db` | SQLite file. The HTTP and stdio servers can share it. |
| `PORT` / `HOST` | `8787` / `127.0.0.1` (or `0.0.0.0` with a token) | Listen address |
| `TZ` | system | Your time zone. "Today", the Monday-start week and the Monday 09:00 usage reset all use it. |
| `DOCKET_SAMPLE` | off | `1` loads the sample data from the design into an empty database |
| `WEB_DIR` | `web/dist` | Built web app to serve |

## Connect Claude

The connector features depend on your plan and platform, and they change, so check Anthropic's current documentation for the exact steps.

### Claude apps (iPhone, Mac, web): custom connector

1. Deploy docket-server at a public HTTPS URL (see [Deploy](#deploy)) with a `DOCKET_TOKEN`.
2. In Claude, go to **Settings → Connectors → Add custom connector** and enter `https://<your-host>/mcp/<DOCKET_TOKEN>`. The custom-connector form only takes a URL, so the token goes in the path. `?token=` works too. Treat this URL like a password.
3. Create a **Claude Project** called "Docket". Paste `claude-project-instructions.md` into its instructions, and turn on the Docket connector plus Claude's own **Gmail** and **Google Drive** connectors.
4. Open `https://<your-host>/?token=<DOCKET_TOKEN>` once on each device to save the token, then use **Add to Home Screen** on iPhone. You can also enter the token on the sign-in screen.
5. On the app's Usage screen, paste your Docket project's link into **Open Claude at**, so that "Open Claude" starts in the project.

Voice: use the dictation in the Claude apps. The app's mic button uses the browser's speech recognition as a fallback, where the browser supports it.

### Claude Code

```sh
# local, stdio (same database as the HTTP server)
claude mcp add docket -- node --disable-warning=ExperimentalWarning /path/to/docket/server/dist/stdio.js

# or remote
claude mcp add --transport http docket https://<your-host>/mcp --header "Authorization: Bearer <DOCKET_TOKEN>"
```

### Claude Desktop

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "docket": {
      "command": "node",
      "args": ["--disable-warning=ExperimentalWarning", "/path/to/docket/server/dist/stdio.js"],
      "env": { "DOCKET_DB": "/path/to/docket/server/data/docket.db", "TZ": "Europe/London" }
    }
  }
}
```

The server also sends short instructions when the MCP connection starts (the `instructions` field), so Claude follows the basics even outside the Project.

## How the "Ask Claude" buttons work

Buttons such as Plan my day, Balance my week, Break down, Draft it and Scan Gmail, and anything typed in the composer, go through this flow:

1. The app calls `POST /api/requests`. The request lands in `pending_requests`. If it's below high priority and you're at your reserve, it lands in `held_requests` instead.
2. The Claude panel lists what's waiting, with **Open Claude** and **Copy prompt**. Open Claude opens `https://claude.ai/new?q=…` (or your project link) with the prompt filled in. Copy prompt is for the iOS app, or anywhere a link can't fill in the prompt.
3. In that conversation, Claude calls `get_pending_requests` (the Project instructions tell it to), does the work with Docket's tools, and calls `complete_request`. The reply appears in the panel, and as a toast on the phone.

You can also skip the buttons and just talk to Claude in the Docket project, for example "add groceries for 45 minutes tonight, low energy".

## MCP tools

All dates are `YYYY-MM-DD` and all durations are in minutes.

| Tool | Input | Effect |
|---|---|---|
| `get_overview` | `{ day? }` | Today, the week (Monday start) with per-day load, capacity, usage and budget state, pending moves, held requests, overdue tasks. Call it first. |
| `list_tasks` | `{ from?, to?, area?, project?, include_done? }` | Matching tasks, with their steps and drafts |
| `add_task` | `{ title, area, project?, day?, due?, est, priority, energy, source? }` | Creates a task. `day` defaults to today. |
| `update_task` | `{ id, ...fields }` | Changes fields, including `done`. `null` clears `project` or `due`. |
| `complete_task` / `delete_task` | `{ id }` | Marks the task done, or deletes it |
| `set_steps` | `{ id, steps, request_id? }` | Replaces the steps. Guarded. |
| `toggle_step` | `{ id, index }` | Flips one step (0-based) |
| `propose_moves` | `{ moves: [{ id, to_day, reason }] }` | Suggestions for you to approve. Never moves tasks itself. |
| `resolve_move` | `{ move_id, approve }` | Approves or skips a move |
| `attach_draft` | `{ id, text, gmail_draft_id?, request_id? }` | Stores a draft. Guarded when the text is new. |
| `get_usage` / `set_usage` | `{ used_pct }` | Self-reported weekly usage |
| `set_settings` | `{ capacity_hours?, reserve_pct?, high_only? }` | Changes settings |
| `get_pending_requests` / `complete_request` | `{}` / `{ id, reply? }` | The queue from the app |
| `save_review` | `{ week_start, text, request_id? }` | Stores the weekly review. Guarded. |
| `record_emails` | `{ emails: [{ from, subject, snippet?, when? }] }` | Fills the Inbox screen with what Claude read through Gmail |
| `suggest_tasks` | `{ suggestions: [...] }` | The "Claude found" list, where you Add or Skip each suggestion |

`complete_request`, `record_emails` and `suggest_tasks` are additions to the handoff's tool list. The Inbox screen and the request queue need them.

**Budget guard.** When "Save for high priority" is on and `100 − used_pct ≤ reserve_pct`, `set_steps`, `attach_draft` (with new text) and `save_review` for anything below high priority return the error `Budget at reserve: request held…`. The server saves the request to `held_requests`, together with the content Claude already wrote. **Run anyway** on the Usage screen applies that saved content right away, with no second Claude call. Requests held from the app have no content yet, so Run anyway queues them again with a budget override, and Claude passes `request_id` to get past the guard.

**Usage tracking is self-reported.** Apps can't read Claude's real usage. You set `used_pct` with the slider, or by telling Claude ("I've used 65%"), which calls `set_usage`. Between updates, Docket logs each tool call with a rough cost weight and shows an **estimated** figure. Each time you report a new number, Docket adjusts its per-call rate. The guard uses only the figure you reported. `used_pct` resets to 0 when a new period starts (Monday 09:00 by default).

**Gmail and Drive** are not built into Docket. Claude reads email with its own connectors, then calls Docket's tools. "Save to Gmail drafts" asks Claude to save the draft with the Gmail connector, if that connector can create drafts on your plan, and then to record the draft id with `attach_draft`.

## REST API (used by the web app)

All routes need `Authorization: Bearer <token>` when a token is set. `GET /api/events` also accepts `?token=`.

`GET /api/state` · `GET /api/overview` · `POST /api/tasks` · `PATCH|DELETE /api/tasks/:id` · `POST /api/tasks/:id/steps/:idx/toggle` · `POST /api/moves/:id/resolve {approve}` · `PUT /api/usage {used_pct}` · `PATCH /api/settings` · `POST /api/requests {prompt,label,priority,task_id}` · `DELETE /api/requests/:id` · `POST /api/held/:id/run` · `DELETE /api/held/:id` · `POST /api/finds/:id/add|skip` · `POST /api/reviews/:week/dismiss` · `POST /api/sample` · `GET /api/events` (SSE)

## Deploy

The `Dockerfile` builds both parts and runs the server on port 8787, with the database in `/data`. Mount a volume there, and set `DOCKET_TOKEN` and `TZ`.

```sh
docker build -t docket .
docker run -p 8787:8787 -v docket-data:/data -e DOCKET_TOKEN=$(openssl rand -hex 32) -e TZ=Europe/London docket
```

For Render, use the Blueprint in `render.yaml` (see [Set up](#set-up-in-about-10-minutes)). The unauthenticated `GET /healthz` is the health check. For Fly.io, see `fly.toml`: create a volume, set the token as a secret, then `fly deploy`. Any host that runs a container with a persistent disk works, such as Railway or Render. The app needs a single instance, because SQLite lives on one disk.

## Tests

```sh
npm test          # server: store, budget guard, MCP over in-memory and HTTP transports, REST auth
npm run typecheck
```

## Limits and next steps

- Auth is one shared token. There's no OAuth flow yet, so the claude.ai connector carries the token in its URL. Use HTTPS, and rotate the token if the URL leaks.
- `claude.ai/new?q=` fills in the prompt on the web. Whether a link opens the iOS app with the prompt filled in depends on the app, which is why Copy prompt exists.
- The usage figure is only as good as what you report. The estimate only sees Docket's own tool calls.
