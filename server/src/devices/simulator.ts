import type {
  Actuators,
  Command,
  CommandResult,
  DeviceAdapter,
  DeviceKind,
  DeviceState,
  HistoryPoint,
  Metric,
  PurifierMode,
} from './types.js';

/**
 * A small physics-ish simulation of a building with ESP32 devices.
 *
 * Rooms hold the "true" air. Monitors read it (with noise). Actuators change it:
 *  - the ventilation fan pulls CO2 down in Conference Room A
 *  - the air purifier removes PM2.5/PM10 in the Open Office
 *  - the exhaust relay clears solvent TVOC in the R&D Lab
 *
 * The starting state is deliberately "problematic" (stuffy meeting, hazy office,
 * a solvent spill in the lab, a low battery, an offline sensor) so an AI agent has
 * something real to diagnose and fix — and you can watch the numbers respond.
 */

interface Room {
  name: string;
  occupancy: number; // 0..1
  baseOccupancy: number;
  co2: number;
  pm25: number;
  tvoc: number;
  temperature: number;
  humidity: number;
  outdoorPm: number;
  baseVent: number; // HVAC fresh-air share 0..1
  solventLeft: number; // seconds of an active solvent event
}

interface SimDevice {
  state: DeviceState;
  room: string;
  history: Map<Metric, HistoryPoint[]>;
}

const HISTORY_MAX_MIN = 24 * 60;
const TICK_MS = Number(process.env.SIM_TICK_MS ?? 3000);
const HISTORY_EVERY_MS = 30_000;
/** Live simulation runs faster than real time so you can see devices take effect within ~30s. */
const SIM_SPEED = Number(process.env.SIM_SPEED ?? 5);

const PURIFIER_EFFECT: Record<PurifierMode, number> = { off: 0, low: 0.35, medium: 0.55, high: 0.8, auto: 0 };

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential approach of `x` toward `target` with time constant `tau` seconds. */
const approach = (x: number, target: number, dt: number, tau: number) => x + (target - x) * (1 - Math.exp(-dt / tau));
const round1 = (v: number) => Math.round(v * 10) / 10;

export class SimulatedAdapter implements DeviceAdapter {
  readonly name = 'simulator';
  private rand = mulberry32(42);
  private rooms = new Map<string, Room>();
  private devices = new Map<string, SimDevice>();
  private timer?: NodeJS.Timeout;
  private lastHistoryAt = 0;

  constructor() {
    const room = (name: string, r: Partial<Room>): Room => ({
      name,
      occupancy: 0.5,
      co2: 600,
      pm25: 12,
      tvoc: 150,
      temperature: 24,
      humidity: 52,
      outdoorPm: 55,
      baseVent: 0.25,
      solventLeft: 0,
      ...r,
      baseOccupancy: r.occupancy ?? 0.5,
    });
    for (const r of [
      room('Conference Room A', { occupancy: 0.9, co2: 1250, baseVent: 0.1, outdoorPm: 22 }),
      room('Open Office', { occupancy: 0.6, pm25: 30, co2: 820 }),
      room('R&D Lab', { occupancy: 0.4, tvoc: 900, solventLeft: 20 * 60, outdoorPm: 20 }),
      room('Storage', { occupancy: 0, co2: 450, outdoorPm: 20 }),
    ]) {
      this.rooms.set(r.name, r);
    }

    const add = (
      id: string,
      name: string,
      kind: DeviceKind,
      roomName: string,
      actuators: Actuators = {},
      meta: DeviceState['meta'] = {},
      online = true,
    ) => {
      this.devices.set(id, {
        room: roomName,
        history: new Map(),
        state: {
          id,
          name,
          kind,
          room: roomName,
          firmware: '1.4.2',
          online,
          lastSeen: new Date(online ? Date.now() : Date.now() - 3 * 3600_000).toISOString(),
          readings: {},
          actuators,
          meta,
        },
      });
    };

    add('aq-conf-01', 'SafeAir Monitor', 'air_monitor', 'Conference Room A', {}, { powered: 'mains' });
    add('aq-office-01', 'SafeAir Monitor', 'air_monitor', 'Open Office', {}, { powered: 'mains' });
    add('aq-lab-01', 'SafeAir Monitor (battery)', 'air_monitor', 'R&D Lab', {}, { powered: 'battery' });
    add('aq-store-01', 'SafeAir Monitor', 'air_monitor', 'Storage', {}, { powered: 'mains' }, false);
    add('fan-conf-01', 'Ventilation Fan Controller', 'ventilation_fan', 'Conference Room A', { fanSpeed: 20 });
    add('pur-office-01', 'Air Purifier Controller', 'air_purifier', 'Open Office', { purifierMode: 'off' }, { filterLifePct: 64 });
    add('relay-lab-01', 'Exhaust Fan Relay', 'relay', 'R&D Lab', { relayOn: false }, { load: 'Fume exhaust fan' });

    this.devices.get('aq-lab-01')!.state.readings.battery = 19;
  }

