import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { activity } from './activity.js';
import type { Command, CommandResult, DeviceAdapter, DeviceState, Metric } from './devices/types.js';
import { createMcpServer } from './mcp.js';
import { RuleEngine } from './rules.js';

/** A tiny controllable fake fleet: one CO2 sensor and one fan. */
function fakeFleet() {
  let co2 = 600;
  const sent: { id: string; command: Command }[] = [];
  const devices = (): DeviceState[] => [
    {
      id: 'aq',
      name: 'Monitor',
      kind: 'air_monitor',
      room: 'Room',
      firmware: '1',
      online: true,
      lastSeen: '',
      readings: { co2 },
      actuators: {},
      meta: {},
    },
    {
      id: 'fan',
      name: 'Fan',
      kind: 'ventilation_fan',
      room: 'Room',
      firmware: '1',
      online: true,
      lastSeen: '',
      readings: {},
      actuators: { fanSpeed: 20 },
      meta: {},
    },
  ];
  const adapter: DeviceAdapter = {
    name: 'fake',
    start: async () => {},
    stop: () => {},
    list: devices,
    get: (id) => devices().find((d) => d.id === id),
    history: (_id: string, _m: Metric) => [],
    send: async (id, command): Promise<CommandResult> => {
      sent.push({ id, command });
      return { ok: true, message: `${id}: ${command.type}` };
    },
  };
  return { adapter, sent, setCo2: (v: number) => (co2 = v) };
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rules-')), 'rules.json');

test('fires once after the hold time, then runs the clear action', async () => {
  const { adapter, sent, setCo2 } = fakeFleet();
  const engine = new RuleEngine(adapter, tmpFile());
  engine.create({
    name: 'Ventilate',
    when: { deviceId: 'aq', metric: 'co2', op: '>', value: 1000, forSeconds: 30 },
    then: { deviceId: 'fan', command: { type: 'set_fan_speed', speed: 80 } },
    onClear: { deviceId: 'fan', command: { type: 'set_fan_speed', speed: 20 } },
    createdBy: 'dashboard',
  });

  setCo2(1200);
  await engine.evaluate(0);
  await engine.evaluate(20_000);
  assert.equal(sent.length, 0, 'must wait for the hold time');
  await engine.evaluate(31_000);
  await engine.evaluate(40_000);
  assert.deepEqual(sent, [{ id: 'fan', command: { type: 'set_fan_speed', speed: 80 } }], 'fires exactly once');

  setCo2(700);
  await engine.evaluate(50_000);
  assert.deepEqual(sent.at(-1), { id: 'fan', command: { type: 'set_fan_speed', speed: 20 } });
  assert.ok(activity.recent().some((a) => a.source === 'rule'));
});

test('rejects rules that point at the wrong device type and persists valid ones', () => {
  const { adapter } = fakeFleet();
  const file = tmpFile();
  const engine = new RuleEngine(adapter, file);
  assert.throws(
    () =>
      engine.create({
        name: 'Bad',
        when: { deviceId: 'aq', metric: 'co2', op: '>', value: 1000, forSeconds: 0 },
        then: { deviceId: 'aq', command: { type: 'set_fan_speed', speed: 80 } },
        createdBy: 'dashboard',
      }),
    /can't set fan/,
  );
  const ok = engine.create({
    name: 'Good one',
    when: { deviceId: 'aq', metric: 'co2', op: '>', value: 900, forSeconds: 0 },
    then: { deviceId: 'fan', command: { type: 'set_fan_speed', speed: 60 } },
    createdBy: 'dashboard',
  });
  const reloaded = new RuleEngine(adapter, file);
  assert.ok(reloaded.list().some((r) => r.id === ok.id && r.enabled));
});

test('an AI can manage rules through MCP tools', async () => {
  const { adapter } = fakeFleet();
  const engine = new RuleEngine(adapter, tmpFile());
  const server = createMcpServer(adapter, 'mcp', engine);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(b);
  await client.connect(a);

  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['list_rules', 'create_rule', 'set_rule_enabled', 'delete_rule']) assert.ok(names.includes(n), n);

  const created = await client.callTool({
    name: 'create_rule',
    arguments: {
      name: 'CO2 guard',
      sensor_device_id: 'aq',
      metric: 'co2',
      op: '>',
      value: 1000,
      target_device_id: 'fan',
      action: 'set_fan_speed',
      speed: 80,
      clear_speed: 20,
    },
  });
  assert.ok(!created.isError, JSON.stringify(created.content));
  const rule = engine.list().find((r) => r.name === 'CO2 guard')!;
  assert.equal(rule.onClear?.command.type, 'set_fan_speed');
  assert.equal(rule.when.forSeconds, 30, 'default hold time');

  const missing = await client.callTool({
    name: 'create_rule',
    arguments: {
      name: 'x y z',
      sensor_device_id: 'aq',
      metric: 'co2',
      op: '>',
      value: 1,
      target_device_id: 'fan',
      action: 'set_fan_speed',
    },
  });
  assert.equal(missing.isError, true);

  await client.callTool({ name: 'set_rule_enabled', arguments: { rule_id: rule.id, enabled: false } });
  assert.equal(engine.list().find((r) => r.id === rule.id)?.enabled, false);
  await client.close();
});
