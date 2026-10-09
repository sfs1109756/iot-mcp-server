import { AiStatus, useHealth } from './components/AiStatus';
import { AgentChat } from './components/AgentChat';
import { DeviceCard } from './components/DeviceCard';
import { RulesPanel } from './components/RulesPanel';
import { saveToken } from './auth';
import { useLive } from './useLive';

const SOURCE_LABEL = { mcp: 'MCP client', agent: 'Agent', dashboard: 'You', rule: 'Rule', system: 'System' } as const;

export default function App() {
  const health = useHealth();
  const { devices, alerts, activity, rules, connected, needsToken } = useLive();

  const rooms = [...new Set(devices.map((d) => d.room))];

  if (needsToken) {
    return (
      <div className="app">
        <form
          className="panel crash"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('token');
            if (typeof value === 'string' && value.trim()) {
              saveToken(value.trim());
              window.location.reload();
            }
          }}
        >
          <h2>🔒 Access token needed</h2>
          <p className="muted">This server was started with AUTH_TOKEN. Enter it to control the devices.</p>
          <input name="token" type="password" autoFocus placeholder="Token" aria-label="Access token" />
          <button style={{ marginTop: 10 }}>Unlock</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app wide">
      <header className="top">
        <div>
          <h1>🛰️ IoT MCP Server</h1>
          <p>ESP32 devices exposed as MCP tools. Control them here, from Claude Desktop, or with a local AI agent.</p>
        </div>
        <div className="row">
          <span className={`status ${connected ? 'ok' : 'warn'}`}>
            <span className="dot" />
            {connected ? 'Live' : 'Reconnecting…'}
          </span>
          <AiStatus health={health} />
        </div>
      </header>

      <div className="layout">
        <main className="stack">
          <div className={`panel alerts ${alerts.length ? '' : 'clear'}`}>
            <h2>{alerts.length ? `⚠️ ${alerts.length} active alert${alerts.length > 1 ? 's' : ''}` : '✅ All clear'}</h2>
            {alerts.map((a, i) => (
              <div key={i} className={`alert ${a.severity}`}>
                <span className="sev">{a.severity}</span>
                {a.message}
              </div>
            ))}
          </div>

          {rooms.map((room) => (
            <section key={room}>
              <h2 className="room-title">{room}</h2>
              <div className="devices">
                {devices
                  .filter((d) => d.room === room)
                  .map((d) => (
                    <DeviceCard key={d.id} device={d} />
                  ))}
              </div>
            </section>
          ))}
        </main>

        <aside className="stack">
          <AgentChat aiReady={Boolean(health?.ok)} />
          <RulesPanel rules={rules} devices={devices} />
          <div className="panel">
            <h2>📜 Activity</h2>
            <div className="feed">
              {activity.length === 0 && <p className="small muted">Nothing yet.</p>}
              {activity.map((a, i) => (
                <div key={`${a.at}-${i}`} className={`entry ${a.ok ? '' : 'failed'}`}>
                  <div className="row small">
                    <span className={`src src-${a.source}`}>{SOURCE_LABEL[a.source]}</span>
                    <code>{a.action}</code>
                    <span className="muted grow-right">{new Date(a.at).toLocaleTimeString()}</span>
                  </div>
                  <div className="small muted">{a.detail}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="panel small">
            <h2>🔌 Connect an MCP client</h2>
            <p className="muted">
              HTTP endpoint: <code>{window.location.origin.replace(/:\d+$/, ':3003')}/mcp</code> (send <code>Authorization: Bearer …</code>{' '}
              if the server uses AUTH_TOKEN)
            </p>
            <p className="muted">Claude Desktop / Claude Code (stdio): see the README for the config snippet.</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