  async start(): Promise<void> {
    // Back-fill 6 hours of history at 1-minute steps so charts have context immediately.
    // The demo problems develop naturally: the busy meeting room fills with CO2 because the fan
    // is at 20%, the office gets hazy with the purifier off, and a solvent spill starts in the lab.
    const now = Date.now();
    this.rewindRooms();
    const lab = this.rooms.get('R&D Lab')!;
    for (let t = now - 6 * 3600_000; t <= now; t += 60_000) {
      if (t >= now - 25 * 60_000 && t < now - 24 * 60_000) lab.solventLeft = 40 * 60;
      this.step(60, t, true);
    }
    this.timer = setInterval(() => this.step((TICK_MS / 1000) * SIM_SPEED, Date.now(), false), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Puts rooms into a calmer state for the back-filled past, so history shows things getting worse. */
  private rewindRooms() {
    for (const r of this.rooms.values()) {
      r.co2 = 480;
      r.pm25 = 10;
      r.tvoc = 140;
      r.solventLeft = 0;
    }
  }

  private step(dt: number, at: number, backfill: boolean) {
    const rnd = this.rand;
    dt = Math.max(dt, 0.001);
    const fan = this.devices.get('fan-conf-01')!.state.actuators;
    const purifier = this.devices.get('pur-office-01')!.state.actuators;
    const relay = this.devices.get('relay-lab-01')!.state.actuators;

    for (const r of this.rooms.values()) {
      // Occupancy drifts a little.
      r.occupancy = Math.max(0, Math.min(1, approach(r.occupancy, r.baseOccupancy, dt, 900) + (rnd() - 0.5) * 0.01 * Math.sqrt(dt)));
      if (r.name === 'Storage') r.occupancy = 0;

      // Ventilation.
      let vent = r.baseVent;
      if (r.name === 'Conference Room A') vent += ((fan.fanSpeed ?? 0) / 100) * 0.85;
      if (r.name === 'R&D Lab' && relay.relayOn) vent += 0.4;
      vent = Math.min(vent, 1);

      const co2Target = 420 + (r.occupancy * 1500) * (1 - vent * 0.8);
      r.co2 = approach(r.co2, co2Target, dt, 420 / (1 + vent * 4)) + (rnd() - 0.5) * 6;

      // Particles: outdoor infiltration + people, minus purifier.
      let mode = r.name === 'Open Office' ? purifier.purifierMode ?? 'off' : 'off';
      let eff = PURIFIER_EFFECT[mode];
      if (mode === 'auto') eff = r.pm25 > 25 ? 0.8 : r.pm25 > 12 ? 0.55 : 0.35;
      const pmTarget = (r.outdoorPm * 0.45 + r.occupancy * 8) * (1 - eff);
      r.pm25 = approach(r.pm25, pmTarget, dt, 360 / (1 + eff * 4)) + (rnd() - 0.5) * 0.6;

      // TVOC: solvent events in the lab.
      if (r.name === 'R&D Lab' && !backfill && r.solventLeft <= 0 && rnd() < 0.0004 * dt) r.solventLeft = 15 * 60;
      const solvent = r.solventLeft > 0 ? 1100 : 0;
      r.solventLeft = Math.max(0, r.solventLeft - dt);
      const tvocTarget = (120 + r.occupancy * 200 + solvent) * (r.name === 'R&D Lab' && relay.relayOn ? 0.25 : 1);
      r.tvoc = approach(r.tvoc, tvocTarget, dt, r.name === 'R&D Lab' && relay.relayOn ? 90 : 300) + (rnd() - 0.5) * 8;

      r.temperature = approach(r.temperature, 23 + r.occupancy * 2.5 - vent * 1.2, dt, 900) + (rnd() - 0.5) * 0.05;
      r.humidity = approach(r.humidity, 50 + r.occupancy * 8, dt, 900) + (rnd() - 0.5) * 0.2;
    }

    const recordHistory = backfill || at - this.lastHistoryAt >= HISTORY_EVERY_MS;
    if (recordHistory) this.lastHistoryAt = at;
    const iso = new Date(at).toISOString();

    for (const d of this.devices.values()) {
      const s = d.state;
      if (!s.online) continue;
      s.lastSeen = iso;
      s.readings.rssi = Math.round(-55 - rnd() * 20);
      if (s.kind === 'air_monitor') {
        const r = this.rooms.get(d.room)!;
        s.readings.co2 = Math.round(Math.max(400, r.co2 + (rnd() - 0.5) * 15));
        s.readings.pm25 = round1(Math.max(0.5, r.pm25 + (rnd() - 0.5) * 1.2));
        s.readings.pm10 = round1(Math.max(1, r.pm25 * 1.45 + (rnd() - 0.5) * 2));
        s.readings.tvoc = Math.round(Math.max(20, r.tvoc + (rnd() - 0.5) * 20));
        s.readings.temperature = round1(r.temperature);
        s.readings.humidity = round1(r.humidity);
        if (s.meta.powered === 'battery') {
          s.readings.battery = round1(Math.max(1, (s.readings.battery ?? 100) - 0.0004 * dt));
        }
      }
      if (s.kind === 'air_purifier' && s.actuators.purifierMode !== 'off') {
        s.meta.filterLifePct = round1(Math.max(0, Number(s.meta.filterLifePct) - 0.00005 * dt));
      }
      if (s.meta.identifyUntil && Number(s.meta.identifyUntil) < at) delete s.meta.identifyUntil;

      if (recordHistory) {
        for (const [metric, value] of Object.entries(s.readings) as [Metric, number][]) {
          const arr = d.history.get(metric) ?? [];
          arr.push({ t: iso, v: value });
          const cutoff = at - HISTORY_MAX_MIN * 60_000;
          while (arr.length && Date.parse(arr[0].t) < cutoff) arr.shift();
          d.history.set(metric, arr);
        }
      }
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
    const d = this.devices.get(id);
    if (!d) return [];
    const cutoff = Date.now() - minutes * 60_000;
    return (d.history.get(metric) ?? []).filter((p) => Date.parse(p.t) >= cutoff);
  }

  async send(id: string, command: Command): Promise<CommandResult> {
    const d = this.devices.get(id);
    if (!d) return { ok: false, message: `No device with id "${id}".` };
    const s = d.state;
    if (!s.online) return { ok: false, message: `${id} is offline (last seen ${s.lastSeen}). Command not delivered.` };

    // Simulated network latency, like a real ESP32 round-trip.
    await new Promise((r) => setTimeout(r, 120 + this.rand() * 200));

    switch (command.type) {
      case 'set_fan_speed':
        if (s.kind !== 'ventilation_fan') return { ok: false, message: `${id} is not a ventilation fan (its type is "${s.kind}").` };
        s.actuators.fanSpeed = command.speed;
        return { ok: true, message: `Fan ${id} set to ${command.speed}%.`, device: this.get(id) };
      case 'set_purifier_mode':
        if (s.kind !== 'air_purifier') return { ok: false, message: `${id} is not an air purifier (its type is "${s.kind}").` };
        s.actuators.purifierMode = command.mode;
        return { ok: true, message: `Purifier ${id} set to "${command.mode}".`, device: this.get(id) };
      case 'set_relay':
        if (s.kind !== 'relay') return { ok: false, message: `${id} is not a relay (its type is "${s.kind}").` };
        s.actuators.relayOn = command.on;
        return { ok: true, message: `Relay ${id} switched ${command.on ? 'ON' : 'OFF'} (${s.meta.load ?? 'load'}).`, device: this.get(id) };
      case 'identify':
        s.meta.identifyUntil = Date.now() + 10_000;
        return { ok: true, message: `${id} is blinking its LED for 10 seconds.`, device: this.get(id) };
    }
  }
}
