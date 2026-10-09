/** Shared device model used by the simulator, the real-hardware adapter, MCP tools and the dashboard. */

export type Metric = 'pm25' | 'pm10' | 'co2' | 'tvoc' | 'temperature' | 'humidity' | 'battery' | 'rssi';

export const METRIC_INFO: Record<Metric, { label: string; unit: string }> = {
  pm25: { label: 'PM2.5', unit: 'µg/m³' },
  pm10: { label: 'PM10', unit: 'µg/m³' },
  co2: { label: 'CO₂', unit: 'ppm' },
  tvoc: { label: 'TVOC', unit: 'ppb' },
  temperature: { label: 'Temperature', unit: '°C' },
  humidity: { label: 'Humidity', unit: '%RH' },
  battery: { label: 'Battery', unit: '%' },
  rssi: { label: 'Wi-Fi signal', unit: 'dBm' },
};

export type DeviceKind = 'air_monitor' | 'ventilation_fan' | 'air_purifier' | 'relay';
export type PurifierMode = 'off' | 'auto' | 'low' | 'medium' | 'high';

export interface Actuators {
  fanSpeed?: number; // 0-100 %
  purifierMode?: PurifierMode;
  relayOn?: boolean;
}

export interface DeviceState {
  id: string;
  name: string;
  kind: DeviceKind;
  room: string;
  firmware: string;
  online: boolean;
  lastSeen: string; // ISO
  readings: Partial<Record<Metric, number>>;
  actuators: Actuators;
  /** Extra info, e.g. filter life for purifiers. */
  meta: Record<string, string | number | boolean>;
}

export interface HistoryPoint {
  t: string; // ISO
  v: number;
}

export type Severity = 'info' | 'warning' | 'critical';

export interface Alert {
  deviceId: string;
  room: string;
  severity: Severity;
  message: string;
  metric?: Metric;
  value?: number;
}

export type Command =
  | { type: 'set_fan_speed'; speed: number }
  | { type: 'set_purifier_mode'; mode: PurifierMode }
  | { type: 'set_relay'; on: boolean }
  | { type: 'identify' }; // blink the LED so a technician can find it

export interface CommandResult {
  ok: boolean;
  message: string;
  device?: DeviceState;
}

export interface ActivityEntry {
  at: string;
  source: 'mcp' | 'agent' | 'dashboard' | 'system';
  action: string;
  ok: boolean;
  detail: string;
}

/** Anything that can provide device data: the simulator or real ESP32s over HTTP. */
export interface DeviceAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  list(): DeviceState[];
  get(id: string): DeviceState | undefined;
  history(id: string, metric: Metric, minutes: number): HistoryPoint[];
  send(id: string, command: Command): Promise<CommandResult>;
}
