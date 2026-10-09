export type Metric = 'pm25' | 'pm10' | 'co2' | 'tvoc' | 'temperature' | 'humidity' | 'battery' | 'rssi';
export type PurifierMode = 'off' | 'auto' | 'low' | 'medium' | 'high';

export interface DeviceState {
  id: string;
  name: string;
  kind: 'air_monitor' | 'ventilation_fan' | 'air_purifier' | 'relay';
  room: string;
  firmware: string;
  online: boolean;
  lastSeen: string;
  readings: Partial<Record<Metric, number>>;
  actuators: { fanSpeed?: number; purifierMode?: PurifierMode; relayOn?: boolean };
  meta: Record<string, string | number | boolean>;
}

export interface Alert {
  deviceId: string;
  room: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  metric?: Metric;
  value?: number;
}

export interface ActivityEntry {
  at: string;
  source: 'mcp' | 'agent' | 'dashboard' | 'system';
  action: string;
  ok: boolean;
  detail: string;
}

export type AgentEvent =
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; preview: string }
  | { type: 'answer'; text: string }
  | { type: 'error'; message: string };

export const METRIC_INFO: Record<Metric, { label: string; unit: string }> = {
  pm25: { label: 'PM2.5', unit: 'µg/m³' },
  pm10: { label: 'PM10', unit: 'µg/m³' },
  co2: { label: 'CO₂', unit: 'ppm' },
  tvoc: { label: 'TVOC', unit: 'ppb' },
  temperature: { label: 'Temp', unit: '°C' },
  humidity: { label: 'Humidity', unit: '%' },
  battery: { label: 'Battery', unit: '%' },
  rssi: { label: 'Wi-Fi', unit: 'dBm' },
};

export function level(metric: Metric, v: number): 'good' | 'warn' | 'bad' | '' {
  switch (metric) {
    case 'co2':
      return v >= 1500 ? 'bad' : v >= 1000 ? 'warn' : 'good';
    case 'pm25':
      return v >= 55 ? 'bad' : v >= 25 ? 'warn' : 'good';
    case 'tvoc':
      return v >= 2200 ? 'bad' : v >= 660 ? 'warn' : 'good';
    case 'battery':
      return v <= 10 ? 'bad' : v <= 25 ? 'warn' : 'good';
    default:
      return '';
  }
}
