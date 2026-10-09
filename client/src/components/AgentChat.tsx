import { useState, type FormEvent } from 'react';
import type { AgentEvent } from '../types';

interface Turn {
  question: string;
  events: AgentEvent[];
  done: boolean;
}

const SUGGESTIONS = [
  'Run a health check and fix what you can',
  'The conference room feels stuffy',
  'Why is the open office air hazy?',
  'Which devices need a technician?',
];

type CallEvent = Extract<AgentEvent, { type: 'tool_call' }>;
type ResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

/** Pairs each tool call with the result that followed it. */
function pairSteps(events: AgentEvent[]) {
  const steps: { call: CallEvent; result?: ResultEvent }[] = [];
  for (const e of events) {
    if (e.type === 'tool_call') steps.push({ call: e });
    else if (e.type === 'tool_result') {
      const open = steps.find((s) => !s.result && s.call.name === e.name);
      if (open) open.result = e;
    }
  }
  return steps;
}

/** Short, readable argument summary: device_id first, reason left out. */
function argSummary(args: Record<string, unknown>): string {
  const { device_id, reason: _reason, ...rest } = args;
  const parts = [device_id ? String(device_id) : '', ...Object.entries(rest).map(([k, v]) => `${k}=${String(v)}`)];
  return parts.filter(Boolean).join(' · ');
}

/** Chat with the local-model agent. Streams each MCP tool call as it happens. */
export function AgentChat({ aiReady }: { aiReady: boolean }) {
  const [input, setInput] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(e?: FormEvent, text = input) {
    e?.preventDefault();
    const question = text.trim();
    if (!question || busy) return;
    setInput('');
    setBusy(true);
    setTurns((t) => [{ question, events: [], done: false }, ...t]);
    const update = (fn: (turn: Turn) => Turn) => setTurns((t) => [fn(t[0]), ...t.slice(1)]);

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as AgentEvent;
          update((t) => ({ ...t, events: [...t.events, event] }));
        }
      }
    } catch (err) {
      update((t) => ({ ...t, events: [...t.events, { type: 'error', message: (err as Error).message }] }));
    } finally {
      update((t) => ({ ...t, done: true }));
      setBusy(false);
    }
  }

  return (
    <div className="panel agent">
      <h2>🤖 Ask the agent</h2>
      <p className="small muted">
        A local model uses this server's MCP tools to inspect and control devices. Watch the cards update as it works.
      </p>
      <form onSubmit={ask} className="row agent-form">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. Fix the air in the lab" disabled={busy || !aiReady} />
        <button disabled={busy || !aiReady || !input.trim()}>{busy ? <span className="spinner" /> : 'Send'}</button>
      </form>
      {!aiReady && <p className="small muted">Start Ollama to use the agent. Manual controls and MCP clients still work.</p>}
      {aiReady && turns.length === 0 && (
        <div className="suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip btn" onClick={() => ask(undefined, s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="turns">
        {turns.map((t, i) => (
          <div key={turns.length - i} className="turn">
            <div className="t-q">{t.question}</div>
            <ol className="steps">
              {pairSteps(t.events).map((step, j) => (
                <li key={j} className={step.result ? (step.result.ok ? 'ok' : 'bad') : 'pending'}>
                  <details>
                    <summary>
                      <span className="step-icon">{step.result ? (step.result.ok ? '✓' : '✗') : '…'}</span>
                      <code>{step.call.name}</code> <span className="muted">{argSummary(step.call.args)}</span>
                    </summary>
                    {step.result && <pre className="step-result">{step.result.preview}</pre>}
                  </details>
                </li>
              ))}
            </ol>
            {t.events.map((e, j) =>
              e.type === 'answer' ? (
                <div key={j} className="t-answer prose">{e.text}</div>
              ) : e.type === 'error' ? (
                <div key={j} className="error small">{e.message}</div>
              ) : null,
            )}
            {!t.done && (
              <div className="small muted">
                <span className="spinner" />
                thinking…
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
