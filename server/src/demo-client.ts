/**
 * `npm run demo` — exercises the MCP server end to end with NO AI:
 * launches it over stdio, lists tools/resources/prompts, reads alerts,
 * turns the conference room fan up and shows CO2 responding.
 * Also a handy smoke test after changes.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fromSource = import.meta.url.endsWith('.ts');

const textOf = (r: any) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(fromSource ? ['--import', 'tsx'] : []), path.join(here, fromSource ? 'index.ts' : 'index.js'), '--mcp-only'],
    cwd: path.resolve(here, '..'),
    env: { ...process.env, SIM_TICK_MS: '500' } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'demo-client', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);
  const { resources } = await client.listResources();
  const { resourceTemplates } = await client.listResourceTemplates();
  console.log(
    `Resources: ${resources.map((r) => r.uri).join(', ')} | templates: ${resourceTemplates.map((t) => t.uriTemplate).join(', ')}`,
  );
  const { prompts } = await client.listPrompts();
  console.log(`Prompts: ${prompts.map((p) => p.name).join(', ')}\n`);

  console.log('Alerts:\n' + textOf(await client.callTool({ name: 'get_alerts', arguments: {} })) + '\n');

  const co2 = async () => {
    const r = JSON.parse(textOf(await client.callTool({ name: 'get_device_status', arguments: { device_id: 'aq-conf-01' } })));
    return r.readings.co2 as string;
  };
  console.log(`Conference Room A CO2 before: ${await co2()}`);
  console.log(
    textOf(await client.callTool({ name: 'set_fan_speed', arguments: { device_id: 'fan-conf-01', speed: 90, reason: 'demo' } })).split(
      '\n',
    )[2],
  );
  for (let i = 1; i <= 4; i++) {
    await sleep(1500);
    console.log(`  after ${i * 1.5}s: ${await co2()}`);
  }

  const bad = await client.callTool({ name: 'set_fan_speed', arguments: { device_id: 'pur-office-01', speed: 50 } });
  console.log(`\nWrong device type is rejected: isError=${bad.isError} → ${textOf(bad)}`);
  const offline = await client.callTool({ name: 'identify_device', arguments: { device_id: 'aq-store-01' } });
  console.log(`Offline device is rejected: isError=${offline.isError}`);

  const hist = JSON.parse(
    textOf(
      await client.callTool({
        name: 'get_sensor_history',
        arguments: { device_id: 'aq-office-01', metric: 'pm25', minutes: 360, max_points: 6 },
      }),
    ),
  );
  console.log(`\nOpen Office PM2.5, last 6h: min ${hist.min}, max ${hist.max}, avg ${hist.avg}, trend ${hist.trend}`);

  const res = await client.readResource({ uri: 'iot://devices/relay-lab-01' });
  console.log(`Resource iot://devices/relay-lab-01 → ${(res.contents[0] as { text: string }).text.split('\n').length} lines of JSON`);

  await client.close();
  console.log('\nDemo complete ✓');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
