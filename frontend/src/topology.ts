import type { EdgeView, PodView } from './types';

export const NODE_W = 112;
export const NODE_H = 46;
// Wide and shallow: the graph is viewed on a landscape screen, so spreading
// across columns and keeping the stack short lets the fit-zoom get closer.
const COL = 178;
const ROW = 70;
// Leaves room for the "ENTRY →" marker drawn to the left of the first column.
const ORIGIN_X = 96;
const ORIGIN_Y = 34;

/**
 * Hand-authored positions for the OpenTelemetry Demo's real architecture.
 *
 * Deliberately fixed rather than force-directed: a physics layout re-settles
 * whenever the graph changes, so nodes drift mid-demo and muscle memory for
 * "where product-catalog lives" is lost. Reading left to right is the request
 * path — entry proxy, frontend, request fan-out, then backing stores.
 */
const LAYOUT: Record<string, { col: number; row: number }> = {
  // The load generator itself, when running. Placed above the entry proxy so
  // the traffic source reads as the start of the request path rather than being
  // dropped into the auto-assigned slots with unrelated services.
  'k6-load': { col: 0, row: 1.35 },

  // entry
  'frontend-proxy': { col: 0, row: 3 },
  frontend: { col: 1, row: 3 },

  // services the frontend calls directly
  ad: { col: 2, row: 0 },
  recommendation: { col: 2, row: 1 },
  'product-catalog': { col: 2, row: 2 },
  cart: { col: 2, row: 3 },
  shipping: { col: 2, row: 4 },
  currency: { col: 2, row: 5 },

  // backing stores and dependencies, each beside the service that calls it
  flagd: { col: 3, row: 0.5 },
  'astronomy-db': { col: 3, row: 2 },
  'valkey-cart': { col: 3, row: 3 },
  quote: { col: 3, row: 4 },
  'image-provider': { col: 3, row: 5 },

  // Reachable only via checkout, which is disabled in this deployment. Parked
  // in their own column so they stay visibly edgeless rather than looking like
  // part of the request path.
  payment: { col: 4, row: 1 },
  email: { col: 4, row: 2 },

  // telemetry sink, off the request path
  'opentelemetry-collector': { col: 1, row: 5.6 },
};

/** Where the kube-system group starts when toggled on — clear of the
 * payment/email column at col 4. */
const KUBE_COL = 5.3;
const KUBE_COLS = 3;

/**
 * Slots assigned to services with no hand-authored position, kept for the
 * lifetime of the session. Assign-once means an unexpected service never
 * shuffles the ones already on screen.
 */
const autoSlots = new Map<string, { col: number; row: number }>();
let autoNext = 0;

function slotFor(ns: string, name: string): { col: number; row: number } {
  if (ns !== 'kube-system') {
    const fixed = LAYOUT[name];
    if (fixed) return fixed;
  }
  const key = ns + '/' + name;
  let s = autoSlots.get(key);
  if (!s) {
    const i = autoNext++;
    s = { col: KUBE_COL + (i % KUBE_COLS), row: Math.floor(i / KUBE_COLS) };
    autoSlots.set(key, s);
  }
  return s;
}

export interface ServiceNode {
  key: string; // "namespace/component"
  ns: string;
  name: string;
  replicas: number;
  ready: number;
  cpuMilli: number;
  cpuReqMilli: number;
  /** Aggregate CPU as % of the summed replica requests. -1 when undefined. */
  cpuPct: number;
  memBytes: number;
  rxRate: number;
  txRate: number;
  overload: boolean;
  /** True when at least one replica is individually over the threshold. */
  anyReplicaOverload: boolean;
  /** The individual replicas, kept whole so the inspect panel can show
   * per-replica CPU/memory/node rather than just a list of names. */
  pods: PodView[];
  nodes: string[];
  x: number;
  y: number;
}

export interface ServiceEdge {
  src: string;
  dst: string;
  rate: number;
}

/**
 * The single definition of "how loaded is this, relative to the threshold".
 *
 * Extracted so the live path, the sandbox replica projection and the synthetic
 * load model all decide colour and overload through the exact same comparison
 * rather than three lookalike inline expressions that can drift apart.
 * Returns 0 when CPU% is undefined (-1), i.e. no CPU request set.
 */
export function loadRatio(cpuPct: number, thresholdPct: number): number {
  if (cpuPct < 0 || thresholdPct <= 0) return 0;
  return cpuPct / thresholdPct;
}

export function isOverloaded(cpuPct: number, thresholdPct: number): boolean {
  return cpuPct >= 0 && cpuPct >= thresholdPct;
}

