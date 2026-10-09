import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { activity } from './activity.js';
import { computeAlerts, THRESHOLDS } from './devices/alerts.js';
import { METRIC_INFO, type Command, type DeviceAdapter, type DeviceState, type Metric } from './devices/types.js';

const METRICS = Object.keys(METRIC_INFO) as [Metric, ...Metric[]];

type Source = 'mcp' | 'agent';

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({ ...text(message), isError: true });

/** Compact view of a device for the model (no internal fields). */
function describe(d: DeviceState) {
  const readings = Object.fromEntries(
    Object.entries(d.readings).map(([k, v]) => [k, `${v} ${METRIC_INFO[k as Metric]?.unit ?? ''}`.trim()]),
  );
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    room: d.room,
    online: d.online,
    lastSeen: d.lastSeen,
    readings,
    actuators: d.actuators,
    ...(Object.keys(d.meta).length ? { info: d.meta } : {}),
  };
}

/** Reduces a long history to `maxPoints` evenly spaced averages and adds stats + trend. */
function summarizeHistory(points: { t: string; v: number }[], maxPoints: number) {
  if (points.length === 0) return { count: 0, points: [] };
  const values = points.map((p) => p.v);
  const bucket = Math.max(1, Math.ceil(points.length / maxPoints));
  const sampled: { t: string; v: number }[] = [];
  for (let i = 0; i < points.length; i += bucket) {
    const chunk = points.slice(i, i + bucket);
    sampled.push({ t: chunk[chunk.length - 1].t, v: Math.round((chunk.reduce((s, p) => s + p.v, 0) / chunk.length) * 10) / 10 });
  }
  const first = values.slice(0, Math.max(1, Math.floor(values.length / 5)));
  const last = values.slice(-Math.max(1, Math.floor(values.length / 5)));
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const change = avg(last) - avg(first);
  const rel = Math.abs(change) / Math.max(1, Math.abs(avg(first)));
  return {
    count: points.length,
    from: points[0].t,
    to: points[points.length - 1].t,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: Math.round(avg(values) * 10) / 10,
    latest: values[values.length - 1],
    trend: rel < 0.05 ? 'stable' : change > 0 ? 'rising' : 'falling',
    points: sampled,
  };
}

