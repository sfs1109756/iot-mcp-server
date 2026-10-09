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
