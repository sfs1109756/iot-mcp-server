/**
 * Talk to your devices from the terminal with a local model:
 *
 *   npm run agent -- "The conference room feels stuffy, can you fix it?"
 *   npm run agent            (interactive)
 *
 * Connects to the running dashboard's HTTP MCP endpoint if it's up (so you can watch
 * changes live in the browser); otherwise it launches its own MCP server over stdio.
 */
import './env.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runAgent, type AgentEvent } from './agent.js';
import { getModel, getProvider } from './llm.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3003);
/** Sends AUTH_TOKEN when the server requires one. */
const authHeaders = (): RequestInit => (process.env.AUTH_TOKEN ? { headers: { authorization: `Bearer ${process.env.AUTH_TOKEN}` } } : {});
const c = { dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m', reset: '\x1b[0m' };

async function connect(): Promise<{ client: Client; via: string }> {
  const client = new Client({ name: 'iot-cli-agent', version: '1.0.0' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: authHeaders() });
    await client.connect(transport);
    return { client, via: `HTTP (http://localhost:${port}/mcp — watch the dashboard!)` };
  } catch {
    const fromSource = import.meta.url.endsWith('.ts');
    const entry = path.join(here, fromSource ? 'index.ts' : 'index.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...(fromSource ? ['--import', 'tsx'] : []), entry, '--mcp-only'],
      cwd: path.resolve(here, '..'),
      stderr: 'ignore',
    });
    const stdioClient = new Client({ name: 'iot-cli-agent', version: '1.0.0' });
    await stdioClient.connect(transport);
    return { client: stdioClient, via: 'stdio (own simulator — start `npm run dev` to share the dashboard)' };
  }
}

function print(e: AgentEvent) {
  if (e.type === 'tool_call') console.log(`${c.cyan}→ ${e.name}${c.reset} ${c.dim}${JSON.stringify(e.args)}${c.reset}`);
  if (e.type === 'tool_result')
    console.log(`${e.ok ? c.green + '  ✓' : c.red + '  ✗'} ${c.dim}${e.preview.replace(/\s+/g, ' ').slice(0, 140)}${c.reset}`);
  if (e.type === 'answer') console.log(`\n${c.bold}${e.text}${c.reset}\n`);
}

async function main() {
  const { client, via } = await connect();
  console.log(`${c.dim}Model: ${getProvider()} · ${getModel()} | MCP via ${via}${c.reset}`);

  const question = process.argv.slice(2).join(' ').trim();
  try {
    if (question) {
      await runAgent(client, question, print);
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log('Ask about your devices (empty line to quit). Try: "Run a health check and fix what you can."');
      for (;;) {
        const q = (await rl.question('> ')).trim();
        if (!q) break;
        await runAgent(client, q, print).catch((err) => console.error(`${c.red}${(err as Error).message}${c.reset}`));
      }
      rl.close();
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`${c.red}${(err as Error).message}${c.reset}`);
  process.exit(1);
});
