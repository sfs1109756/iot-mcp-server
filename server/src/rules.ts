import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activity } from './activity.js';
import type { Command, DeviceAdapter, Metric } from './devices/types.js';

/**
 * Automation rules: "when <device metric> <op> <value> for N seconds, send <command>",
 * with an optional command to run when the condition clears.
 *
 * Rules fire on the transition into the condition (not on every tick), and again only after
 * the condition has cleared — so a fan isn't re-commanded every 2 seconds. Rules are saved to
 * data/rules.json and can be managed from the dashboard or by an AI through MCP tools.
 */

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  when: { deviceId: string; metric: Metric; op: '>' | '<'; value: number; forSeconds: number };
  then: { deviceId: string; command: Command };
  /** Optional: what to do once the condition is no longer true (e.g. fan back to 20%). */
  onClear?: { deviceId: string; command: Command };
  createdBy: 'dashboard' | 'mcp' | 'agent' | 'default';
  lastFiredAt?: string;
}

export type NewRule = Omit<Rule, 'id' | 'lastFiredAt' | 'enabled'> & { enabled?: boolean };

interface RuntimeState {
  since: number | null; // when the condition became true
  active: boolean; // fired and not yet cleared
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(here, '../data/rules.json');

const DEFAULT_RULES: Rule[] = [
  {
    id: 'example-ventilate-conference',
    name: 'Ventilate Conference Room A when CO₂ is high',
    enabled: false,
    when: { deviceId: 'aq-conf-01', metric: 'co2', op: '>', value: 1000, forSeconds: 30 },
    then: { deviceId: 'fan-conf-01', command: { type: 'set_fan_speed', speed: 80 } },
    onClear: { deviceId: 'fan-conf-01', command: { type: 'set_fan_speed', speed: 30 } },
    createdBy: 'default',
  },
];

export function describeCommand(c: Command): string {
  switch (c.type) {
    case 'set_fan_speed':
      return `set fan to ${c.speed}%`;
    case 'set_purifier_mode':
      return `set purifier to ${c.mode}`;
    case 'set_relay':
      return `switch relay ${c.on ? 'on' : 'off'}`;
    case 'identify':
      return 'blink LED';
  }
}

export function describeRule(r: Rule): string {
  const w = r.when;
  return `When ${w.deviceId} ${w.metric} ${w.op} ${w.value}${w.forSeconds ? ` for ${w.forSeconds}s` : ''} → ${r.then.deviceId}: ${describeCommand(r.then.command)}${
    r.onClear ? `; when it clears → ${r.onClear.deviceId}: ${describeCommand(r.onClear.command)}` : ''
  }`;
}

export class RuleEngine extends EventEmitter {
  private rules: Rule[] = [];
  private state = new Map<string, RuntimeState>();
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly adapter: DeviceAdapter,
    private readonly file = process.env.RULES_FILE ?? DEFAULT_FILE,
  ) {
    super();
    this.load();
  }

  private load() {
    try {
      this.rules = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Rule[];
    } catch {
      this.rules = structuredClone(DEFAULT_RULES);
    }
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.rules, null, 2));
    } catch (err) {
      console.error('[iot-mcp] Could not save rules:', (err as Error).message);
    }
    this.emit('change', this.list());
  }

  start(everyMs = 2000) {
    this.timer = setInterval(() => void this.evaluate(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  list(): (Rule & { description: string; active: boolean })[] {
    return this.rules.map((r) => ({ ...r, description: describeRule(r), active: this.state.get(r.id)?.active ?? false }));
  }

  /** Validates devices and command types against what's actually there. */
  validate(rule: NewRule): string | null {
    const sensor = this.adapter.get(rule.when.deviceId);
    if (!sensor) return `No device "${rule.when.deviceId}".`;
    if (sensor.readings[rule.when.metric] === undefined) return `${rule.when.deviceId} doesn't report ${rule.when.metric}.`;
    for (const action of [rule.then, rule.onClear].filter(Boolean) as { deviceId: string; command: Command }[]) {
      const target = this.adapter.get(action.deviceId);
      if (!target) return `No device "${action.deviceId}".`;
      const needs = { set_fan_speed: 'ventilation_fan', set_purifier_mode: 'air_purifier', set_relay: 'relay', identify: null }[
        action.command.type
      ];
      if (needs && target.kind !== needs) return `${action.deviceId} is a ${target.kind}, it can't ${describeCommand(action.command)}.`;
    }
    return null;
  }

  create(input: NewRule): Rule {
    const error = this.validate(input);
    if (error) throw new Error(error);
    const base =
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'rule';
    let id = base;
    for (let n = 2; this.rules.some((r) => r.id === id); n++) id = `${base}-${n}`;
    const rule: Rule = { ...input, id, enabled: input.enabled ?? true };
    this.rules.push(rule);
    this.save();
    return rule;
  }

  setEnabled(id: string, enabled: boolean): Rule {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`No rule "${id}".`);
    rule.enabled = enabled;
    if (!enabled) this.state.delete(id);
    this.save();
    return rule;
  }

  remove(id: string): void {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) throw new Error(`No rule "${id}".`);
    this.state.delete(id);
    this.save();
  }

  /** One evaluation pass. Exposed for tests. */
  async evaluate(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const rule of this.rules) {
        if (!rule.enabled) continue;
        const st = this.state.get(rule.id) ?? { since: null, active: false };
        this.state.set(rule.id, st);
        const sensor = this.adapter.get(rule.when.deviceId);
        const value = sensor?.online ? sensor.readings[rule.when.metric] : undefined;
        if (value === undefined) continue; // no data: hold current state

        const met = rule.when.op === '>' ? value > rule.when.value : value < rule.when.value;
        if (met) {
          st.since ??= now;
          if (!st.active && now - st.since >= rule.when.forSeconds * 1000) {
            st.active = true;
            rule.lastFiredAt = new Date(now).toISOString();
            await this.run(rule, rule.then, `${rule.when.metric} ${value} ${rule.when.op} ${rule.when.value}`);
            this.save();
          }
        } else {
          st.since = null;
          if (st.active) {
            st.active = false;
            if (rule.onClear) await this.run(rule, rule.onClear, `${rule.when.metric} back to ${value}`);
            this.emit('change', this.list());
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async run(rule: Rule, action: { deviceId: string; command: Command }, why: string) {
    const result = await this.adapter.send(action.deviceId, action.command);
    activity.add({ source: 'rule', action: action.command.type, ok: result.ok, detail: `${rule.name}: ${result.message} (${why})` });
  }
}
