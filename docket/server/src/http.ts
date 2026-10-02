import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportJson, snapshot } from './backup.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './tools.js';
import { DocketError, type Store } from './store.js';
import * as S from './schemas.js';
import { issuesText, norm } from './schemas.js';

export interface HttpOptions {
  /** Shared secret for the API and remote MCP. Empty disables auth (local use only). */
  token?: string;
  /** A second secret that can only capture (POST /api/quick, GET /api/quick/ping), for Apple Shortcuts. */
  captureToken?: string;
  /** Directory with the built web app. */
  webDir?: string;
  /** Where snapshots are kept; enables the pre-reset snapshot. */
  backupDir?: string;
  version?: string;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(store: Store, opts: HttpOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Bodies are parsed after auth, so nobody without the token gets a megabyte parsed.
  const json = express.json({ limit: '1mb' });

  // Without a token the server is for local use only: reject other Host headers
  // so a web page can't reach it through DNS rebinding.
  if (!opts.token) {
    const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    app.use((req, res, next) => (local.has(req.hostname) ? next() : res.status(403).json({ error: 'Set DOCKET_TOKEN to serve non-local hosts' })));
  }

  // "Authorization: Bearer <token>" everywhere. The URL forms (?token=, /mcp/<token>) only
  // where a header can't be set: Claude's connector form takes a URL, and EventSource can't
  // send headers. Anywhere else a token in the URL would end up in logs and caches.
  const auth = (allowUrl: boolean) => (req: Request, res: Response, next: NextFunction) => {
    if (!opts.token) return next();
    const header = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const given = header || (allowUrl ? String(req.query.token ?? '') || String(req.params.token ?? '') : '');
    if (given && safeEqual(given, opts.token)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };

  // Capture from anywhere: the main token, or the capture token, which works on these routes only
  // (a leaked one can add tasks and nothing else). Some share flows can't set headers, so the
  // capture token may also come as ?token=; the main token stays in the header.
  const quickAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.token) return next();
    const header = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const query = String(req.query.token ?? '');
    if (header && safeEqual(header, opts.token)) return next();
    if (opts.captureToken && [header, query].some(g => g && safeEqual(g, opts.captureToken!))) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };

