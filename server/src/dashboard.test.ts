import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDashboard } from './dashboard.js';
import { SimulatedAdapter } from './devices/simulator.js';

/** Dashboard API + HTTP MCP endpoint, with AUTH_TOKEN protection. */
const sim = new SimulatedAdapter();
let base = '';
let server: http.Server;

before(async () => {
  await sim.start();
  server = http.createServer(createDashboard(sim, undefined, 's3cret'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  sim.stop();
  server.close();
});

const auth = { authorization: 'Bearer s3cret' };

test('health stays public; everything else needs the token', async () => {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const denied = await fetch(`${base}/api/devices`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).needsToken, true);
  assert.equal((await fetch(`${base}/api/devices`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(`${base}/api/devices`, { headers: auth });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).devices.length, 7);
});

test('manual commands work with the token', async () => {
  const res = await fetch(`${base}/api/devices/relay-lab-01/command`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'set_relay', on: true }),
  });
  assert.equal(res.status, 200);
  assert.equal(sim.get('relay-lab-01')?.actuators.relayOn, true);
});

test('the live stream accepts the token as a query parameter', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/stream?token=s3cret`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: devices/);
  controller.abort();
});

test('HTTP MCP endpoint requires the token', async () => {
  const anonymous = new Client({ name: 'anon', version: '1' });
  await assert.rejects(anonymous.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))));

  const client = new Client({ name: 'authed', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth } }));
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 9);
  await client.close();
});
