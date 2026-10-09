export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public aiUnavailable = false,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, Boolean(data.aiUnavailable));
  return data as T;
}

export async function postJSON<T>(url: string, body: unknown): Promise<T> {
  return handle<T>(await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

export async function getJSON<T>(url: string): Promise<T> {
  return handle<T>(await fetch(url));
}

export async function uploadFile<T>(url: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return handle<T>(await fetch(url, { method: 'POST', body: form }));
}

export interface StreamDone {
  text: string;
  [key: string]: unknown;
}

/**
 * POSTs and reads an NDJSON token stream (see server/src/stream.ts).
 * Calls onToken with the text so far; resolves with the final "done" event.
 */
export async function streamPost(url: string, body: unknown, onText: (textSoFar: string) => void, signal?: AbortSignal): Promise<StreamDone> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, Boolean(data.aiUnavailable));
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === 'token') {
        text += event.text;
        onText(text);
      } else if (event.type === 'done') {
        return event as StreamDone;
      } else if (event.type === 'error') {
        throw new ApiError(event.message, 500);
      }
    }
  }
  return { text };
}
