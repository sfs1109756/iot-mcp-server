import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { chat, chatJSON, chatStream, LLMUnavailableError, parseJSON } from './llm.js';

/**
 * A fake server that speaks the Ollama, OpenAI and Anthropic wire formats
 * (normal and streaming), plus a few failure modes.
 */
let base = '';
let flaky = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const words = ['Hello', ' from', ' the', ' model'];

    if (req.url === '/flaky/api/chat') {
      if (flaky++ < 1) {
        res.writeHead(503).end('busy');
        return;
      }
      res.end(JSON.stringify({ message: { content: 'recovered' } }));
      return;
    }
    if (req.url === '/missing/api/chat') {
      res.writeHead(404).end(JSON.stringify({ error: 'model "qwen2.5:7b" not found, try pulling it first' }));
      return;
    }
    if (req.url === '/api/chat') {
      if (!body.stream) {
        res.end(JSON.stringify({ message: { content: body.format === 'json' ? '```json\n{"ok": true,}\n```' : words.join('') } }));
        return;
      }
      for (const w of words) res.write(`${JSON.stringify({ message: { content: w }, done: false })}\n`);
      res.end(`${JSON.stringify({ message: { content: '' }, done: true })}\n`);
      return;
    }
    if (req.url === '/v1/chat/completions') {
      if (!body.stream) {
        res.end(JSON.stringify({ choices: [{ message: { content: words.join('') } }] }));
        return;
      }
      res.write(': keep-alive\n\n');
      for (const w of words) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url === '/v1/messages') {
      assert.ok(req.headers['x-api-key']);
      assert.ok(!body.messages.some((m: { role: string }) => m.role === 'system'), 'system must be top-level');
      if (!body.stream) {
        res.end(JSON.stringify({ content: [{ type: 'text', text: words.join('') }] }));
        return;
      }
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start' })}\n\n`);
      for (const w of words) {
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: w } })}\n\n`,
        );
      }
      res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LLM_MAX_RETRIES = '2';
});
after(() => server.close());

const msgs = [
  { role: 'system' as const, content: 'Be brief.' },
  { role: 'user' as const, content: 'Hi' },
];

function use(provider: string, extra: Record<string, string> = {}) {
  process.env.LLM_PROVIDER = provider;
  process.env.OLLAMA_URL = base;
  process.env.OPENAI_BASE_URL = `${base}/v1`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_API_KEY = 'test';
  Object.assign(process.env, extra);
}

for (const provider of ['ollama', 'openai', 'anthropic']) {
  test(`${provider}: chat and chatStream return the same text`, async () => {
    use(provider);
    assert.equal(await chat(msgs), 'Hello from the model');
    const tokens: string[] = [];
    const full = await chatStream(msgs, (t) => tokens.push(t));
    assert.equal(full, 'Hello from the model');
    assert.deepEqual(tokens, ['Hello', ' from', ' the', ' model']);
  });
}

test('chatJSON tolerates fences and trailing commas', async () => {
  use('ollama');
  assert.deepEqual(await chatJSON(msgs), { ok: true });
});

test('retries transient 503s', async () => {
  use('ollama', { OLLAMA_URL: `${base}/flaky` });
  flaky = 0;
  assert.equal(await chat(msgs), 'recovered');
});

test('explains a missing Ollama model', async () => {
  use('ollama', { OLLAMA_URL: `${base}/missing` });
  await assert.rejects(chat(msgs), (err: Error) => err instanceof LLMUnavailableError && /ollama pull/.test(err.message));
});

test('unreachable server and disabled AI raise LLMUnavailableError', async () => {
  use('ollama', { OLLAMA_URL: 'http://127.0.0.1:9' });
  await assert.rejects(chat(msgs), LLMUnavailableError);
  use('none');
  await assert.rejects(
    chatStream(msgs, () => {}),
    LLMUnavailableError,
  );
});

test('parseJSON handles common local-model mistakes', () => {
  assert.deepEqual(parseJSON('Sure! Here is the JSON:\n{"a": 1}\nHope that helps.'), { a: 1 });
  assert.deepEqual(parseJSON('```json\n{"a": [1, 2,],}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJSON('{“a”: “b”}'), { a: 'b' });
  assert.throws(() => parseJSON('no json here'), /invalid JSON/);
});
