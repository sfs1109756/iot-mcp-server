import { Aedes } from 'aedes';
import net from 'node:net';

/**
 * Optional built-in MQTT broker (MQTT_EMBEDDED_BROKER=true), so ESP32s can connect
 * straight to this server without installing Mosquitto.
 */
export async function startEmbeddedBroker(port = Number(process.env.MQTT_PORT ?? 1883)): Promise<{ port: number; close: () => Promise<void> }> {
  const broker = await Aedes.createBroker();
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