export function serviceKeyOf(p: PodView): string {
  return p.ns + '/' + p.component;
}

export function aggregateServices(
  pods: PodView[],
  thresholdPct: number,
  showKubeSystem: boolean,
): Map<string, ServiceNode> {
  const out = new Map<string, ServiceNode>();

  for (const p of pods) {
    if (!showKubeSystem && p.ns === 'kube-system') continue;
    const key = serviceKeyOf(p);
    let n = out.get(key);
    if (!n) {
      const slot = slotFor(p.ns, p.component);
      n = {
        key,
        ns: p.ns,
        name: p.component,
        replicas: 0,
        ready: 0,
        cpuMilli: 0,
        cpuReqMilli: 0,
        cpuPct: -1,
        memBytes: 0,
        rxRate: 0,
        txRate: 0,
        overload: false,
        anyReplicaOverload: false,
        pods: [],
        nodes: [],
        x: ORIGIN_X + slot.col * COL,
        y: ORIGIN_Y + slot.row * ROW,
      };
      out.set(key, n);
    }
    n.replicas++;
    if (p.ready) n.ready++;
    n.cpuMilli += p.cpuMilli;
    n.cpuReqMilli += p.cpuReqMilli;
    n.memBytes += p.memBytes;
    n.rxRate += p.rxRate;
    n.txRate += p.txRate;
    if (p.overload) n.anyReplicaOverload = true;
    n.pods.push(p);
    if (p.node && !n.nodes.includes(p.node)) n.nodes.push(p.node);
  }

  for (const n of out.values()) {
    n.cpuPct = n.cpuReqMilli > 0 ? (n.cpuMilli / n.cpuReqMilli) * 100 : -1;
    // Judge the service on its aggregate load, not on one noisy replica.
    n.overload = isOverloaded(n.cpuPct, thresholdPct);
    n.pods.sort((a, b) => a.name.localeCompare(b.name));
  }

  return out;
}

/**
 * Service pairs that have ever carried observed traffic.
 *
 * Edges persist once seen so the graph doesn't flicker in and out as rolling
 * windows decay — but nothing is drawn until Hubble actually reports a flow
 * for that pair, so this is never a pre-drawn fully connected graph.
 */
const observedEdges = new Map<string, ServiceEdge>();

export function updateEdges(podEdges: EdgeView[], podToService: Map<string, string>): void {
  // Current-tick rates, aggregated from pod-level to service-level.
  const live = new Map<string, number>();
  for (const e of podEdges) {
    const s = podToService.get(e.src);
    const d = podToService.get(e.dst);
    if (!s || !d || s === d) continue; // skip replica-to-replica within a service
    const k = s + '>' + d;
    live.set(k, (live.get(k) ?? 0) + e.rate);
  }

  for (const e of observedEdges.values()) e.rate = 0;

  for (const [k, rate] of live) {
    const existing = observedEdges.get(k);
    if (existing) {
      existing.rate = rate;
    } else {
      const [src, dst] = k.split('>');
      observedEdges.set(k, { src, dst, rate });
    }
  }
}

export function getObservedEdges(): ServiceEdge[] {
  return [...observedEdges.values()];
}

/** Services this one calls (downstream) and that call it (upstream). */
export function neighborsOf(key: string): { upstream: string[]; downstream: string[] } {
  const up = new Set<string>();
  const down = new Set<string>();
  for (const e of observedEdges.values()) {
    if (e.src === key) down.add(e.dst);
    if (e.dst === key) up.add(e.src);
  }
  return {
    upstream: [...up].sort(),
    downstream: [...down].sort(),
  };
}

/** Drops edges whose endpoints are no longer on screen (e.g. kube-system hidden). */
export function visibleEdges(nodes: Map<string, ServiceNode>): ServiceEdge[] {
  return [...observedEdges.values()].filter((e) => nodes.has(e.src) && nodes.has(e.dst));
}

export function hitTestNodes(
  nodes: Map<string, ServiceNode>,
  x: number,
  y: number,
): string | null {
  for (const n of nodes.values()) {
    if (x >= n.x && x <= n.x + NODE_W && y >= n.y && y <= n.y + NODE_H) return n.key;
  }
  return null;
}

export function contentBounds(nodes: Map<string, ServiceNode>): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const n of nodes.values()) {
    w = Math.max(w, n.x + NODE_W);
    h = Math.max(h, n.y + NODE_H);
  }
  return { w: w + ORIGIN_X, h: h + ORIGIN_Y };
}
