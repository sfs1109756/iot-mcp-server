import './env.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { activity } from './activity.js';
import { createDashboard } from './dashboard.js';
import { startEmbeddedBroker } from './devices/broker.js';
import { Esp32HttpAdapter } from './devices/esp32Http.js';
import { MqttAdapter } from './devices/mqtt.js';
import { SimulatedAdapter } from './devices/simulator.js';
import type { DeviceAdapter } from './devices/types.js';
import { createMcpServer } from './mcp.js';
import { RuleEngine } from './rules.js';

/**
 * Entry point.
 *   (default)          MCP over stdio  +  dashboard/HTTP MCP on PORT   ← what Claude Desktop launches
 *   --dashboard-only   dashboard/HTTP MCP only (for `npm run dev`)
 *   --mcp-only         MCP over stdio only
 *
 * IMPORTANT: in stdio mode stdout carries the MCP protocol, so all logging goes to stderr.
 */
const args = new Set(process.argv.slice(2));
const useStdio = !args.has('--dashboard-only');
const useDashboard = !args.has('--mcp-only');
const log = (...m: unknown[]) => console.error('[iot-mcp]', ...m);

async function makeAdapter(): Promise<DeviceAdapter> {
  const kind = (process.env.DEVICE_ADAPTER ?? 'sim').toLowerCase();
  if (kind === 'http') return new Esp32HttpAdapter();
  if (kind === 'mqtt') {
    if (process.env.MQTT_EMBEDDED_BROKER === 'true') {
      const broker = await startEmbeddedBroker();
      log(`Built-in MQTT broker on mqtt://0.0.0.0:${broker.port}`);
      return new MqttAdapter(`mqtt://localhost:${broker.port}`);
    }
    return new MqttAdapter();
  }
  return new SimulatedAdapter();
}

async function main() {
  const adapter = await makeAdapter();
  await adapter.start();
  const rules = new RuleEngine(adapter);
  rules.start();
  activity.add({ source: 'system', action: 'start', ok: true, detail: `Using ${adapter.name} with ${adapter.list().length} devices.` });
  log(`Device adapter: ${adapter.name} (${adapter.list().length} devices)`);

  if (useDashboard) {
    const port = Number(process.env.PORT ?? 3003);
    // Local-only by default; set HOST=0.0.0.0 (and AUTH_TOKEN) to reach it from other machines.
    const host = process.env.HOST ?? '127.0.0.1';
    const app = createDashboard(adapter, rules);
    const httpServer = app.listen(port, host, () => {
      log(`Dashboard:       http://localhost:${port}`);
      log(`HTTP MCP server: http://localhost:${port}/mcp`);
    });
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      // Another instance (e.g. `npm run dev`) may own the port. Keep serving MCP over stdio.
      if (err.code === 'EADDRINUSE') log(`Port ${port} is busy, dashboard disabled for this process.`);
      else log('Dashboard error:', err.message);
    });
  }

  if (useStdio) {
    const server = createMcpServer(adapter, 'mcp', rules);
    await server.connect(new StdioServerTransport());
    log('MCP server ready on stdio.');
  }
}

main().catch((err) => {
  log('Fatal:', err);
  process.exit(1);
});
