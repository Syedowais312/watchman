export interface PodView {
  key: string;
  ns: string;
  name: string;
  component: string;
  node: string;
  phase: string;
  ready: boolean;
  cpuMilli: number;
  cpuReqMilli: number;
  /** CPU as a % of the pod's CPU request. -1 when the pod has no request. */
  cpuPct: number;
  memBytes: number;
  /** Traced Hubble flow events per second, inbound. Not application RPS. */
  rxRate: number;
  txRate: number;
  overload: boolean;
  hasCpu: boolean;
}

export interface EdgeView {
  src: string;
  dst: string;
  rate: number;
  count: number;
}

export interface OverloadCfg {
  signal: string;
  cpuPct: number;
  flowRate: number;
}

export interface Snapshot {
  type: 'snapshot';
  namespaces: string[];
  pods: PodView[];
  edges: EdgeView[];
  overload: OverloadCfg;
  ts: number;
}

export interface Diff {
  type: 'diff';
  added?: PodView[];
  removed?: string[];
  updated?: PodView[];
  edges?: EdgeView[];
  ts: number;
}

export type ServerMsg = Snapshot | Diff;
