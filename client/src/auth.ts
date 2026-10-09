/**
 * Optional access token for servers started with AUTH_TOKEN.
 * Open the dashboard once as http://host:3003/?token=YOUR_TOKEN (or enter it when asked);
 * it is kept for this browser tab only and removed from the address bar.
 */
const KEY = 'iot-mcp:token';

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string): void {
  try {
    sessionStorage.setItem(KEY, token);
  } catch {
    /* storage blocked: token lasts until reload */
  }
}

/** Picks up ?token= from the URL, stores it, and cleans the URL. */
export function initToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    saveToken(fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  return read();
}

/** Adds the token to every same-origin /api request made with fetch. */
export function installAuthFetch(): void {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const token = read();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (token && (url.startsWith('/api') || url.startsWith(window.location.origin + '/api'))) {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${token}`);
      init = { ...init, headers };
    }
    return original(input, init);
  };
}

/** EventSource can't send headers, so the stream URL carries the token. */
export function withToken(path: string): string {
  const token = read();
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
}
