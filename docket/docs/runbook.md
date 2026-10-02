# Docket runbook

For the live service at https://docket-t6dw.onrender.com: a Render Starter web service created by hand, built with Docker from the branch `claude/build-from-readme-81ah7g`, with its disk at `/data` (database `/data/docket.db`, snapshots `/data/backups`) and the environment variables `TZ=Asia/Kolkata` and `DOCKET_TOKEN`.

Render's documentation could not be checked while this was written, so Render steps say what to do rather than exact menu names. Where something is uncertain, it says so.

What you need on the Mac: access to the Render dashboard and to the GitHub repository (`varun-129999/test`), your `BACKUP_PASSPHRASE`, GnuPG (`brew install gnupg`), and optionally the GitHub CLI (`brew install gh`). `sqlite3`, `curl` and `openssl` come with macOS.

## Restore drill

Do this once now, and again after any big change to the deploy. It proves that an off-site backup opens and that you can put it back. Done as below you lose nothing: you restore a backup taken a minute earlier and don't use Docket in between. It takes about 15 minutes.

### 1. Take a fresh off-site backup

In GitHub, open **Actions → Docket backup → Run workflow** and wait for the run to go green (about a minute). From now until step 7, don't change anything in Docket.

The workflow only appears there if it is on the repository's default branch (README, setup step 7).

### 2. Download it

In the run's page, download the artifact under "Artifacts". It arrives as a zip; unzip it to get `docket-YYYYMMDD-HHMM.tgz.gpg` (the time is UTC). Or with the GitHub CLI:

```sh
gh run list --workflow docket-backup.yml --limit 3 -R varun-129999/test
gh run download <run-id> -R varun-129999/test -D ~/docket-restore
```

Either way, put the `.tgz.gpg` file in `~/docket-restore` (the CLI may put it in a folder inside it named after the artifact).

### 3. Decrypt and check it

```sh
cd ~/docket-restore
read -rs BACKUP_PASSPHRASE        # type the passphrase, then Enter
gpg --batch --passphrase "$BACKUP_PASSPHRASE" -o docket.tgz -d docket-*.tgz.gpg
tar xzf docket.tgz                # docket.db and docket-export.json
sqlite3 docket.db "PRAGMA integrity_check; SELECT 'tasks: ' || COUNT(*) FROM tasks;"
```

You should see `ok` and about as many tasks as the app shows (done tasks count too).

Optional: look at the backup on the Mac without touching the live service. From `docket/` (after `npm install` and `npm run build` once):

```sh
L="$HOME/docket-restore/look-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$L"
TZ=Asia/Kolkata DOCKET_DB="$L/docket.db" DOCKET_RESTORE_FROM="$HOME/docket-restore/docket.db" npm start
```

Then open http://localhost:8787. Press Ctrl-C when done. This works on a copy in a new folder each time, so the original `docket.db` stays as it was.

### 4. Copy the file onto the Render disk

Make a folder for it first. In the Render dashboard, open the docket service's shell (paid services have one) and run:

```sh
mkdir -p /data/restore
```

Then copy `docket.db` there in one of two ways.

**Over SSH.** Render offers SSH access to paid services after you add an SSH public key to your Render account; look for the SSH address on the service's page. Then:

```sh
scp docket.db <ssh address>:/data/restore/docket.db
```

I could not confirm from here that Render's SSH accepts `scp`. If it refuses, use the paste method.

**By pasting through the shell.** This is fine for a database of a few MB. On the Mac:

```sh
ls -l docket.db
gzip -c docket.db | base64 -b 76 | pbcopy
```

In the Render shell, run `cat > /data/restore/docket.b64`, paste, press Enter, then Ctrl-D. Then:

```sh
base64 -d /data/restore/docket.b64 | gunzip > /data/restore/docket.db
ls -l /data/restore/docket.db
```

The size should match the Mac's.

Either way, check the copy on the server (the image has Node but no `sqlite3`):

```sh
node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1],{readOnly:true}); console.log(d.prepare('PRAGMA integrity_check').get().integrity_check, d.prepare('SELECT COUNT(*) n FROM tasks').get().n, 'tasks')" /data/restore/docket.db
```

It should print `ok N tasks`.

### 5. Restore at boot

In the service's environment variables, add `DOCKET_RESTORE_FROM` with the value `/data/restore/docket.db` and save. Let Render deploy the change. If saving doesn't start a deploy, start one by hand from the dashboard.

### 6. Verify

In the service's logs, the boot should show:

```
[docket] restored /data/restore/docket.db (N tasks); previous database kept at /data/docket.db.before-restore-YYYYMMDD-HHMMSS
[docket] opened existing database (N tasks, schema vX, created …)
```

