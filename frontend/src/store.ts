import { sandbox } from './sandbox';
import type { EdgeView, OverloadCfg, PodView, ServerMsg } from './types';

/**
 * The live store is a plain mutable object, deliberately NOT React state.
 *
 * The WebSocket handler mutates it directly and the requestAnimationFrame loop
 * reads it. Putting pod/flow state in React state would re-render the tree on
 * every 500ms tick (and every field within it), which visibly stutters the
 * canvas. React only ever sees low-frequency things: connection status, the
 * namespace list, and which pod is selected.
 */
export interface LiveStore {
  pods: Map<string, PodView>;
  edges: EdgeView[];
  namespaces: string[];
  overloadCfg: OverloadCfg;
  connected: boolean;
  /** Bumped whenever the set of pod keys changes, so layout can be recomputed. */
  topologyVersion: number;
  lastMessageAt: number;
}

export const store: LiveStore = {
  pods: new Map(),
  edges: [],
  namespaces: [],
  overloadCfg: { signal: 'cpu', cpuPct: 200, flowRate: 50 },
  connected: false,
  topologyVersion: 0,
  lastMessageAt: 0,
};

function refreshNamespaces() {
  const seen = new Set<string>();
  for (const p of store.pods.values()) seen.add(p.ns);
  store.namespaces = [...seen].sort();
}

export type StatusListener = (connected: boolean) => void;
export type TopologyListener = () => void;

const statusListeners = new Set<StatusListener>();
const topologyListeners = new Set<TopologyListener>();

export function onStatus(fn: StatusListener) {
  statusListeners.add(fn);
  return () => {
    statusListeners.delete(fn);
  };
}

export function onTopology(fn: TopologyListener) {
  topologyListeners.add(fn);
  return () => {
    topologyListeners.delete(fn);
  };
}

function setConnected(v: boolean) {
  if (store.connected === v) return;
  store.connected = v;
  statusListeners.forEach((f) => f(v));
}

function bumpTopology() {
  store.topologyVersion++;
  refreshNamespaces();
  topologyListeners.forEach((f) => f());
}

function apply(msg: ServerMsg) {
  // Sandbox freezes the graph: live updates are dropped on the floor rather
  // than buffered, so what's on screen stays exactly the snapshot the user
  // started editing. The socket stays open so "back to live" resumes instantly.
  if (sandbox.active) return;

  store.lastMessageAt = performance.now();

  if (msg.type === 'snapshot') {
    store.pods = new Map(msg.pods.map((p) => [p.key, p]));
    store.edges = msg.edges ?? [];
    store.overloadCfg = msg.overload;
    bumpTopology();
    return;
  }

  let topologyChanged = false;
  for (const p of msg.added ?? []) {
    store.pods.set(p.key, p);
    topologyChanged = true;
  }
  for (const k of msg.removed ?? []) {
    if (store.pods.delete(k)) topologyChanged = true;
  }
  for (const p of msg.updated ?? []) {
    store.pods.set(p.key, p);
  }
  store.edges = msg.edges ?? [];
  if (topologyChanged) bumpTopology();
}

let ws: WebSocket | null = null;
let reconnectTimer: number | undefined;

export function connect(url: string) {
  if (ws) return;

  const open = () => {
    ws = new WebSocket(url);

    ws.onopen = () => setConnected(true);

    ws.onmessage = (ev) => {
      try {
        apply(JSON.parse(ev.data) as ServerMsg);
      } catch {
        // A malformed frame shouldn't kill the stream; the next tick supersedes it.
      }
    };

    const reopen = () => {
      setConnected(false);
      ws = null;
      window.clearTimeout(reconnectTimer);
      // Simple fixed retry — a demo tool doesn't need backoff.
      reconnectTimer = window.setTimeout(open, 1000);
    };

    ws.onclose = reopen;
    ws.onerror = () => ws?.close();
  };

  open();
}
