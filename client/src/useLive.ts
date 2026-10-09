import { useEffect, useState } from 'react';
import type { ActivityEntry, Alert, DeviceState, Rule } from './types';

/** Subscribes to the server's SSE stream for live device state, alerts and activity. */
export function useLive() {
  const [devices, setDevices] = useState<DeviceState[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    fetch('/api/activity')
      .then((r) => r.json())
      .then((d) => setActivity(d.activity))
      .catch(() => {});

    const es = new EventSource('/api/stream');
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

  return { devices, alerts, activity, rules, connected };
}