Then:

```sh
curl https://docket-t6dw.onrender.com/healthz
```

Open the app and check today's tasks, then ask Claude in the Docket project "What's on today?".

If the deploy fails with `Error: Refusing to restore …`, the path is wrong or the file is damaged or not a Docket database. Nothing was changed: remove `DOCKET_RESTORE_FROM` so the service starts again on the old database, then copy the file again and repeat from step 4.

### 7. Unset the variable

Remove `DOCKET_RESTORE_FROM` and save. Docket restores a given path only once (it records it in `/data/docket.db.restored-from`), so a variable left behind just logs `DOCKET_RESTORE_FROM is still set … ignoring`, but unsetting it keeps the next restore unambiguous.

A week later, when you're sure, delete the leftovers in the Render shell: `/data/restore/docket.b64` if you used the paste method, and the `/data/docket.db.before-restore-…` files (the database that was replaced). Run `ls /data` to see their exact names.

## Restoring for real

**After a mistake, with the disk fine.** Use an hourly snapshot; nothing needs uploading.

1. In the Render shell: `ls -lt /data/backups | head -20`. Names are `docket-YYYYMMDD-HHMMSS-hourly.db` in local time. Pick the last one before the mistake.
2. Check it with the `node` command from step 4, using that path.
3. Set `DOCKET_RESTORE_FROM=/data/backups/<that file>`, let it deploy, verify (step 6), unset (step 7).

Everything written after that snapshot is rolled back on the live service, but it is still in the replaced database (`/data/docket.db.before-restore-…`) if you need to look something up.

**After losing the disk or the service.** Re-create the service (see "Moving hosts" below), then follow the drill from step 2 with the newest off-site backup. Anything written after that backup (taken nightly at 03:00 IST) is lost.

**Across versions.** An older snapshot is upgraded at boot (after a `pre-migration` snapshot). A snapshot from a newer schema than the deployed build is refused ("newer than this build"): deploy the matching version first.

## Rotating the token

Do this if the connector URL or the token may have leaked, or to switch to a token that needs no encoding.

1. Make a new token on the Mac. Hex has no `/`, `+` or `=`, so it needs no percent-encoding, and the `/mcp/<token>` path form works too:

   ```sh
   openssl rand -hex 32
   ```

2. In the Render dashboard, set `DOCKET_TOKEN` on the service to the new value and save; let it deploy. The old token stops working as soon as the new instance is up.
3. In Claude, **Settings → Connectors → Docket**: change the URL to `https://docket-t6dw.onrender.com/mcp?token=<new token>`. If the form doesn't let you edit the URL, remove the connector, add it again, and switch it on again for the Docket project.
4. In GitHub, **Settings → Secrets and variables → Actions**: update `DOCKET_TOKEN`.
5. On the Mac: update `DOCKET_TOKEN` in `~/.claude/docket.env`. If you added Docket to Claude Code by hand, run `claude mcp remove docket` and add it again with the new token (README, setup step 6).
6. On each device, open `https://docket-t6dw.onrender.com/#token=<new token>` once, or, when the app says "That token didn't work", paste the new token. The iPhone home-screen app may keep its own storage: open the installed app itself and paste there if it asks.
7. Check: Claude answers "What's on today?", the app loads on both devices, and a manual run of the backup workflow is green.

## Reading the logs

In the Render dashboard, open the docket service's logs. Docket's own lines start with `[docket]`; an error's details follow on the next lines.

