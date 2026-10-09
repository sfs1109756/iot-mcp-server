import { useState } from 'react';
import { METRIC_INFO, level, type DeviceState, type Metric, type PurifierMode } from '../types';
import { Sparkline } from './Sparkline';

const ICONS: Record<DeviceState['kind'], string> = {
  air_monitor: '📟',
  ventilation_fan: '🌀',
  air_purifier: '🫧',
  relay: '🔌',
};

const SHOWN: Metric[] = ['co2', 'pm25', 'tvoc', 'temperature', 'humidity', 'battery'];

async function send(id: string, command: Record<string, unknown>) {
  const res = await fetch(`/api/devices/${id}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message ?? data.error ?? 'Command failed');
}

export function DeviceCard({ device }: { device: DeviceState }) {
  const [error, setError] = useState('');
  const [fanDraft, setFanDraft] = useState<number | null>(null);
  const d = device;
  const run = (cmd: Record<string, unknown>) =>
    send(d.id, cmd).then(
      () => setError(''),
      (e) => setError(e.message),
    );
  const identifying = Boolean(d.meta.identifyUntil);

  return (
    <div className={`device ${d.online ? '' : 'offline'} ${identifying ? 'identify' : ''}`}>
      <div className="device-head">
        <span className="icon">{ICONS[d.kind]}</span>
        <div className="grow">
          <div className="device-name">{d.room}</div>
          <div className="small muted">
            {d.name} · <code>{d.id}</code>
          </div>
        </div>
        <span className={`pill ${d.online ? 'on' : 'off'}`}>{d.online ? 'online' : 'offline'}</span>
      </div>

      {!d.online && <p className="small muted">Last seen {new Date(d.lastSeen).toLocaleString()}</p>}

      {d.online && d.kind === 'air_monitor' && (
        <>
          <div className="readings">
            {SHOWN.filter((m) => d.readings[m] !== undefined).map((m) => (
              <div key={m} className={`reading ${level(m, d.readings[m]!)}`}>
                <span className="r-label">{METRIC_INFO[m].label}</span>
                <span className="r-value">
                  {d.readings[m]}
                  <small>{METRIC_INFO[m].unit}</small>
                </span>
              </div>
            ))}
          </div>
          <div className="small muted spark-label">CO₂ · last 2h</div>
          <Sparkline deviceId={d.id} metric="co2" />
        </>
      )}

      {d.online && d.kind === 'ventilation_fan' && (
        <div className="control">
          <label className="small muted">Fan speed: {fanDraft ?? d.actuators.fanSpeed}%</label>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={fanDraft ?? d.actuators.fanSpeed ?? 0}
            onChange={(e) => setFanDraft(Number(e.target.value))}
            onPointerUp={() => fanDraft !== null && run({ type: 'set_fan_speed', speed: fanDraft }).then(() => setFanDraft(null))}
            onKeyUp={() => fanDraft !== null && run({ type: 'set_fan_speed', speed: fanDraft }).then(() => setFanDraft(null))}
          />
          <div
            className={`fan-anim ${(d.actuators.fanSpeed ?? 0) > 0 ? 'spin' : ''}`}
            style={{ animationDuration: `${Math.max(0.3, 3 - (d.actuators.fanSpeed ?? 0) / 40)}s` }}
          >
            🌀
          </div>
        </div>
      )}

      {d.online && d.kind === 'air_purifier' && (
        <div className="control">
          <div className="seg">
            {(['off', 'auto', 'low', 'medium', 'high'] as PurifierMode[]).map((m) => (
              <button
                key={m}
                className={d.actuators.purifierMode === m ? 'active' : ''}
                onClick={() => run({ type: 'set_purifier_mode', mode: m })}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="small muted">Filter life {d.meta.filterLifePct}%</div>
        </div>
      )}

      {d.online && d.kind === 'relay' && (
        <div className="control row">
          <button
            className={`toggle ${d.actuators.relayOn ? 'on' : ''}`}
            onClick={() => run({ type: 'set_relay', on: !d.actuators.relayOn })}
          >
            <span />
          </button>
          <span>
            {d.actuators.relayOn ? 'ON' : 'OFF'} · {String(d.meta.load ?? 'Relay')}
          </span>
        </div>
      )}

      {d.online && (
        <div className="device-foot small muted">
          <span>
            fw {d.firmware} · {d.readings.rssi} dBm
          </span>
          <button className="link" onClick={() => run({ type: 'identify' })}>
            {identifying ? '💡 blinking…' : 'Identify'}
          </button>
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
