import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeAlerts } from './alerts.js';
import { SimulatedAdapter } from './simulator.js';

test('simulator starts with the demo problems and history', async () => {
  const sim = new SimulatedAdapter();
  await sim.start();
  try {
    const alerts = computeAlerts(sim.list());
    const text = alerts.map((a) => a.message).join('\n');
    assert.match(text, /CO₂ is (very high|elevated) in Conference Room A/);
    assert.match(text, /PM2\.5 is elevated in Open Office/);
    assert.match(text, /TVOC .* R&D Lab/);
    assert.match(text, /aq-store-01 is offline/);
    assert.match(text, /battery is low/);
    assert.ok(sim.history('aq-conf-01', 'co2', 360).length > 300, 'expected ~6h of back-filled history');
  } finally {
    sim.stop();
  }
});

test('commands are validated against the device type and online state', async () => {
  const sim = new SimulatedAdapter();
  await sim.start();
  try {
    assert.equal((await sim.send('fan-conf-01', { type: 'set_fan_speed', speed: 80 })).ok, true);
    assert.equal(sim.get('fan-conf-01')?.actuators.fanSpeed, 80);
    assert.equal((await sim.send('pur-office-01', { type: 'set_fan_speed', speed: 80 })).ok, false);
    assert.equal((await sim.send('aq-store-01', { type: 'identify' })).ok, false);
    assert.equal((await sim.send('nope', { type: 'identify' })).ok, false);
  } finally {
    sim.stop();
  }
});
