import { useEffect, useState } from 'react';
import { PixelCanvas } from './PixelCanvas';
import { ENTRY_KEY, nsColor } from './renderer';
import { connect, onStatus, onTopology, store } from './store';
import {
  aggregateServices,
  getObservedEdges,
  neighborsOf,
  type ServiceNode,
} from './topology';
import {
  enterSandbox,
  exitSandbox,
  project,
  replicasOf,
  sandbox,
  setReplicas,
} from './sandbox';
import './App.css';

const WS_URL = `ws://${window.location.hostname}:8090/ws`;

/** Coarse activity level, so the k6 indicator only changes state occasionally. */
type Level = 'idle' | 'active' | 'heavy';

// Measured on this cluster: kube-system + otel-demo chatter idles around
// 40-55 flows/s with no load at all, so the bands sit above that floor.
// Anything lower reported "HEAVY LOAD" on a completely idle cluster.
const ACTIVE_FLOOR = 95;

function levelFor(flowRate: number, overloaded: number): Level {
  if (overloaded > 0) return 'heavy';
  if (flowRate > ACTIVE_FLOOR) return 'active';
  return 'idle';
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServiceNode | null>(null);
  const [level, setLevel] = useState<Level>('idle');
  const [showKube, setShowKube] = useState(false);
  const [stats, setStats] = useState({ services: 0, pods: 0, overloaded: 0, flows: 0 });
  const [sandboxOn, setSandboxOn] = useState(false);
  const [rpsInput, setRpsInput] = useState('200');
  const [running, setRunning] = useState(false);
  // Bumped whenever a stepper changes so the panel re-reads the projection.
  const [edit, setEdit] = useState(0);
  const [bottlenecks, setBottlenecks] = useState<string[]>([]);

  type Link = { name: string; hidden: boolean };
  const [links, setLinks] = useState<{ upstream: Link[]; downstream: Link[] }>({
    upstream: [],
    downstream: [],
  });

  useEffect(() => {
    connect(WS_URL);
    return onStatus(setConnected);
  }, []);

  useEffect(() => onTopology(() => setNamespaces([...store.namespaces])), []);

  // Summary counters and the inspect panel change every tick, but a human reads
  // them a few times a second at most. Sampling at 4Hz keeps React entirely off
  // the animation path — the canvas never re-renders because of this.
  useEffect(() => {
    const id = window.setInterval(() => {
      const thresh = store.overloadCfg.cpuPct || 200;
      let svc: Map<string, ServiceNode>;
      if (sandbox.active) {
        // Same projection the renderer draws, so the panel and the canvas can
        // never disagree about a projected number.
        const p = project(thresh, ENTRY_KEY);
        svc = p.nodes;
        setBottlenecks((prev) =>
          prev.length === p.bottlenecks.length && prev.every((v, i) => v === p.bottlenecks[i])
            ? prev
            : p.bottlenecks,
        );
      } else {
        svc = aggregateServices([...store.pods.values()], thresh, showKube);
      }

      let overloaded = 0;
      let flows = 0;
      for (const s of svc.values()) {
        if (s.overload) overloaded++;
        flows += s.rxRate;
      }
      const next = {
        services: svc.size,
        // Pod count is the sum of replicas actually on screen, so it tracks the
        // kube-system toggle rather than reporting everything the aggregator sees.
        pods: [...svc.values()].reduce((t, x) => t + x.replicas, 0),
        overloaded,
        flows: Math.round(flows),
      };
      setStats((prev) =>
        prev.services === next.services &&
        prev.pods === next.pods &&
        prev.overloaded === next.overloaded &&
        prev.flows === next.flows
          ? prev
          : next,
      );
      setLevel((prev) => {
        const l = levelFor(flows, overloaded);
        return prev === l ? prev : l;
      });
      setDetail(selected ? svc.get(selected) ?? null : null);
      if (selected) {
        // A neighbour can be real but not drawn (e.g. kube-dns while
        // kube-system is toggled off). Mark those rather than hiding a genuine
        // dependency or implying it has a box on screen.
        const toLink = (k: string): Link => ({ name: k.split('/')[1], hidden: !svc.has(k) });
        const n = neighborsOf(selected);
        setLinks({ upstream: n.upstream.map(toLink), downstream: n.downstream.map(toLink) });
      } else {
        setLinks({ upstream: [], downstream: [] });
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [selected, showKube, sandboxOn, running, edit]);

  const cfg = store.overloadCfg;
  const ratio = detail && detail.cpuPct >= 0 ? detail.cpuPct / (cfg.cpuPct || 200) : 0;
  const barPct = Math.min(100, ratio * 100);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" />
          WATCHMAN
          <span className="sub">live service topology</span>
        </div>

        <div className="legend">
          {namespaces
            .filter((ns) => showKube || ns !== 'kube-system')
            .map((ns) => (
              <span className="legend-item" key={ns}>
                <i className="swatch" style={{ background: nsColor(ns, namespaces) }} />
                {ns}
              </span>
            ))}
          <span className="legend-item">
            <i className="swatch swatch-overload" />
            overload = CPU ≥ {cfg.cpuPct}% of request
          </span>
          <button
            className={`toggle${showKube ? ' on' : ''}`}
            onClick={() => setShowKube((v) => !v)}
          >
            kube-system {showKube ? 'ON' : 'OFF'}
          </button>
          <button
            className={`toggle sandbox-btn${sandboxOn ? ' on' : ''}`}
            onClick={() => {
              if (sandboxOn) {
                exitSandbox();
                setSandboxOn(false);
                setRunning(false);
                setBottlenecks([]);
              } else {
                const thresh = store.overloadCfg.cpuPct || 200;
                enterSandbox(
                  aggregateServices([...store.pods.values()], thresh, showKube),
                  getObservedEdges(),
                );
                setSandboxOn(true);
              }
              setEdit((v) => v + 1);
            }}
          >
            {sandboxOn ? 'BACK TO LIVE' : 'SANDBOX'}
          </button>
        </div>

        <div className="right">
          <span className={`load load-${level}`}>
            <i className="dot" />
            {level === 'heavy' ? 'HEAVY LOAD' : level === 'active' ? 'TRAFFIC' : 'IDLE'}
          </span>
          <span className={`status ${connected ? 'ok' : 'bad'}`}>
            <i className="dot" />
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
      </header>

      <div className="statbar">
        <span className="stat"><b>{stats.services}</b> <span className="muted">services</span></span>
        <span className="stat"><b>{stats.pods}</b> <span className="muted">pods</span></span>
        <span className={`stat${stats.overloaded > 0 ? ' alarm' : ''}`}>
          <b>{stats.overloaded}</b> <span className="muted">overloaded</span>
        </span>
        <span className="stat"><b>{stats.flows}</b> <span className="muted">flows/s in</span></span>
        <span className="stat">
          <span className="muted">signal</span> <b>{cfg.signal}</b>
          <span className="muted">≥ {cfg.cpuPct}% of CPU request</span>
        </span>
        {sandboxOn ? (
          <span className="sandbox-load">
            <span className="muted">synthetic load</span>
            <input
              className="rps"
              type="number"
              min="0"
              step="50"
              value={rpsInput}
              onChange={(e) => setRpsInput(e.target.value)}
              aria-label="target requests per second"
            />
            <span className="muted">req/s</span>
            <button
              className={`toggle${running ? ' on' : ''}`}
              onClick={() => {
                if (running) {
                  sandbox.testRps = 0;
                  setRunning(false);
                } else {
                  sandbox.testRps = Math.max(0, Number(rpsInput) || 0);
                  setRunning(true);
                }
                setEdit((v) => v + 1);
              }}
            >
              {running ? 'STOP' : 'RUN TEST LOAD'}
            </button>
            {bottlenecks.length > 0 && (
              <span className="bottleneck">
                bottleneck: {bottlenecks.map((k) => k.split('/')[1]).join(', ')}
              </span>
            )}
          </span>
        ) : (
          <span className="hint">edges appear only after Hubble observes real traffic · click a service to isolate its connections →</span>
        )}
      </div>

      <main className="stage">
        <PixelCanvas onSelect={setSelected} selected={selected} showKubeSystem={showKube} />

        {detail && (
          <aside className="panel">
            <div className="panel-head">
              <span className="swatch" style={{ background: nsColor(detail.ns, namespaces) }} />
              <strong>{detail.name}</strong>
              {sandboxOn && <span className="ghost-tag">projected</span>}
              <button className="close" onClick={() => setSelected(null)} aria-label="Close">
                x
              </button>
            </div>

            {detail.overload && (
              <div className="alert">
                ! OVERLOAD
                <br />
                CPU {Math.round(detail.cpuPct)}% ≥ {cfg.cpuPct}% of request
              </div>
            )}

            <dl>
              <dt>namespace</dt><dd>{detail.ns}</dd>
              <dt>replicas</dt>
              <dd className="mono">
                {detail.replicas}
                {detail.ready < detail.replicas ? ` (${detail.ready} ready)` : ''}
              </dd>
              <dt>node{detail.nodes.length > 1 ? 's' : ''}</dt>
              <dd className="mono wrap">{detail.nodes.join(', ') || '—'}</dd>
              <dt>CPU</dt>
              <dd className="mono">
                {detail.cpuMilli}m
                {detail.cpuReqMilli > 0 ? ` / ${detail.cpuReqMilli}m req` : ' (no request)'}
              </dd>
              <dt>CPU %</dt>
              <dd className="mono">{detail.cpuPct >= 0 ? `${Math.round(detail.cpuPct)}%` : 'n/a'}</dd>
              {detail.cpuPct >= 0 && (
                <div className={`bar${detail.overload ? ' over' : barPct > 60 ? ' hot' : ''}`}>
                  <i style={{ width: `${barPct}%` }} />
                  <span>{Math.round(barPct)}% OF THRESHOLD</span>
                </div>
              )}
              <dt>memory</dt><dd className="mono">{(detail.memBytes / 1048576).toFixed(0)} MiB</dd>
              <dt>flows in</dt><dd className="mono">{detail.rxRate.toFixed(1)}/s</dd>
              <dt>flows out</dt><dd className="mono">{detail.txRate.toFixed(1)}/s</dd>
              <dt>calls</dt>
              <dd className="mono wrap small">
                {links.downstream.length
                  ? links.downstream.map((l) => l.name + (l.hidden ? '*' : '')).join(', ')
                  : 'nothing observed'}
              </dd>
              <dt>called by</dt>
              <dd className="mono wrap small">
                {links.upstream.length
                  ? links.upstream.map((l) => l.name + (l.hidden ? '*' : '')).join(', ')
                  : 'nothing observed'}
              </dd>
            </dl>

            {sandboxOn && (
              <div className="stepper-row">
                <span className="stepper-label">replicas</span>
                <button
                  className="step"
                  onClick={() => {
                    setReplicas(detail.key, replicasOf(detail.key) - 1);
                    setEdit((v) => v + 1);
                  }}
                >
                  -
                </button>
                <span className="step-value mono">{replicasOf(detail.key)}</span>
                <button
                  className="step"
                  onClick={() => {
                    setReplicas(detail.key, replicasOf(detail.key) + 1);
                    setEdit((v) => v + 1);
                  }}
                >
                  +
                </button>
                <span className="muted step-note">
                  projected {detail.cpuPct >= 0 ? `${Math.round(detail.cpuPct)}%` : 'n/a'}
                </span>
              </div>
            )}

            <div className="replicas">
              <div className="replicas-head">
                {sandboxOn ? 'replicas at snapshot' : `replicas (${detail.replicas})`}
              </div>
              {detail.pods.map((p) => (
                <div className={`replica${p.overload ? ' over' : ''}`} key={p.key}>
                  <div className="replica-name mono">{p.name}</div>
                  <div className="replica-meta">
                    <span>{p.node || 'unscheduled'}</span>
                    <span className="mono">
                      {p.cpuMilli}m
                      {p.cpuPct >= 0 ? ` · ${Math.round(p.cpuPct)}%` : ' · n/a'}
                    </span>
                    <span className="mono">{(p.memBytes / 1048576).toFixed(0)} MiB</span>
                  </div>
                  {!p.ready && <div className="replica-warn">not ready</div>}
                </div>
              ))}
            </div>

            <p className="foot">
              {[...links.upstream, ...links.downstream].some((l) => l.hidden) && (
                <>* hidden namespace — use the kube-system toggle to show it.<br /></>
              )}
              Connections are what Hubble actually observed, not a static config.
              Aggregated across {detail.replicas} replica{detail.replicas === 1 ? '' : 's'}.
              Rates are Hubble traced flow events, not application requests — pooled
              gRPC connections serve many requests per traced flow.
            </p>
          </aside>
        )}
      </main>
    </div>
  );
}
