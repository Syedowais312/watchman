import {
  getObservedEdges,
  isOverloaded,
  type ServiceEdge,
  type ServiceNode,
} from './topology';

/**
 * Sandbox mode: a frozen, editable copy of the live graph.
 *
 * Everything here is browser-side arithmetic on a snapshot. It issues no
 * kubectl calls, drives no real load, and touches no backend — while sandbox is
 * active the store stops applying live WebSocket updates entirely, so the
 * numbers on screen are the frozen ones plus whatever the projection computes.
 *
 * The projection deliberately reuses the live path's own threshold functions
 * (isOverloaded / loadRatio) rather than reimplementing colouring, so a sandbox
 * node and a live node at the same CPU% always look identical.
 */

export interface SandboxState {
  active: boolean;
  /** Deep copy of the graph at the moment sandbox was entered. */
  nodes: Map<string, ServiceNode>;
  edges: ServiceEdge[];
  /** Per-service replica count as edited by the stepper. */
  replicaOverride: Map<string, number>;
  /** Synthetic load target in req/s, 0 = off. */
  testRps: number;
}

export const sandbox: SandboxState = {
  active: false,
  nodes: new Map(),
  edges: [],
  replicaOverride: new Map(),
  testRps: 0,
};

/**
 * Below this much observed traffic there isn't enough signal to infer a
 * per-request cost, because an idle service still burns baseline CPU that has
 * nothing to do with traffic. Dividing that baseline by ~1 flow/s implied a
 * ~10 req/s ceiling on the entry proxy and starved the entire graph to 0%.
 * Services under this floor fall back to a flat default capacity instead, so an
 * idle snapshot behaves sanely; a snapshot taken under load gets real,
 * differentiated per-service capacities.
 */
const MIN_OBSERVED_TRAFFIC = 20;
/** Assumed req/s one replica can serve when we have nothing to infer from. */
const DEFAULT_CAPACITY_PER_REPLICA = 150;
const UNKNOWN_CAPACITY = 1e6;

function cloneNode(n: ServiceNode): ServiceNode {
  return { ...n, pods: [...n.pods], nodes: [...n.nodes] };
}

export function enterSandbox(
  liveNodes: Map<string, ServiceNode>,
  liveEdges: ServiceEdge[],
): void {
  sandbox.nodes = new Map();
  for (const [k, n] of liveNodes) sandbox.nodes.set(k, cloneNode(n));
  sandbox.edges = liveEdges.map((e) => ({ ...e }));
  sandbox.replicaOverride = new Map();
  sandbox.testRps = 0;
  sandbox.active = true;
}

export function exitSandbox(): void {
  sandbox.active = false;
  sandbox.nodes = new Map();
  sandbox.edges = [];
  sandbox.replicaOverride = new Map();
  sandbox.testRps = 0;
}

export function replicasOf(key: string): number {
  const override = sandbox.replicaOverride.get(key);
  if (override !== undefined) return override;
  return sandbox.nodes.get(key)?.replicas ?? 1;
}

export function setReplicas(key: string, n: number): void {
  sandbox.replicaOverride.set(key, Math.max(1, Math.min(50, Math.round(n))));
}

/**
 * CPU% contributed per unit of inbound traffic, at one replica.
 *
 * Derived from the frozen snapshot: a service that was burning a lot of CPU for
 * the traffic it was serving is expensive per request; one that stayed cool is
 * cheap. This is what makes backpressure differ per service rather than every
 * service having an identical made-up capacity.
 *
 *   cpuPct = costCoef * traffic / replicas
 *
 * which is exactly the relationship the replica projection assumes, so the
 * stepper and the load model stay consistent with each other.
 */
export function costCoef(n: ServiceNode, thresholdPct: number): number {
  if (n.cpuPct < 0) return 0; // no CPU request -> CPU% undefined, never colours
  if (n.rxRate < MIN_OBSERVED_TRAFFIC) {
    // Not enough observed traffic to infer from. Pick the cost that makes one
    // replica saturate at DEFAULT_CAPACITY_PER_REPLICA, so capacity and
    // projected CPU% stay consistent with each other by construction.
    return thresholdPct / DEFAULT_CAPACITY_PER_REPLICA;
  }
  return (n.cpuPct * n.replicas) / n.rxRate;
}

/** Inbound req/s at which a service reaches the overload threshold. */
export function capacityOf(key: string, thresholdPct: number): number {
  const n = sandbox.nodes.get(key);
  if (!n) return UNKNOWN_CAPACITY;
  const c = costCoef(n, thresholdPct);
  if (c <= 0) return UNKNOWN_CAPACITY; // no CPU request — don't invent a bottleneck
  return (thresholdPct * replicasOf(key)) / c;
}

/** Projected CPU% for a service at a given inbound rate and replica count. */
export function projectedCpuPct(key: string, inboundRps: number, thresholdPct: number): number {
  const n = sandbox.nodes.get(key);
  if (!n || n.cpuPct < 0) return -1;
  const c = costCoef(n, thresholdPct);
  if (c <= 0) return -1;
  return (c * inboundRps) / replicasOf(key);
}

