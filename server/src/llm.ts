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
 * Uses plain fetch (Node 18+), so there are no vendor SDK dependencies.
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

async function postJSON(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (err) {
    throw new LLMUnavailableError(
      `Could not reach the AI model at ${new URL(url).origin} (${(err as Error).message}).`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LLMUnavailableError(`AI provider returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function chat(messages: Message[], opts: ChatOptions = {}): Promise<string> {
  const provider = getProvider();
  const model = getModel();
  const temperature = opts.temperature ?? 0.2;

  // Every provider gets an explicit instruction when JSON is required.
  const msgs = opts.json ? withJsonInstruction(messages) : messages;

  switch (provider) {
    case 'ollama': {
      const data = await postJSON(`${ollamaUrl()}/api/chat`, {
        model,
        messages: msgs,
        stream: false,
        ...(opts.json ? { format: 'json' } : {}),
        options: {
          temperature,
          num_ctx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
          ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        },
      });
      return String(data?.message?.content ?? '');
    }

    case 'openai': {
      const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
      const key = process.env.OPENAI_API_KEY;
      if (!key && base.includes('api.openai.com')) {
        throw new LLMUnavailableError('OPENAI_API_KEY is not set.');
      }
      const data = await postJSON(
        `${base}/chat/completions`,
        {
          model,
          messages: msgs,
          temperature,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        },
        key ? { authorization: `Bearer ${key}` } : {},
      );
      return String(data?.choices?.[0]?.message?.content ?? '');
    }

    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new LLMUnavailableError('ANTHROPIC_API_KEY is not set.');
      const system = msgs
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const data = await postJSON(
        'https://api.anthropic.com/v1/messages',
        {
          model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature,
          ...(system ? { system } : {}),
          messages: msgs.filter((m) => m.role !== 'system'),
        },
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      );
      return (data?.content ?? [])
        .filter((b: any) => b?.type === 'text')
        .map((b: any) => b.text)
        .join('');
    }

    case 'none':
      throw new LLMUnavailableError('AI is turned off (LLM_PROVIDER=none).');
  }
}

/** Chat and parse a JSON object out of the reply (tolerates code fences and stray prose). */
export async function chatJSON<T>(messages: Message[], opts: Omit<ChatOptions, 'json'> = {}): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  return parseJSON<T>(raw);
}

export function parseJSON<T>(raw: string): T {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* fall through */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      /* fall through */
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
