import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { activity } from './activity.js';
import { runAgent, type AgentEvent } from './agent.js';
import { computeAlerts } from './devices/alerts.js';
import { METRIC_INFO, type Command, type DeviceAdapter, type Metric } from './devices/types.js';
import { HttpError, asyncRoute, clip, createApp, finishApp } from './http.js';
import { createMcpServer } from './mcp.js';
import type { NewRule, RuleEngine } from './rules.js';

/**
 * Optional shared-secret auth (AUTH_TOKEN). When set, /api/* (except /api/health) and /mcp
 * need "Authorization: Bearer <token>" — or ?token= for the browser's EventSource stream.
 * Strongly recommended with real devices or HOST=0.0.0.0, since these endpoints control hardware.
 */
export function requireToken(token: string | undefined): RequestHandler {
  const expected = token ? Buffer.from(token) : null;
  return (req, res, next) => {
    if (!expected) return next();
    const header = req.headers.authorization;
    const given = header?.startsWith('Bearer ') ? header.slice(7) : typeof req.query.token === 'string' ? req.query.token : '';
    const buf = Buffer.from(given);
    if (buf.length === expected.length && timingSafeEqual(buf, expected)) return next();
    res.status(401).json({ error: 'This dashboard needs an access token.', needsToken: true });
  };
}

/**
 * Web dashboard + HTTP MCP endpoint, sharing the same devices as the stdio MCP server.
 *   /api/*  dashboard data, manual controls, live stream (SSE), agent chat
 *   /mcp    Streamable HTTP MCP endpoint for HTTP-capable MCP clients
 */
export function createDashboard(adapter: DeviceAdapter, rules?: RuleEngine, token = process.env.AUTH_TOKEN): Express {
  const app = createApp(); // registers the public /api/health first
  app.use(['/api', '/mcp'], requireToken(token));

  app.get('/api/devices', (_req, res) => res.json({ adapter: adapter.name, devices: adapter.list() }));
  app.get('/api/alerts', (_req, res) => res.json({ alerts: computeAlerts(adapter.list()) }));
  app.get('/api/activity', (_req, res) => res.json({ activity: activity.recent(100) }));

  app.get('/api/devices/:id/history', (req, res) => {
    const metric = String(req.query.metric ?? 'co2') as Metric;
    if (!(metric in METRIC_INFO)) throw new HttpError(400, 'Unknown metric.');
    const minutes = Math.min(1440, Math.max(5, Number(req.query.minutes ?? 120)));
    res.json({ metric, points: adapter.history(String(req.params.id), metric, minutes) });
  });

  app.post(
    '/api/devices/:id/command',
    asyncRoute(async (req, res) => {
      const command = req.body as Command;
      if (!command || typeof command.type !== 'string') throw new HttpError(400, 'Missing command.');
      const result = await adapter.send(String(req.params.id), command);
      activity.add({ source: 'dashboard', action: command.type, ok: result.ok, detail: result.message });
      res.status(result.ok ? 200 : 400).json(result);
    }),
  );

  // ---- automation rules ----
  app.get('/api/rules', (_req, res) => res.json({ rules: rules?.list() ?? [] }));
  app.post('/api/rules', (req, res) => {
    if (!rules) throw new HttpError(404, 'Rules are not enabled.');
    try {
      const b = (req.body ?? {}) as Partial<NewRule>;
      if (!b.name || !b.when || !b.then) throw new Error('A rule needs a name, a condition and an action.');
      const rule = rules.create({
        name: String(b.name).slice(0, 80),
        when: {
          deviceId: b.when.deviceId,
          metric: b.when.metric,
          op: b.when.op === '<' ? '<' : '>',
          value: Number(b.when.value),
          forSeconds: Math.max(0, Number(b.when.forSeconds) || 0),
        },
        then: { deviceId: b.then.deviceId, command: b.then.command },
        ...(b.onClear ? { onClear: { deviceId: b.onClear.deviceId, command: b.onClear.command } } : {}),
        enabled: true,
        createdBy: 'dashboard',
      });
      activity.add({ source: 'dashboard', action: 'create_rule', ok: true, detail: rule.name });
      res.status(201).json(rule);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });
  app.patch('/api/rules/:id', (req, res) => {
    if (!rules) throw new HttpError(404, 'Rules are not enabled.');
    try {
      res.json(rules.setEnabled(String(req.params.id), Boolean(req.body?.enabled)));
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
  });
  app.delete('/api/rules/:id', (req, res) => {
    if (!rules) throw new HttpError(404, 'Rules are not enabled.');
    try {
      rules.remove(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      throw new HttpError(404, (err as Error).message);
    }
  });

  /** Live updates: device snapshot every 2s + every activity entry as it happens. */
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const snapshot = () => send('devices', { devices: adapter.list(), alerts: computeAlerts(adapter.list()) });
    snapshot();
    const timer = setInterval(snapshot, 2000);
    const onEntry = (e: unknown) => send('activity', e);
    const onRules = (list: unknown) => send('rules', { rules: list });
    activity.on('entry', onEntry);
    rules?.on('change', onRules);
    if (rules) onRules(rules.list());
    req.on('close', () => {
      clearInterval(timer);
      activity.off('entry', onEntry);
      rules?.off('change', onRules);
    });
  });

  /**
   * Agent chat from the dashboard. The agent talks to the MCP server through an
   * in-memory MCP transport — the same protocol an external client would use.
   * Streams agent events as NDJSON so the UI can show each tool call live.
   */
  app.post(
    '/api/agent',
    asyncRoute(async (req, res) => {
      const question = clip(req.body?.question, 1000);
      if (!question) throw new HttpError(400, 'Ask the agent something.');

      const server = createMcpServer(adapter, 'agent', rules);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'dashboard-agent', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
      const emit = (e: AgentEvent | { type: 'error'; message: string }) => res.write(`${JSON.stringify(e)}\n`);
      try {
        await runAgent(client, question, emit);
      } catch (err) {
        emit({ type: 'error', message: (err as Error).message });
      } finally {
        res.end();
        await client.close().catch(() => {});
        await server.close().catch(() => {});
      }
    }),
  );

  // Streamable HTTP MCP endpoint (stateless: a fresh server per request, shared devices).
  app.post(
    '/mcp',
    asyncRoute(async (req, res) => {
      const server = createMcpServer(adapter, 'mcp', rules);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }),
  );
  const notAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. Use POST.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  finishApp(app);
  return app;
}