export function createMcpServer(adapter: DeviceAdapter, source: Source = 'mcp'): McpServer {
  const server = new McpServer(
    { name: 'iot-devices', version: '1.0.0' },
    {
      instructions: `Tools for monitoring and controlling ESP32-based building devices (air monitors, a ventilation fan, an air purifier and an exhaust relay).
Check status or alerts before changing anything, change only what is needed, and report the effect.
Thresholds: CO2 warning ${THRESHOLDS.co2.warning} ppm / critical ${THRESHOLDS.co2.critical}; PM2.5 warning ${THRESHOLDS.pm25.warning} µg/m³ / critical ${THRESHOLDS.pm25.critical}; TVOC warning ${THRESHOLDS.tvoc.warning} ppb / critical ${THRESHOLDS.tvoc.critical}.`,
    },
  );

  const log = (action: string, ok: boolean, detail: string) => activity.add({ source, action, ok, detail });

  const runCommand = async (deviceId: string, command: Command, label: string, reason?: string) => {
    const result = await adapter.send(deviceId, command);
    log(label, result.ok, `${result.message}${reason ? ` Reason: ${reason}` : ''}`);
    if (!result.ok) return fail(result.message);
    return text({ ok: true, message: result.message, device: result.device ? describe(result.device) : undefined });
  };

  // ---------------- read tools ----------------

  server.registerTool(
    'list_devices',
    {
      title: 'List devices',
      description: 'List every device with its room, type, online status, latest readings and actuator settings.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      log('list_devices', true, `${adapter.list().length} devices`);
      return text(adapter.list().map(describe));
    },
  );

  server.registerTool(
    'get_device_status',
    {
      title: 'Get device status',
      description: 'Get the latest readings, actuator settings and info for one device.',
      inputSchema: { device_id: z.string().describe('Device id, e.g. "aq-conf-01". Use list_devices to find ids.') },
      annotations: { readOnlyHint: true },
    },
    async ({ device_id }) => {
      const d = adapter.get(device_id);
      log('get_device_status', Boolean(d), device_id);
      return d ? text(describe(d)) : fail(`No device with id "${device_id}". Call list_devices to see valid ids.`);
    },
  );

  server.registerTool(
    'get_room_summary',
    {
      title: 'Get room summary',
      description: 'Summarise a room (or all rooms): air readings from its monitors, the devices that can act on it, and active alerts.',
      inputSchema: { room: z.string().optional().describe('Room name, e.g. "Conference Room A". Omit for all rooms.') },
      annotations: { readOnlyHint: true },
    },
    async ({ room }) => {
      const all = adapter.list();
      const rooms = [...new Set(all.map((d) => d.room))].filter((r) => !room || r.toLowerCase().includes(room.toLowerCase()));
      if (rooms.length === 0) return fail(`No room matches "${room}". Rooms: ${[...new Set(all.map((d) => d.room))].join(', ')}`);
      const alerts = computeAlerts(all);
      const out = rooms.map((r) => {
        const devices = all.filter((d) => d.room === r);
        return {
          room: r,
          air: devices.filter((d) => d.kind === 'air_monitor').map((d) => ({ device: d.id, online: d.online, ...describe(d).readings })),
          controls: devices.filter((d) => d.kind !== 'air_monitor').map((d) => ({ device: d.id, kind: d.kind, ...d.actuators, online: d.online })),
          alerts: alerts.filter((a) => a.room === r).map((a) => `[${a.severity}] ${a.message}`),
        };
      });
      log('get_room_summary', true, room ?? 'all rooms');
      return text(out);
    },
  );

  server.registerTool(
    'get_sensor_history',
    {
      title: 'Get sensor history',
      description: 'Get recent history for one metric of one device, with min/max/avg, a trend (rising/falling/stable) and downsampled points.',
      inputSchema: {
        device_id: z.string(),
        metric: z.enum(METRICS).describe('pm25, pm10, co2, tvoc, temperature, humidity, battery or rssi'),
        minutes: z.number().int().min(5).max(1440).default(60).describe('How far back to look (5–1440 minutes).'),
        max_points: z.number().int().min(5).max(200).default(24),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ device_id, metric, minutes, max_points }) => {
      const d = adapter.get(device_id);
      if (!d) return fail(`No device with id "${device_id}".`);
      const summary = summarizeHistory(adapter.history(device_id, metric, minutes), max_points);
      log('get_sensor_history', true, `${device_id} ${metric} ${minutes}min`);
      return text({ device: device_id, room: d.room, metric, unit: METRIC_INFO[metric].unit, minutes, ...summary });
    },
  );

  server.registerTool(
    'get_alerts',
    {
      title: 'Get active alerts',
      description: 'List active problems across all devices: poor air quality, offline devices, low batteries, worn filters.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const alerts = computeAlerts(adapter.list());
      log('get_alerts', true, `${alerts.length} active`);
      return text(alerts.length ? alerts : 'No active alerts. Everything is within normal ranges.');
    },
  );

  // ---------------- control tools ----------------

  const reason = z.string().optional().describe('Short reason, recorded in the activity log.');

  server.registerTool(
    'set_fan_speed',
    {
      title: 'Set ventilation fan speed',
      description: 'Set a ventilation fan (kind "ventilation_fan") to 0–100%. Higher speed brings in fresh air and lowers CO2.',
      inputSchema: { device_id: z.string(), speed: z.number().int().min(0).max(100), reason },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device_id, speed, reason }) => runCommand(device_id, { type: 'set_fan_speed', speed }, 'set_fan_speed', reason),
  );

  server.registerTool(
    'set_purifier_mode',
    {
      title: 'Set air purifier mode',
      description: 'Set an air purifier (kind "air_purifier") to off, auto, low, medium or high. Higher modes remove PM2.5/PM10 faster.',
      inputSchema: { device_id: z.string(), mode: z.enum(['off', 'auto', 'low', 'medium', 'high']), reason },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device_id, mode, reason }) => runCommand(device_id, { type: 'set_purifier_mode', mode }, 'set_purifier_mode', reason),
  );

  server.registerTool(
    'set_relay',
    {
      title: 'Switch a relay',
      description: 'Turn a relay (kind "relay") on or off, e.g. the R&D Lab fume exhaust fan that clears TVOC.',
      inputSchema: { device_id: z.string(), on: z.boolean(), reason },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device_id, on, reason }) => runCommand(device_id, { type: 'set_relay', on }, 'set_relay', reason),
  );

  server.registerTool(
    'identify_device',
    {
      title: 'Identify device',
      description: 'Blink a device LED for 10 seconds so a technician can find it on site.',
      inputSchema: { device_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ device_id }) => runCommand(device_id, { type: 'identify' }, 'identify_device'),
  );

  // ---------------- resources ----------------

  server.registerResource(
    'fleet',
    'iot://devices',
    { title: 'All devices', description: 'Current state of every device', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(adapter.list().map(describe), null, 2) }] }),
  );

  server.registerResource(
    'device',
    new ResourceTemplate('iot://devices/{id}', {
      list: async () => ({
        resources: adapter.list().map((d) => ({ uri: `iot://devices/${d.id}`, name: `${d.room} · ${d.name}`, mimeType: 'application/json' })),
      }),
    }),
    { title: 'Device', description: 'Current state of one device', mimeType: 'application/json' },
    async (uri, { id }) => {
      const d = adapter.get(String(id));
      if (!d) throw new Error(`No device with id "${id}"`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(describe(d), null, 2) }] };
    },
  );

  // ---------------- prompts ----------------

  server.registerPrompt(
    'building_health_check',
    {
      title: 'Building health check',
      description: 'Check every room, fix what can be fixed with the available devices, and report.',
      argsSchema: { room: z.string().optional() },
    },
    ({ room }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Run a health check${room ? ` for ${room}` : ' for the whole building'}.
1. Call get_alerts and get_room_summary.
2. For each air-quality problem, look at get_sensor_history to see the trend.
3. Use the control tools to fix problems the devices can fix (fan for CO2, purifier for particles, exhaust relay for TVOC). Don't change anything that's already fine.
4. List what you changed and why, and flag issues that need a person (offline devices, low batteries, filters).`,
          },
        },
      ],
    }),
  );

  return server;
}