  // ---------- remote MCP (Streamable HTTP, stateless) ----------
  const mcp = async (req: Request, res: Response) => {
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[docket] MCP error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
  const noSessions = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  // Unauthenticated health check for hosting platforms: proves the database answers.
  app.get('/healthz', (_req, res) => {
    try {
      store.db.prepare('SELECT 1 FROM settings WHERE id = 1').get();
      res.json({ ok: true, version: opts.version ?? '0' });
    } catch (e) {
      console.error('[docket] healthz failed', e);
      res.status(503).json({ ok: false });
    }
  });

  app.post(['/mcp', '/mcp/:token'], auth(true), json, mcp);
  app.get(['/mcp', '/mcp/:token'], auth(true), noSessions);
  app.delete(['/mcp', '/mcp/:token'], auth(true), noSessions);

  // ---------- REST API for the web app ----------
  const api = express.Router();
  api.use((req, res, next) => auth(req.method === 'GET' && req.path === '/events')(req, res, next));
  api.use(json);

  /**
   * A route: validates the body with the shared schema (400 naming the bad fields), normalises
   * enum spellings, and turns DocketErrors into 400s. Handlers may be async.
   */
  function h(fn: (req: Request) => unknown): RequestHandler;
  function h<T extends z.ZodType>(schema: T, fn: (req: Request, body: ReturnType<typeof norm<z.output<T> & object>>) => unknown): RequestHandler;
  function h(a: z.ZodType | ((req: Request) => unknown), b?: (req: Request, body: any) => unknown): RequestHandler {
    const schema = typeof a === 'function' ? null : a;
    const fn = (typeof a === 'function' ? a : b)!;
    return async (req, res) => {
      try {
        let body: unknown;
        if (schema) {
          const r = schema.safeParse(req.body ?? {});
          if (!r.success) { res.status(400).json({ error: issuesText(r.error) }); return; }
          body = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? norm(r.data) : r.data;
        }
        const out = await fn(req, body);
        res.json(out ?? { ok: true });
      } catch (e) {
        if (e instanceof DocketError) res.status(400).json({ error: e.message });
        else { console.error('[docket] api failed', req.method, req.path, e); res.status(500).json({ error: 'Server error' }); }
      }
    };
  }
  const p = (req: Request, k: string) => String(req.params[k]);
  const idx = (req: Request) => Number(req.params.idx);

  api.get('/health', h(() => ({ ok: true })));
  api.get('/state', h(() => store.state()));
  api.get('/overview', h(req => store.overview(req.query.day ? String(req.query.day) : undefined)));

  api.post('/tasks', h(S.TaskInput, (_req, b) => store.addTask(b)));
  api.patch('/tasks/:id', h(S.TaskPatch, (req, b) => store.updateTask(p(req, 'id'), b)));
  api.delete('/tasks/:id', h(req => { store.deleteTask(p(req, 'id')); }));
  api.put('/tasks/:id/steps', h(S.SetSteps.pick({ steps: true }), (req, b) => store.setSteps(p(req, 'id'), b.steps)));
  api.post('/tasks/:id/steps', h(S.AddSteps.omit({ id: true }), (req, b) => store.addSteps(p(req, 'id'), b.steps, b.at)));
  api.patch('/tasks/:id/steps/:idx', h(S.StepDone, (req, b) => store.setStep(p(req, 'id'), idx(req), b.done)));
  api.post('/tasks/:id/steps/:idx/toggle', h(req => store.toggleStep(p(req, 'id'), idx(req))));

  api.post('/moves/resolve-all', h(S.Approve, (_req, b) => store.resolveMoves({ all: true }, b.approve)));
  api.post('/moves/:id/resolve', h(S.Approve, (req, b) => store.resolveMove(p(req, 'id'), b.approve)));

  api.put('/usage', h(S.SetUsage, (_req, b) => store.setUsage(b.used_pct, { resets_at: b.resets_at, source: b.source ?? 'owner' })));
  api.patch('/settings', h(S.SetSettings, (_req, b) => store.setSettings(b)));

  api.post('/requests', h(S.QueueRequest, (_req, b) => store.queueRequest(b)));
  api.post('/requests/seen', h(S.Seen, (_req, b) => store.markSeen(b.ids)));
  api.delete('/requests/:id', h(req => { store.cancelRequest(p(req, 'id')); }));
  api.post('/held/queue-all', h(() => store.queueAllHeld()));
  api.post('/held/:id/run', h(req => store.runHeld(p(req, 'id'))));
  api.delete('/held/:id', h(req => { store.dropHeld(p(req, 'id')); }));
  api.post('/reset-notice/dismiss', h(() => { store.dismissResetNotice(); }));

  api.put('/week-plan', h(S.SetWeekPlan, (_req, b) => store.setWeekPlan(b.week_start, b.text)));
  api.delete('/week-plan/:week', h(req => { store.deleteWeekPlan(p(req, 'week')); }));

  api.post('/finds/:id/add', h(req => store.resolveFind(p(req, 'id'), true)));
  api.post('/finds/:id/skip', h(req => { store.resolveFind(p(req, 'id'), false); }));

  api.post('/reviews/:week/dismiss', h(req => { store.dismissReview(p(req, 'week')); }));

  // Replaces everything with the sample data. Only with DOCKET_SAMPLE=1 (never in production),
  // only with an explicit confirmation, and only after a snapshot.
  api.post('/sample', h(req => {
    if (!store.flags.sample) throw new DocketError('The sample-data reset is disabled on this server. Start it with DOCKET_SAMPLE=1 to allow it.');
    if (req.body?.confirm !== 'wipe') throw new DocketError('Send {"confirm":"wipe"} to replace all data with the samples.');
    if (opts.backupDir) snapshot(store.db, opts.backupDir, 'pre-reset');
    store.loadSample();
  }));

  // Backups: a consistent copy of the database file, and everything as JSON.
  api.get('/backup', (req, res) => {
    const file = join(tmpdir(), `docket-backup-${process.pid}-${Date.now()}.db`);
    try {
      store.db.prepare('VACUUM INTO ?').run(file);
    } catch (e) {
      console.error('[docket] backup failed', e);
      res.status(500).json({ error: 'Backup failed' });
      return;
    }
    res.download(file, `docket-${store.today()}.db`, () => { try { unlinkSync(file); } catch { /* already gone */ } });
  });
  api.get('/export.json', h(() => exportJson(store.db)));

  // Server-sent events: tells open apps to refetch after any change (including Claude's).
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(() => res.write('event: change\ndata: {}\n\n'), 50); };
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const onShutdown = () => res.end();
    store.events.on('change', onChange);
    store.events.once('shutdown', onShutdown);
    req.on('close', () => { store.events.off('change', onChange); store.events.off('shutdown', onShutdown); clearInterval(ping); clearTimeout(timer); });
  });

  api.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  // Registered before the API router, whose auth takes the main token only.
  app.post('/api/quick', quickAuth, json, h(S.Quick, (_req, b) => store.quickAdd(b)));
  app.get('/api/quick/ping', quickAuth, h(() => ({ ok: true, today: store.today() })));
  app.use('/api', api);

  // ---------- web app ----------
  if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) {
    const webDir = opts.webDir;
    app.use(express.static(webDir, {
      setHeaders: (res, path) => { if (path.endsWith('sw.js') || path.endsWith('index.html')) res.set('Cache-Control', 'no-cache'); },
    }));
    app.get(/^\/(?!api\/|mcp).*/, (_req, res) => res.sendFile(join(webDir, 'index.html')));
  }

  // Last stop for errors from the body parser and anything unexpected: always JSON, never a stack.
  app.use((err: { type?: string; status?: number }, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON' });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Body too large' });
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[docket] request failed', req.method, req.path, err);
    res.status(status).json({ error: status === 500 ? 'Server error' : 'Bad request' });
  });

  return app;
}
