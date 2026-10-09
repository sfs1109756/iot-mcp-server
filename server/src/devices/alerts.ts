import type { Alert, DeviceState } from './types.js';

/** Rule-based health checks. Same thresholds the AI is told about. */
export const THRESHOLDS = {
  co2: { warning: 1000, critical: 1500 },
  pm25: { warning: 25, critical: 55 },
  tvoc: { warning: 660, critical: 2200 },
  battery: { warning: 25, critical: 10 },
  filterLifePct: { warning: 20, critical: 5 },
};

export function computeAlerts(devices: DeviceState[]): Alert[] {
  const alerts: Alert[] = [];
  for (const d of devices) {
    if (!d.online) {
      const mins = Math.round((Date.now() - Date.parse(d.lastSeen)) / 60_000);
      alerts.push({ deviceId: d.id, room: d.room, severity: 'critical', message: `${d.id} is offline (last seen ${mins} min ago).` });
      continue;
    }
    const r = d.readings;
    const high = (metric: 'co2' | 'pm25' | 'tvoc', unit: string, what: string) => {
      const v = r[metric];
      if (v === undefined) return;
      const t = THRESHOLDS[metric];
      if (v >= t.critical)
        alerts.push({
          deviceId: d.id,
          room: d.room,
          severity: 'critical',
          metric,
          value: v,
          message: `${what} is very high in ${d.room}: ${v} ${unit}.`,
        });
      else if (v >= t.warning)
        alerts.push({
          deviceId: d.id,
          room: d.room,
          severity: 'warning',
          metric,
          value: v,
          message: `${what} is elevated in ${d.room}: ${v} ${unit}.`,
        });
    };
    high('co2', 'ppm', 'CO₂');
    high('pm25', 'µg/m³', 'PM2.5');
    high('tvoc', 'ppb', 'TVOC');
    if (r.battery !== undefined && r.battery <= THRESHOLDS.battery.warning) {
      alerts.push({
        deviceId: d.id,
        room: d.room,
        severity: r.battery <= THRESHOLDS.battery.critical ? 'critical' : 'warning',
        metric: 'battery',
        value: r.battery,
        message: `${d.id} battery is low (${r.battery}%).`,
      });
    }
    const filter = Number(d.meta.filterLifePct);
    if (!Number.isNaN(filter) && filter <= THRESHOLDS.filterLifePct.warning) {
      alerts.push({
        deviceId: d.id,
        room: d.room,
        severity: filter <= 5 ? 'critical' : 'warning',
        message: `${d.id} filter life is ${filter}%. Replace soon.`,
      });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