/**
 * Projection with no synthetic load: just the effect of changing replica counts
 * on the frozen CPU reading. This is the formula from the spec —
 *   projected% = real CPU% * real replicas / new replicas * multiplier
 * with multiplier 1 when no test load is running.
 */
export function projectedFromReplicas(key: string): number {
  const n = sandbox.nodes.get(key);
  if (!n || n.cpuPct < 0) return -1;
  return (n.cpuPct * n.replicas) / replicasOf(key);
}

export interface Projection {
  nodes: Map<string, ServiceNode>;
  edges: ServiceEdge[];
  /** Services pinned at their ceiling by the synthetic load. */
  bottlenecks: string[];
}

/**
 * Recomputes the whole frozen graph for the current stepper values and test
 * load, and returns nodes whose cpuPct/overload fields are ready to be drawn by
 * the unmodified renderer.
 *
 * Traffic propagates from the entry service outward, split across each
 * service's outbound edges in the same proportions Hubble actually observed —
 * so the shape of the synthetic load follows the real call graph rather than a
 * guess. Each hop is clamped to min(source capacity, destination capacity),
 * which is what makes a downstream bottleneck hold back everything behind it
 * instead of each service looking healthy in isolation.
 */
export function project(thresholdPct: number, entryKey: string): Projection {
  const nodes = new Map<string, ServiceNode>();
  for (const [k, n] of sandbox.nodes) nodes.set(k, cloneNode(n));

  const edges = sandbox.edges.map((e) => ({ ...e }));
  const running = sandbox.testRps > 0;

  if (!running) {
    // Replica-only projection: no synthetic traffic, just rescale the frozen
    // CPU reading and re-decide overload with the shared threshold function.
    for (const [k, n] of nodes) {
      n.replicas = replicasOf(k);
      n.cpuPct = projectedFromReplicas(k);
      n.overload = isOverloaded(n.cpuPct, thresholdPct);
    }
    for (const e of edges) e.rate = 0;
    return { nodes, edges, bottlenecks: [] };
  }

  // --- synthetic load propagation ---
  const outByNode = new Map<string, ServiceEdge[]>();
  for (const e of edges) {
    const arr = outByNode.get(e.src) ?? [];
    arr.push(e);
    outByNode.set(e.src, arr);
  }

  const inbound = new Map<string, number>();
  const setRate = new Map<string, number>();
  for (const k of nodes.keys()) inbound.set(k, 0);
  inbound.set(entryKey, sandbox.testRps);

  // A few relaxation passes rather than a topological sort: the observed call
  // graph can contain cycles (services that call each other), which a strict
  // ordering can't handle.
  const PASSES = 8;
  for (let pass = 0; pass < PASSES; pass++) {
    const nextInbound = new Map<string, number>();
    for (const k of nodes.keys()) nextInbound.set(k, 0);
    nextInbound.set(entryKey, sandbox.testRps);

    for (const [src, outs] of outByNode) {
      const capSrc = capacityOf(src, thresholdPct);
      // A service can't emit more than it can actually serve.
      const throughput = Math.min(inbound.get(src) ?? 0, capSrc);
      const totalObserved = outs.reduce((t, e) => t + Math.max(e.rate, 0), 0);

      for (const e of outs) {
        // Split by the proportions Hubble observed; even split if it saw none.
        const share = totalObserved > 0 ? Math.max(e.rate, 0) / totalObserved : 1 / outs.length;
        const wanted = throughput * share;
        const capDst = capacityOf(e.dst, thresholdPct);
        const effective = Math.min(wanted, capSrc, capDst);
        setRate.set(e.src + '>' + e.dst, effective);
        nextInbound.set(e.dst, (nextInbound.get(e.dst) ?? 0) + effective);
      }
    }
    for (const [k, v] of nextInbound) inbound.set(k, v);
  }

  for (const e of edges) e.rate = setRate.get(e.src + '>' + e.dst) ?? 0;

  const bottlenecks: string[] = [];
  for (const [k, n] of nodes) {
    n.replicas = replicasOf(k);
    const rps = inbound.get(k) ?? 0;
    n.cpuPct = projectedCpuPct(k, rps, thresholdPct);
    n.overload = isOverloaded(n.cpuPct, thresholdPct);
    n.rxRate = rps;
    n.txRate = (outByNode.get(k) ?? []).reduce((t, e) => t + e.rate, 0);

    const cap = capacityOf(k, thresholdPct);
    // Pinned within 1% of its ceiling and actually receiving traffic.
    if (cap < UNKNOWN_CAPACITY && rps > 0 && rps >= cap * 0.99) bottlenecks.push(k);
  }

  return { nodes, edges, bottlenecks };
}

/** Snapshot the current live graph edges for freezing. */
export function currentEdges(): ServiceEdge[] {
  return getObservedEdges().map((e) => ({ ...e }));
}
