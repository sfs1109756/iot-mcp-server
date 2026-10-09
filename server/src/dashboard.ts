import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Express } from 'express';
import { activity } from './activity.js';
import { runAgent, type AgentEvent } from './agent.js';
import { computeAlerts } from './devices/alerts.js';
import { METRIC_INFO, type Command, type DeviceAdapter, type Metric } from './devices/types.js';
import { HttpError, asyncRoute, clip, createApp, finishApp } from './http.js';
import { createMcpServer } from './mcp.js';

/**
 * Web dashboard + HTTP MCP endpoint, sharing the same devices as the stdio MCP server.
 *   /api/*  dashboard data, manual controls, live stream (SSE), agent chat
 *   /mcp    Streamable HTTP MCP endpoint for HTTP-capable MCP clients
 */
export function createDashboard(adapter: DeviceAdapter): Express {
  const app = createApp();

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

  /** Live updates: device snapshot every 2s + every activity entry as it happens. */
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const snapshot = () => send('devices', { devices: adapter.list(), alerts: computeAlerts(adapter.list()) });
    snapshot();
    const timer = setInterval(snapshot, 2000);
    const onEntry = (e: unknown) => send('activity', e);
    activity.on('entry', onEntry);
    req.on('close', () => {
      clearInterval(timer);
      activity.off('entry', onEntry);
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

      const server = createMcpServer(adapter, 'agent');
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
      const server = createMcpServer(adapter, 'mcp');
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
