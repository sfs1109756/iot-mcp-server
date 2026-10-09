import { useEffect, useState } from 'react';
import { withToken } from './auth';
import type { ActivityEntry, Alert, DeviceState, Rule } from './types';

/** Subscribes to the server's SSE stream for live device state, alerts and activity. */
export function useLive() {
  const [devices, setDevices] = useState<DeviceState[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [connected, setConnected] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);

  useEffect(() => {
    fetch('/api/activity')
      .then((r) => {
        if (r.status === 401) setNeedsToken(true);
        return r.json();
      })
      .then((d) => d.activity && setActivity(d.activity))
      .catch(() => {});

    const es = new EventSource(withToken('/api/stream'));
    es.addEventListener('open', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    es.addEventListener('devices', (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setDevices(data.devices);
      setAlerts(data.alerts);
      setConnected(true);
    });
    es.addEventListener('rules', (e) => setRules(JSON.parse((e as MessageEvent).data).rules));
    es.addEventListener('activity', (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as ActivityEntry;
      setActivity((a) => [entry, ...a].slice(0, 100));
    });
    return () => es.close();
  }, []);

  return { devices, alerts, activity, rules, connected, needsToken };
}
