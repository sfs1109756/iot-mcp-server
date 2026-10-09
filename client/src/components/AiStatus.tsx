import { useEffect, useState } from 'react';

export interface Health {
  provider: string;
  model: string;
  ok: boolean;
  message: string;
}

/** Small badge showing which AI model is active and whether it's reachable. */
export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/health')
        .then((r) => r.json())
        .then((h: Health) => alive && setHealth(h))
        .catch(() => alive && setHealth({ provider: '?', model: '', ok: false, message: 'Server not reachable' }));
    load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return health;
}

export function AiStatus({ health }: { health: Health | null }) {
  if (!health) return <span className="status">Checking AI…</span>;
  const label = health.provider === 'none' ? 'AI off' : `${health.provider} · ${health.model}`;
  return (
    <span className={`status ${health.ok ? 'ok' : 'warn'}`} title={health.message}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function AiNotice({ health }: { health: Health | null }) {
  if (!health || health.ok) return null;
  return (
    <div className="notice">
      <strong>AI features are unavailable:</strong> {health.message}
    </div>
  );
}
