import { useMemo, useState, type FormEvent } from 'react';
import { METRIC_INFO, type Command, type DeviceState, type Metric, type PurifierMode, type Rule } from '../types';

const SOURCE: Record<string, string> = { dashboard: 'you', mcp: 'MCP client', agent: 'agent', default: 'example' };

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
}

/** Automation rules that run on the server with no AI. */
export function RulesPanel({ rules, devices }: { rules: Rule[]; devices: DeviceState[] }) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const toggle = (r: Rule) => call('PATCH', `/api/rules/${r.id}`, { enabled: !r.enabled }).catch((e) => setError(e.message));
  const remove = (r: Rule) => {
    if (confirm(`Delete "${r.name}"?`)) call('DELETE', `/api/rules/${r.id}`).catch((e) => setError(e.message));
  };

  return (
    <div className="panel rules">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>⚙️ Automations</h2>
        <button className="ghost small" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ New rule'}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Run on the server without AI. An assistant can also create them with the <code>create_rule</code> tool.
      </p>
      {creating && <RuleForm devices={devices} onDone={() => setCreating(false)} />}
      {error && <div className="error small">{error}</div>}
      {rules.length === 0 && !creating && <p className="small muted">No rules yet.</p>}
      <div className="rule-list">
        {rules.map((r) => (
          <div key={r.id} className={`rule ${r.enabled ? '' : 'off'} ${r.active ? 'firing' : ''}`}>
            <div className="row" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <button
                className={`toggle sm ${r.enabled ? 'on' : ''}`}
                onClick={() => toggle(r)}
                aria-label={r.enabled ? 'Disable rule' : 'Enable rule'}
              >
                <span />
              </button>
              <div className="grow">
                <div className="rule-name">
                  {r.name} {r.active && <span className="pill on">active</span>}
                </div>
                <div className="small muted">{r.description}</div>
                <div className="small muted">
                  by {SOURCE[r.createdBy] ?? r.createdBy}
                  {r.lastFiredAt && ` · last fired ${new Date(r.lastFiredAt).toLocaleTimeString()}`}
                </div>
              </div>
              <button className="link small" onClick={() => remove(r)} aria-label="Delete rule">
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const ACTION_FOR: Record<string, Command['type']> = {
  ventilation_fan: 'set_fan_speed',
  air_purifier: 'set_purifier_mode',
  relay: 'set_relay',
};

function commandFor(kind: string, value: string): Command {
  const type = ACTION_FOR[kind];
  if (type === 'set_fan_speed') return { type, speed: Math.max(0, Math.min(100, Number(value))) };
  if (type === 'set_purifier_mode') return { type, mode: value as PurifierMode };
  return { type: 'set_relay', on: value === 'on' };
}

function ValueInput({
  kind,
  value,
  onChange,
  allowNone,
}: {
  kind: string;
  value: string;
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  if (kind === 'ventilation_fan')
    return (
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={allowNone ? '— %' : '%'}
        aria-label="Fan speed %"
      />
    );
  const options = kind === 'air_purifier' ? ['off', 'auto', 'low', 'medium', 'high'] : ['on', 'off'];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Value">
      {allowNone && <option value="">nothing</option>}
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
}

function RuleForm({ devices, onDone }: { devices: DeviceState[]; onDone: () => void }) {
  const sensors = devices.filter((d) => d.kind === 'air_monitor' && d.online);
  const actuators = devices.filter((d) => d.kind !== 'air_monitor' && d.online);
  const [sensorId, setSensorId] = useState(sensors[0]?.id ?? '');
  const [metric, setMetric] = useState<Metric>('co2');
  const [op, setOp] = useState<'>' | '<'>('>');
  const [threshold, setThreshold] = useState('1000');
  const [forSeconds, setForSeconds] = useState('30');
  const [targetId, setTargetId] = useState(actuators[0]?.id ?? '');
  const target = actuators.find((d) => d.id === targetId);
  const [value, setValue] = useState('80');
  const [clearValue, setClearValue] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const metrics = useMemo(
    () => (Object.keys(sensors.find((d) => d.id === sensorId)?.readings ?? {}) as Metric[]).filter((m) => m !== 'rssi'),
    [sensors, sensorId],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError('');
    try {
      await call('POST', '/api/rules', {
        name: name.trim() || `${target.room}: ${METRIC_INFO[metric].label} ${op} ${threshold}`,
        when: { deviceId: sensorId, metric, op, value: Number(threshold), forSeconds: Number(forSeconds) || 0 },
        then: { deviceId: targetId, command: commandFor(target.kind, value) },
        ...(clearValue !== '' ? { onClear: { deviceId: targetId, command: commandFor(target.kind, clearValue) } } : {}),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const onTarget = (id: string) => {
    setTargetId(id);
    const kind = actuators.find((d) => d.id === id)?.kind;
    setValue(kind === 'ventilation_fan' ? '80' : kind === 'air_purifier' ? 'auto' : 'on');
    setClearValue('');
  };

  if (!sensors.length || !actuators.length)
    return <p className="small muted">Rules need at least one online sensor and one controllable device.</p>;

  return (
    <form className="rule-form" onSubmit={submit}>
      <label>When</label>
      <div className="rf-row">
        <select value={sensorId} onChange={(e) => setSensorId(e.target.value)} aria-label="Sensor">
          {sensors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.room} ({d.id})
            </option>
          ))}
        </select>
        <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)} aria-label="Metric">
          {metrics.map((m) => (
            <option key={m} value={m}>
              {METRIC_INFO[m].label}
            </option>
          ))}
        </select>
      </div>
      <div className="rf-row">
        <select value={op} onChange={(e) => setOp(e.target.value as '>' | '<')} aria-label="Comparison">
          <option value=">">is above</option>
          <option value="<">is below</option>
        </select>
        <input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} aria-label="Threshold" />
        <span className="small muted">{METRIC_INFO[metric]?.unit}</span>
        <span className="small muted">for</span>
        <input
          type="number"
          min={0}
          value={forSeconds}
          onChange={(e) => setForSeconds(e.target.value)}
          aria-label="Seconds"
          style={{ width: 70 }}
        />
        <span className="small muted">s</span>
      </div>
      <label>Then</label>
      <div className="rf-row">
        <select value={targetId} onChange={(e) => onTarget(e.target.value)} aria-label="Device to control">
          {actuators.map((d) => (
            <option key={d.id} value={d.id}>
              {d.room} – {d.name}
            </option>
          ))}
        </select>
        {target && <ValueInput kind={target.kind} value={value} onChange={setValue} />}
      </div>
      <label>When it clears (optional)</label>
      <div className="rf-row">{target && <ValueInput kind={target.kind} value={clearValue} onChange={setClearValue} allowNone />}</div>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (optional)" />
      {error && <div className="error small">{error}</div>}
      <button type="submit">Save rule</button>
    </form>
  );
}
