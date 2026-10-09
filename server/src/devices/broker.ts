import { Aedes } from 'aedes';
import net from 'node:net';

/**
 * Optional built-in MQTT broker (MQTT_EMBEDDED_BROKER=true), so ESP32s can connect
 * straight to this server without installing Mosquitto.
 *
 * It listens on all interfaces (devices must reach it), so when MQTT_USERNAME and
 * MQTT_PASSWORD are set every client — devices and this server — must log in with them.
 */
export async function startEmbeddedBroker(
  port = Number(process.env.MQTT_PORT ?? 1883),
): Promise<{ port: number; close: () => Promise<void> }> {
  const user = process.env.MQTT_USERNAME;
  const pass = process.env.MQTT_PASSWORD;
  const broker = await Aedes.createBroker(
    user && pass
      ? {
          authenticate: (_client, username, password, done) => {
            const ok = username === user && password?.toString() === pass;
            done(null, ok);
          },
        }
      : {},
  );
  if (!user || !pass)
    console.error('[iot-mcp] Built-in MQTT broker has no password. Set MQTT_USERNAME and MQTT_PASSWORD on shared networks.');
  const server = net.createServer(broker.handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
  const actual = (server.address() as net.AddressInfo).port;
  return {
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        broker.close(() => server.close(() => resolve()));
      }),
  };
}
