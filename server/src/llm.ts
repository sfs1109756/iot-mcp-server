/**
 * Provider-agnostic LLM client.
 *
 * Default provider is a LOCAL model served by Ollama (http://localhost:11434),
 * so the app does not depend on any AI platform, API key or internet access.
 * Switch providers with environment variables only — no code changes:
 *
 *   LLM_PROVIDER=ollama     (default) local model, e.g. qwen2.5:7b or llama3.1:8b
 *   LLM_PROVIDER=openai     any OpenAI-compatible endpoint (OpenAI, LM Studio, Groq, vLLM...)
 *   LLM_PROVIDER=anthropic  Claude API
 *   LLM_PROVIDER=none       AI turned off; apps fall back to their non-AI features
 *
 * Supports normal and streaming replies. Uses plain fetch (Node 18+), no vendor SDKs.
 */

export type Role = 'system' | 'user' | 'assistant';
export interface Message {
  role: Role;
  content: string;
}
export interface ChatOptions {
  /** Ask the model to answer with a single JSON object. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Cancels the request (e.g. when the browser disconnects). */
  signal?: AbortSignal;
}

export type Provider = 'ollama' | 'openai' | 'anthropic' | 'none';

const DEFAULT_MODELS: Record<Provider, string> = {
  ollama: 'qwen2.5:7b',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-5-5',
  none: '',
};

/** Thrown when the model can't be reached or isn't configured. Routes map it to HTTP 503. */
export class LLMUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

export function getProvider(): Provider {
  const p = (process.env.LLM_PROVIDER ?? 'ollama').trim().toLowerCase();
  if (p === 'ollama' || p === 'openai' || p === 'anthropic' || p === 'none') return p;
  throw new Error(`Unknown LLM_PROVIDER "${p}". Use ollama, openai, anthropic or none.`);
}

export function getModel(): string {
  return process.env.LLM_MODEL?.trim() || DEFAULT_MODELS[getProvider()];
}

function ollamaUrl(): string {
  return (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '');
}

function timeoutMs(): number {
  return Number(process.env.LLM_TIMEOUT_MS ?? 180_000);
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = Number(process.env.LLM_MAX_RETRIES ?? 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST with a timeout and a couple of retries on rate limits / transient server errors. */
async function post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs())]) : AbortSignal.timeout(timeoutMs()),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new LLMUnavailableError(`Could not reach the AI model at ${new URL(url).origin} (${(err as Error).message}).`);
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 800 * 2 ** attempt);
      continue;
    }
    if (res.status === 404 && getProvider() === 'ollama' && /model/i.test(text)) {
      throw new LLMUnavailableError(`Model "${getModel()}" is not downloaded. Run: ollama pull ${getModel()}`);
    }
    throw new LLMUnavailableError(`AI provider returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
}

interface ProviderRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Builds the provider-specific HTTP request for a chat call. */
function buildRequest(messages: Message[], opts: ChatOptions, stream: boolean): ProviderRequest {
  const provider = getProvider();
  const model = getModel();
  const temperature = opts.temperature ?? 0.2;
  // Every provider gets an explicit instruction when JSON is required.
  const msgs = opts.json ? withJsonInstruction(messages) : messages;

  switch (provider) {
    case 'ollama':
      return {
        url: `${ollamaUrl()}/api/chat`,
        headers: {},
        body: {
          model,
          messages: msgs,
          stream,
          ...(opts.json ? { format: 'json' } : {}),
          options: {
            temperature,
            num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
            ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
          },
        },
      };
    case 'openai': {
      const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
      const key = process.env.OPENAI_API_KEY;
      if (!key && base.includes('api.openai.com')) throw new LLMUnavailableError('OPENAI_API_KEY is not set.');
      return {
        url: `${base}/chat/completions`,
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: {
          model,
          messages: msgs,
          temperature,
          stream,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        },
      };
    }
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new LLMUnavailableError('ANTHROPIC_API_KEY is not set.');
      const system = msgs
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      return {
        url: `${(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: {
          model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature,
          stream,
          ...(system ? { system } : {}),
          messages: msgs.filter((m) => m.role !== 'system'),
        },
      };
    }
    case 'none':
      throw new LLMUnavailableError('AI is turned off (LLM_PROVIDER=none).');
  }
}

