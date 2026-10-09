import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, CommandResult, DeviceAdapter, DeviceState, HistoryPoint, Metric } from './types.js';

/**
 * Talks to real ESP32 devices over the local network.
 *
 * Each device runs the sketch in /firmware and exposes:
 *   GET  http://<ip>/status   → { name, kind, room, firmware, readings, actuators, meta }
 *   POST http://<ip>/command  ← { type: 'set_fan_speed', speed: 60 } etc.
 *
 * List devices in a JSON file (DEVICES_FILE, default ./devices.json):
 *   [{ "id": "aq-conf-01", "baseUrl": "http://192.168.1.41" }]
 */

interface DeviceConfig {
  id: string;
  baseUrl: string;
}

interface Tracked {
  config: DeviceConfig;
  state: DeviceState;
  failures: number;
  history: Map<Metric, HistoryPoint[]>;
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLL_MS = Number(process.env.POLL_MS ?? 5000);
const HISTORY_MAX_MS = 24 * 3600_000;

export class Esp32HttpAdapter implements DeviceAdapter {
  readonly name = 'esp32-http';
  private devices = new Map<string, Tracked>();
  private timer?: NodeJS.Timeout;

  constructor(file = path.resolve(serverDir, process.env.DEVICES_FILE ?? 'devices.json')) {
    if (!fs.existsSync(file)) {
      throw new Error(`DEVICE_ADAPTER=http needs a devices file. Create ${file} (see devices.example.json).`);
    }
    const configs = JSON.parse(fs.readFileSync(file, 'utf8')) as DeviceConfig[];
    for (const c of configs) {
      this.devices.set(c.id, {
        config: { id: c.id, baseUrl: c.baseUrl.replace(/\/+$/, '') },
        failures: 0,
        history: new Map(),
        state: {
          id: c.id,
          name: c.id,
          kind: 'air_monitor',
          room: 'Unknown',
          firmware: '?',
          online: false,
          lastSeen: new Date(0).toISOString(),
          readings: {},
          actuators: {},
          meta: {},
        },
      });
    }
  }

  async start(): Promise<void> {
    await this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async pollAll(): Promise<void> {
    await Promise.all([...this.devices.values()].map((d) => this.poll(d)));
  }

  private async poll(d: Tracked): Promise<void> {
    try {
      const res = await fetch(`${d.config.baseUrl}/status`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<DeviceState>;
      const now = new Date().toISOString();
      d.state = {
        ...d.state,
        name: body.name ?? d.state.name,
        kind: body.kind ?? d.state.kind,
        room: body.room ?? d.state.room,
        firmware: body.firmware ?? d.state.firmware,
        readings: body.readings ?? {},
        actuators: body.actuators ?? {},
        meta: body.meta ?? {},
        online: true,
        lastSeen: now,
      };
      d.failures = 0;
      for (const [metric, value] of Object.entries(d.state.readings) as [Metric, number][]) {
        if (typeof value !== 'number') continue;
        const arr = d.history.get(metric) ?? [];
        arr.push({ t: now, v: value });
        while (arr.length && Date.now() - Date.parse(arr[0].t) > HISTORY_MAX_MS) arr.shift();
        d.history.set(metric, arr);
      }
    } catch {
      d.failures++;
      if (d.failures >= 3) d.state.online = false;
    }
  }

  list(): DeviceState[] {
    return [...this.devices.values()].map((d) => structuredClone(d.state));
  }

  get(id: string): DeviceState | undefined {
    const d = this.devices.get(id);
    return d ? structuredClone(d.state) : undefined;
  }

  history(id: string, metric: Metric, minutes: number): HistoryPoint[] {
    const cutoff = Date.now() - minutes * 60_000;
    return (this.devices.get(id)?.history.get(metric) ?? []).filter((p) => Date.parse(p.t) >= cutoff);
  }

  async send(id: string, command: Command): Promise<CommandResult> {
    const d = this.devices.get(id);
    if (!d) return { ok: false, message: `No device with id "${id}".` };
    if (!d.state.online) return { ok: false, message: `${id} is offline. Command not delivered.` };
    try {
      const res = await fetch(`${d.config.baseUrl}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(5000),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      await this.poll(d);
      return {
        ok: res.ok && body.ok !== false,
        message: body.message ?? (res.ok ? 'Command accepted.' : `Device returned HTTP ${res.status}.`),
        device: this.get(id),
      };
    } catch (err) {
      return { ok: false, message: `Could not reach ${id}: ${(err as Error).message}` };
    }
  }
}
