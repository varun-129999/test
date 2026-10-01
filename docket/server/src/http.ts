import express, { type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './tools.js';
import { DocketError, type Store } from './store.js';

export interface HttpOptions {
  /** Shared secret for the API and remote MCP. Empty disables auth (local use only). */
  token?: string;
  /** Directory with the built web app. */
  webDir?: string;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(store: Store, opts: HttpOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Without a token the server is for local use only: reject other Host headers
  // so a web page can't reach it through DNS rebinding.
  if (!opts.token) {
    const local = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    app.use((req, res, next) => (local.has(req.hostname) ? next() : res.status(403).json({ error: 'Set DOCKET_TOKEN to serve non-local hosts' })));
  }

  // Accepts "Authorization: Bearer <token>", "?token=<token>", or a /mcp/<token> path,
  // because Claude's custom-connector form only takes a URL.
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (!opts.token) return next();
    const header = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const given = header || String(req.query.token ?? '') || String(req.params.token ?? '');
    if (given && safeEqual(given, opts.token)) return next();
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
      console.error('MCP error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
  const noSessions = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.post('/mcp', auth, mcp);
  app.post('/mcp/:token', auth, mcp);
  app.get(['/mcp', '/mcp/:token'], auth, noSessions);
  app.delete(['/mcp', '/mcp/:token'], auth, noSessions);

  // ---------- REST API for the web app ----------
  const api = express.Router();
  api.use(auth);
  const h = (fn: (req: Request) => unknown) => (req: Request, res: Response) => {
    try {
      const out = fn(req);
      res.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof DocketError) res.status(400).json({ error: e.message });
      else { console.error(e); res.status(500).json({ error: 'Server error' }); }
    }
  };
  const p = (req: Request, k: string) => String(req.params[k]);

  api.get('/health', h(() => ({ ok: true })));
  api.get('/state', h(() => store.state()));
  api.get('/overview', h(req => store.overview(req.query.day ? String(req.query.day) : undefined)));

  api.post('/tasks', h(req => store.addTask(req.body)));
  api.patch('/tasks/:id', h(req => store.updateTask(p(req, 'id'), req.body)));
  api.delete('/tasks/:id', h(req => { store.deleteTask(p(req, 'id')); }));
  api.post('/tasks/:id/steps/:idx/toggle', h(req => store.toggleStep(p(req, 'id'), Number(req.params.idx))));

  api.post('/moves/:id/resolve', h(req => store.resolveMove(p(req, 'id'), !!req.body?.approve)));

  api.put('/usage', h(req => store.setUsage(Number(req.body?.used_pct))));
  api.patch('/settings', h(req => store.setSettings(req.body ?? {})));

  api.post('/requests', h(req => store.queueRequest(req.body ?? {})));
  api.delete('/requests/:id', h(req => { store.cancelRequest(p(req, 'id')); }));
  api.post('/held/:id/run', h(req => store.runHeld(p(req, 'id'))));
  api.delete('/held/:id', h(req => { store.dropHeld(p(req, 'id')); }));

  api.post('/finds/:id/add', h(req => store.resolveFind(p(req, 'id'), true)));
  api.post('/finds/:id/skip', h(req => { store.resolveFind(p(req, 'id'), false); }));

  api.post('/reviews/:week/dismiss', h(req => { store.dismissReview(p(req, 'week')); }));
  api.post('/sample', h(() => { store.loadSample(); }));

  // Server-sent events: tells open apps to refetch after any change (including Claude's).
  api.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    let timer: NodeJS.Timeout | undefined;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(() => res.write('event: change\ndata: {}\n\n'), 50); };
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    store.events.on('change', onChange);
    req.on('close', () => { store.events.off('change', onChange); clearInterval(ping); clearTimeout(timer); });
  });

  app.use('/api', api);

  // ---------- web app ----------
  if (opts.webDir && existsSync(join(opts.webDir, 'index.html'))) {
    const webDir = opts.webDir;
    app.use(express.static(webDir, {
      setHeaders: (res, path) => { if (path.endsWith('sw.js') || path.endsWith('index.html')) res.set('Cache-Control', 'no-cache'); },
    }));
    app.get(/^\/(?!api\/|mcp).*/, (_req, res) => res.sendFile(join(webDir, 'index.html')));
  }

  return app;
}