/** Pulls the reply text out of a non-streaming response body. */
function replyText(data: any): string {
  switch (getProvider()) {
    case 'ollama':
      return String(data?.message?.content ?? '');
    case 'openai':
      return String(data?.choices?.[0]?.message?.content ?? '');
    default:
      return (data?.content ?? [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('');
  }
}

export async function chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
  const req = buildRequest(messages, opts, false);
  const res = await post(req.url, req.body, req.headers, opts.signal);
  return replyText(await res.json());
}

/** Reads a fetch body line by line (works for NDJSON and SSE). */
async function* lines(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}

/** Extracts the text delta from one streamed line, for each provider's wire format. */
export function parseStreamLine(provider: Provider, line: string): { text?: string; done?: boolean; error?: string } {
  if (provider === 'ollama') {
    const data = JSON.parse(line);
    if (data.error) return { error: String(data.error) };
    return { text: data.message?.content ?? '', done: Boolean(data.done) };
  }
  // OpenAI and Anthropic stream Server-Sent Events.
  if (!line.startsWith('data:')) return {};
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  const data = JSON.parse(payload);
  if (data.error) return { error: String(data.error.message ?? data.error) };
  if (provider === 'openai') return { text: data.choices?.[0]?.delta?.content ?? '' };
  if (data.type === 'content_block_delta') return { text: data.delta?.text ?? '' };
  if (data.type === 'message_stop') return { done: true };
  return {};
}

/**
 * Streams the reply token by token. Calls onToken for each piece and resolves with the
 * full text. Throws LLMUnavailableError before the first token if the model can't be used,
 * so routes can still answer with a normal HTTP error.
 */
export async function chatStream(messages: Message[], onToken: (text: string) => void, opts: ChatOptions = {}): Promise<string> {
  const provider = getProvider();
  const req = buildRequest(messages, opts, true);
  const res = await post(req.url, req.body, req.headers, opts.signal);
  let full = '';
  for await (const line of lines(res)) {
    let parsed: ReturnType<typeof parseStreamLine>;
    try {
      parsed = parseStreamLine(provider, line);
    } catch {
      continue; // ignore keep-alives / malformed lines
    }
    if (parsed.error) throw new Error(`AI provider error: ${parsed.error}`);
    if (parsed.text) {
      full += parsed.text;
      onToken(parsed.text);
    }
    if (parsed.done) break;
  }
  return full;
}

/** Chat and parse a JSON object out of the reply (tolerates code fences and stray prose). */
export async function chatJSON<T>(messages: Message[], opts: Omit<ChatOptions, 'json'> = {}): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  return parseJSON<T>(raw);
}

/**
 * Parses JSON from model output. Local models often wrap JSON in ```fences```, add a sentence
 * before it, use smart quotes, or leave a trailing comma — all handled here.
 */
export function parseJSON<T>(raw: string): T {
  const attempts: string[] = [];
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  attempts.push(cleaned);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(cleaned.slice(start, end + 1));
  for (const candidate of [...attempts]) {
    attempts.push(
      candidate
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, '$1'),
    );
  }
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('The AI model returned invalid JSON. Try again, or use a larger model.');
}

function withJsonInstruction(messages: Message[]): Message[] {
  const note = 'Respond with a single valid JSON object only. No markdown, no code fences, no extra text.';
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === 'system');
  if (sys) sys.content = `${sys.content}\n\n${note}`;
  else out.unshift({ role: 'system', content: note });
  return out;
}

export interface HealthStatus {
  provider: Provider;
  model: string;
  ok: boolean;
  message: string;
}

/** Cheap readiness check used by the UI status bar. Never throws. */
export async function checkHealth(): Promise<HealthStatus> {
  let provider: Provider;
  try {
    provider = getProvider();
  } catch (err) {
    return { provider: 'none', model: '', ok: false, message: (err as Error).message };
  }
  const model = getModel();

  if (provider === 'none') {
    return { provider, model, ok: false, message: 'AI is turned off. Non-AI features still work.' };
  }
  if (provider === 'anthropic') {
    const ok = Boolean(process.env.ANTHROPIC_API_KEY);
    return { provider, model, ok, message: ok ? 'Ready' : 'ANTHROPIC_API_KEY is not set.' };
  }
  if (provider === 'openai') {
    const isOpenAI = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').includes('api.openai.com');
    const ok = !isOpenAI || Boolean(process.env.OPENAI_API_KEY);
    return { provider, model, ok, message: ok ? 'Ready' : 'OPENAI_API_KEY is not set.' };
  }

  // Ollama: confirm the server is up and the model has been pulled.
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    const wanted = model.includes(':') ? model : `${model}:latest`;
    if (!names.includes(wanted)) {
      return { provider, model, ok: false, message: `Model not downloaded yet. Run: ollama pull ${model}` };
    }
    return { provider, model, ok: true, message: 'Ready (running locally)' };
  } catch {
    return {
      provider,
      model,
      ok: false,
      message: `Ollama is not running at ${ollamaUrl()}. Install it from ollama.com and start it.`,
    };
  }
}
