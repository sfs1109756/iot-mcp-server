import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runMqttSimulator } from '../mqtt-sim.js';
import { startEmbeddedBroker } from './broker.js';
import { MqttAdapter } from './mqtt.js';

/** Full MQTT round trip: embedded broker ⇄ simulated ESP32s ⇄ MqttAdapter. */
let broker: Awaited<ReturnType<typeof startEmbeddedBroker>>;
let sim: Awaited<ReturnType<typeof runMqttSimulator>>;
let adapter: MqttAdapter;

before(async () => {
  broker = await startEmbeddedBroker(0);
  const url = `mqtt://127.0.0.1:${broker.port}`;
  sim = await runMqttSimulator(url, 'test', 500);
  process.env.MQTT_ACK_TIMEOUT_MS = '3000';
  adapter = new MqttAdapter(url, 'test');
  await adapter.start();
  // Wait until every online simulated device has reported.
  for (let i = 0; i < 40 && adapter.list().filter((d) => d.online).length < 6; i++) await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  adapter.stop();
  sim.stop();
  await broker.close();
});

test('devices report status over MQTT; the dead one stays offline', () => {
  const devices = adapter.list();
  assert.equal(devices.filter((d) => d.online).length, 6);
  const conf = adapter.get('aq-conf-01')!;
  assert.equal(conf.room, 'Conference Room A');
  assert.ok((conf.readings.co2 ?? 0) > 400);
  assert.equal(adapter.get('aq-store-01')?.online ?? false, false);
});

test('commands are delivered and acknowledged', async () => {
  const ok = await adapter.send('fan-conf-01', { type: 'set_fan_speed', speed: 75 });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(sim.sim.get('fan-conf-01')?.actuators.fanSpeed, 75);
  assert.equal(ok.device?.actuators.fanSpeed, 75);

  const wrong = await adapter.send('pur-office-01', { type: 'set_fan_speed', speed: 10 });
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /not a ventilation fan/);
});
