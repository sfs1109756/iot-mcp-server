/**
 * `npm run sim:mqtt` — runs the simulated building as MQTT devices.
 *
 * Each simulated ESP32 publishes iot/<id>/status every few seconds, sets a Last Will on
 * iot/<id>/online, and obeys iot/<id>/command with an ack — exactly what real firmware does.
 * Lets you try DEVICE_ADAPTER=mqtt end to end without hardware.
 */
import './env.js';
import mqtt from 'mqtt';
import { pathToFileURL } from 'node:url';
import { SimulatedAdapter } from './devices/simulator.js';
import type { Command } from './devices/types.js';

export async function runMqttSimulator(
  url = process.env.MQTT_URL ?? 'mqtt://localhost:1883',
  prefix = process.env.MQTT_TOPIC_PREFIX ?? 'iot',
  everyMs = 3000,
) {
  const sim = new SimulatedAdapter();
  await sim.start();
  const clients = sim.list().map((d) => {
    const client = mqtt.connect(url, {
      clientId: `sim-${d.id}`,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
      will: { topic: `${prefix}/${d.id}/online`, payload: Buffer.from('false'), retain: true, qos: 1 },
    });
    const publish = () => {
      const state = sim.get(d.id);
      if (!state?.online) return; // offline devices stay silent, like a dead ESP32
      const { id: _id, online: _online, lastSeen: _seen, ...status } = state;
      client.publish(`${prefix}/${d.id}/status`, JSON.stringify(status), { retain: true });
    };
    client.on('connect', () => {
      const state = sim.get(d.id);
      client.publish(`${prefix}/${d.id}/online`, state?.online ? 'true' : 'false', { retain: true });
      client.subscribe(`${prefix}/${d.id}/command`);
      publish();
    });
    client.on('message', async (_topic, payload) => {
      let cmd: Command & { requestId?: string };
      try {
        cmd = JSON.parse(payload.toString());
      } catch {
        return;
      }
      const { requestId, ...command } = cmd;
      const result = await sim.send(d.id, command as Command);
      client.publish(`${prefix}/${d.id}/ack`, JSON.stringify({ requestId, ok: result.ok, message: result.message }));
      publish();
    });
    const timer = setInterval(publish, everyMs);
    return { client, timer };
  });
  return {
    sim,
    stop: () => {
      sim.stop();
      for (const c of clients) {
        clearInterval(c.timer);
        c.client.end(true);
      }
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMqttSimulator().then(() => console.error('[sim] Simulated devices publishing over MQTT. Ctrl+C to stop.'));
}