| Line | Meaning |
|---|---|
| `opened existing database (N tasks, schema vX, created …)` | A normal boot. N should match what you expect. |
| `… upgraded from vY` at the end of that line | Migrations ran; a `pre-migration` snapshot was taken first. |
| `CREATED NEW EMPTY DATABASE at /data/docket.db` | Only right on the very first boot. Any other time, the disk or path is wrong: stop and see the README's "If something goes wrong". |
| `version 0.3.0, TZ Asia/Kolkata (Asia/Calcutta), today …` | The build version, the time zone (the name in brackets is how Node resolves it; Asia/Calcutta is the same zone), and the date Docket thinks it is. |
| `snapshot /data/backups/docket-…-hourly.db, pruned N` | The hourly snapshot. |
| `snapshot failed` | The hourly snapshot didn't work, often because the disk is full. Check with `df -h /data` in the shell. |
| `DOCKET_REQUIRE_DISK=1 but /data …` | Docket refused to start because the disk isn't mounted at `/data`. |
| `TZ="…" is not a valid IANA time zone name` / `is not applied` | Docket refused to start; set `TZ=Asia/Kolkata`. |
| `TZ is not set; running on …` | A warning: `TZ` is missing, so the container's zone (usually UTC) is used. "Today" will then be wrong between 00:00 and 05:30 IST. |
| `Database … is schema version N, newer than this build` | An older build met a newer database (see the README's "Rolling back"). |
| `restored …` / `DOCKET_RESTORE_FROM is still set … ignoring` | A restore happened, or the variable is still set after one. |
| `tool failed <tool> …` | A tool call hit an internal error; Claude was told to try again. |
| `api failed …`, `request failed …`, `MCP error …`, `backup failed …` | A web-app request, a request the body parser rejected, the MCP transport, or `/api/backup` hit an internal error; the details follow. One is harmless, a stream of them means something is wrong with the database or the disk. |
| `healthz failed` | The health check couldn't read the database. |
| `SIGTERM: shutting down` | A normal stop during a deploy or restart. |
| `listening on …` / `MCP endpoint: /mcp …` | Ready. |

Useful commands in the Render shell:

```sh
ls -lt /data/backups | head     # newest snapshots
ls -la /data                    # the database and any leftovers from a restore
df -h /data                     # disk space
```

## Moving hosts

Docket needs one container with a persistent disk, HTTPS in front, and the two variables `TZ` and `DOCKET_TOKEN`. `docket/Dockerfile` builds everything and keeps the database at `/data/docket.db`. Run one instance only: SQLite lives on one disk.

1. **Take a backup** from the old service: run the backup workflow, or from the Mac:

   ```sh
   curl --fail -H "Authorization: Bearer <token>" https://docket-t6dw.onrender.com/api/backup -o docket.db
   curl --fail -H "Authorization: Bearer <token>" https://docket-t6dw.onrender.com/api/export.json -o docket-export.json
   ```

   `docket.db` is what you restore. `docket-export.json` is every table as JSON, for reading or for moving to another tool; Docket has no importer for it.
2. **Start the new service** with a disk mounted at `/data`, `TZ=Asia/Kolkata` and a token (`openssl rand -hex 32`). Options:
   - **Render, by hand** (like the current service): a Docker web service on the Starter plan from this repository and branch, Dockerfile `docket/Dockerfile` with `docket` as the build context, one instance, a 1 GB disk at `/data`, health check `/healthz`, and the two variables.
   - **Render, from the Blueprint**: `render.yaml` at the repo root describes the same service. Render generates a token for it, which may contain `/`, `+` and `=`; replace it with a hex one.
   - **Fly.io**: `docket/fly.toml` is an example config (`TZ=Asia/Kolkata`, `DOCKET_REQUIRE_DISK=1`, a volume at `/data`, region `bom`). Its comments give the steps (`fly volumes create docket_data --size 1`, `fly secrets set DOCKET_TOKEN=$(openssl rand -hex 32)`, `fly deploy`). As written it stops the machine when idle, so hourly snapshots only happen while it runs.
   - **Any Docker host**, from `docket/`: `docker build -t docket .` then `docker run -p 8787:8787 -v docket-data:/data -e DOCKET_TOKEN=… -e TZ=Asia/Kolkata docket`, behind something that provides HTTPS.
3. **Restore into it**: copy `docket.db` onto the new disk and set `DOCKET_RESTORE_FROM` once, as in the drill (steps 4 to 7).
4. **Point everything at the new URL**: the claude.ai connector (`/mcp?token=…`), the app link on each device (`/#token=…`), the GitHub secrets `DOCKET_URL`, `DOCKET_TOKEN` and `RENDER_DEPLOY_HOOK` (a new service has a new hook), and `~/.claude/docket.env`. "Open Claude at" points at Claude, so it stays as it is. If the URL or the deploy branch changes, update `README.md`, this runbook and `CLAUDE.md`.
5. **Keep the old service for a week**, stopped or untouched, then delete it and its disk.

## Monday checklist (5 minutes)

- **Usage.** If you didn't use Claude Code on the Mac in the last few days, check claude.ai/settings/usage and set the slider (or tell Claude "I've used N%"). If Docket says "Your budget reset. N requests were waiting", tap Queue all or Dismiss.
- **Review.** Accept Docket's offer to review last week, and read it.
- **Plan.** Write what you want this week in the "This week" card on Week and tap Plan my week from this. Approve or skip the proposed moves.
- **Leftovers.** Clear the "Carried over" card: move each task to a day, or mark it done or delete it.
- **Done by Claude.** Read the results; mark the tasks done or clear the results.
- **Backups.** In GitHub, **Actions → Docket backup**: last week's nightly runs should be green. Once a month, download one and open it (drill steps 2 and 3).
- **Logs (optional).** Search the Render logs for `snapshot failed` and `tool failed`.
