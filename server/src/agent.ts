import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getModel, getProvider, LLMUnavailableError } from './llm.js';

/**
 * A minimal tool-using agent that drives the MCP server with a LOCAL model.
 * It lists the MCP tools, hands them to the model, executes the tool calls the
 * model makes through the MCP client, and loops until the model answers.
 *
 * Works with Ollama (default) and any OpenAI-compatible endpoint.
 * (Claude Desktop / Claude Code can use this MCP server natively; no agent needed.)
 */

export type AgentEvent =
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'answer'; text: string };

interface ToolCall {
  id?: string;
  function: { name: string; arguments: unknown };
}

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

const SYSTEM = `You are a building operations assistant connected to real IoT devices through tools.
- Investigate before acting: check alerts/room summaries, and history when the trend matters.
- Only change devices when there's a real problem, and pick the device in the same room as the problem.
- CO2 too high → raise the ventilation fan. Particles (PM2.5) too high → air purifier (auto or high). TVOC too high in the lab → exhaust relay on.
- Problems a device can't fix (offline devices, low battery, worn filter) → tell the user who should act.
- Finish with a short, plain summary: what you found, what you changed, what needs a person.`;

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 10);

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

async function callModel(messages: AgentMessage[], tools: unknown[]): Promise<AgentMessage> {
  const provider = getProvider();
  const model = getModel();
  const timeout = AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS ?? 180_000));
  let res: Response;
  try {
    if (provider === 'ollama') {
      const url = `${(process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '')}/api/chat`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, stream: false, options: { temperature: 0.1 } }),
        signal: timeout,
      });
    } else if (provider === 'openai') {
      const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          tools,
          messages: messages.map((m) => ({
            ...m,
            tool_calls: m.tool_calls?.map((tc, i) => ({
              id: tc.id ?? `call_${i}`,
              type: 'function',
              function: { name: tc.function.name, arguments: JSON.stringify(parseArgs(tc.function.arguments)) },
            })),
          })),
        }),
        signal: timeout,
      });
    } else {
      throw new LLMUnavailableError(
        `The built-in agent supports LLM_PROVIDER=ollama or openai (current: ${provider}). With Claude, connect Claude Desktop to this MCP server instead.`,
      );
    }
  } catch (err) {
    if (err instanceof LLMUnavailableError) throw err;
    throw new LLMUnavailableError(`Could not reach the AI model: ${(err as Error).message}`);
  }
  if (!res.ok) throw new LLMUnavailableError(`AI provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  const msg = provider === 'ollama' ? data.message : data.choices?.[0]?.message;
  return { role: 'assistant', content: msg?.content ?? '', tool_calls: msg?.tool_calls ?? undefined };
}

export async function runAgent(client: Client, question: string, onEvent: (e: AgentEvent) => void = () => {}): Promise<string> {
  const { tools: mcpTools } = await client.listTools();
  const tools = mcpTools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? t.title ?? t.name, parameters: t.inputSchema },
  }));

  const messages: AgentMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: question },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await callModel(messages, tools);
    messages.push(reply);

    if (!reply.tool_calls?.length) {
      const answer = reply.content.trim() || 'Done.';
      onEvent({ type: 'answer', text: answer });
      return answer;
    }

    for (const [i, call] of reply.tool_calls.entries()) {
      const name = call.function.name;
      const args = parseArgs(call.function.arguments);
      onEvent({ type: 'tool_call', name, args });
      let resultText: string;
      let ok = true;
      try {
        const result = await client.callTool({ name, arguments: args });
        const parts = (result.content as { type: string; text?: string }[]) ?? [];
        resultText = parts.map((p) => p.text ?? '').join('\n');
        ok = !result.isError;
      } catch (err) {
        resultText = `Tool error: ${(err as Error).message}`;
        ok = false;
      }
      onEvent({ type: 'tool_result', name, ok, preview: resultText.slice(0, 400) });
      messages.push({ role: 'tool', content: resultText, tool_name: name, tool_call_id: call.id ?? `call_${i}` });
    }
  }
  const answer = 'Stopped after too many steps. Check the activity log for what was done.';
  onEvent({ type: 'answer', text: answer });
  return answer;
}
