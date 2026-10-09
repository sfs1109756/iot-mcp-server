import { randomUUID } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import type { Command, CommandResult, DeviceAdapter, DeviceState, HistoryPoint, Metric } from './types.js';

/**
 * Talks to devices over MQTT — the usual way ESP32 fleets report in.
 *
 * Topic contract (prefix defaults to "iot"):
 *   iot/<id>/status   device → server  JSON { name, kind, room, firmware, readings, actuators, meta }  (retain recommended)
 *   iot/<id>/online   device → server  "true" / "false"  (set "false" as the device's MQTT Last Will)
 *   iot/<id>/command  server → device  JSON { requestId, type, ...args }
 *   iot/<id>/ack      device → server  JSON { requestId, ok, message }
 *
 * A device that hasn't sent a status within MQTT_STALE_SECONDS (default 60) is shown as offline.
 */

const HISTORY_MAX_MS = 24 * 3600_000;

interface Tracked {
  state: DeviceState;
  lastStatusAt: number;
  explicitOffline: boolean;
  history: Map<Metric, HistoryPoint[]>;
}

export class MqttAdapter implements DeviceAdapter {
  readonly name = 'mqtt';
  private client?: MqttClient;
  private devices = new Map<string, Tracked>();
  private pending = new Map<string, (r: { ok: boolean; message: string }) => void>();
  private readonly staleMs = Number(process.env.MQTT_STALE_SECONDS ?? 60) * 1000;
  private readonly ackTimeoutMs = Number(process.env.MQTT_ACK_TIMEOUT_MS ?? 5000);

  constructor(
    private readonly url = process.env.MQTT_URL ?? 'mqtt://localhost:1883',
    private readonly prefix = process.env.MQTT_TOPIC_PREFIX ?? 'iot',
  ) {}

  async start(): Promise<void> {
    const client = mqtt.connect(this.url, {
      clientId: `iot-mcp-server-${randomUUID().slice(0, 8)}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      reconnectPeriod: 2000,
    });
    this.client = client;
    client.on('message', (topic, payload) => this.onMessage(topic, payload.toString()));
    client.on('connect', () => {
      client.subscribe([`${this.prefix}/+/status`, `${this.prefix}/+/online`, `${this.prefix}/+/ack`]);
    });
    client.on('error', (err) => console.error('[iot-mcp] MQTT error:', err.message));

    // Don't block startup forever if the broker is down; the client keeps retrying.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.error(`[iot-mcp] MQTT broker at ${this.url} not reachable yet; will keep retrying.`);
        resolve();
      }, 5000);
      client.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Give retained status messages a moment to arrive.
    await new Promise((r) => setTimeout(r, 300));
  }

  stop(): void {
    this.client?.end(true);
  }

  private onMessage(topic: string, text: string): void {
    const [, id, kind] = topic.split('/');
    if (!id || !kind) return;
    if (kind === 'ack') {
      try {
        const ack = JSON.parse(text) as { requestId?: string; ok?: boolean; message?: string };
        const resolve = ack.requestId ? this.pending.get(ack.requestId) : undefined;
        if (resolve) resolve({ ok: ack.ok !== false, message: ack.message ?? 'Command accepted.' });
      } catch {
        /* ignore malformed acks */
      }
      return;
    }
    const d = this.track(id);
    if (kind === 'online') {
      d.explicitOffline = text.trim().toLowerCase() === 'false' || text.trim() === '0';
      return;
    }
    if (kind === 'status') {
      let body: Partial<DeviceState>;
      try {
        body = JSON.parse(text);
      } catch {
        return;
      }
      const now = Date.now();
      d.lastStatusAt = now;
      d.explicitOffline = false;
      d.state = {
        ...d.state,
        name: body.name ?? d.state.name,
        kind: body.kind ?? d.state.kind,
        room: body.room ?? d.state.room,
        firmware: body.firmware ?? d.state.firmware,
        readings: body.readings ?? {},
        actuators: body.actuators ?? {},
        meta: body.meta ?? {},
        lastSeen: new Date(now).toISOString(),
      };
      for (const [metric, value] of Object.entries(d.state.readings) as [Metric, number][]) {
        if (typeof value !== 'number') continue;
        const arr = d.history.get(metric) ?? [];
        arr.push({ t: d.state.lastSeen, v: value });
        while (arr.length && now - Date.parse(arr[0].t) > HISTORY_MAX_MS) arr.shift();
        d.history.set(metric, arr);
      }
    }
  }

  private track(id: string): Tracked {
    let d = this.devices.get(id);
    if (!d) {
      d = {
        lastStatusAt: 0,
        explicitOffline: false,
        history: new Map(),
        state: {
          id,
          name: id,
          kind: 'air_monitor',
          room: 'Unknown',
          firmware: '?',
          online: false,
          lastSeen: new Date(0).toISOString(),
          readings: {},
          actuators: {},
          meta: {},
        },
      };
      this.devices.set(id, d);
    }
    return d;
  }

  private snapshot(d: Tracked): DeviceState {
    const online = !d.explicitOffline && Date.now() - d.lastStatusAt < this.staleMs;
    return structuredClone({ ...d.state, online });
  }

  list(): DeviceState[] {
    return [...this.devices.values()].map((d) => this.snapshot(d));
  }

  get(id: string): DeviceState | undefined {
    const d = this.devices.get(id);
    return d ? this.snapshot(d) : undefined;
  }

  history(id: string, metric: Metric, minutes: number): HistoryPoint[] {
    const cutoff = Date.now() - minutes * 60_000;
    return (this.devices.get(id)?.history.get(metric) ?? []).filter((p) => Date.parse(p.t) >= cutoff);
  }

  async send(id: string, command: Command): Promise<CommandResult> {
    const d = this.devices.get(id);
    if (!d) return { ok: false, message: `No device with id "${id}".` };
    if (!this.snapshot(d).online) return { ok: false, message: `${id} is offline. Command not delivered.` };
    if (!this.client?.connected) return { ok: false, message: 'Not connected to the MQTT broker.' };

    const requestId = randomUUID();
    const reply = new Promise<{ ok: boolean; message: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, message: `${id} did not acknowledge the command within ${this.ackTimeoutMs / 1000}s.` });
      }, this.ackTimeoutMs);
      this.pending.set(requestId, (r) => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve(r);
      });
    });
    this.client.publish(`${this.prefix}/${id}/command`, JSON.stringify({ requestId, ...command }), { qos: 1 });
    const result = await reply;
    // The device publishes a fresh status after acting; wait briefly so the caller sees it.
    await new Promise((r) => setTimeout(r, 150));
    return { ...result, device: this.get(id) };
  }
}
