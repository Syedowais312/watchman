# watchman — live pixel service topology

A live view of a real Kubernetes cluster. Services render as pixel blocks, real
request traffic is drawn as moving dots along observed edges, and a service
turns red when it crosses a measured overload threshold.

Every number on screen comes from a live source. There is no simulated or
mocked data anywhere in the wired path.

```
Kubernetes API (watch)  ──┐
metrics-server API      ──┼──▶  Go aggregator (in-memory)  ──▶  WebSocket ──▶  pixel canvas
Hubble Relay (GetFlows) ──┘
```

k6 generates **real HTTP traffic against the real app** — it never injects
events into the WebSocket stream or the frontend.

---

## Start / stop

One script drives everything. Assumes the cluster already exists (see
*Cluster setup*).

```bash
./watchman.sh up          # start it all, then open http://127.0.0.1:5173
./watchman.sh load        # the demo moment (~2m20s of k6)
./watchman.sh status      # what's running

./watchman.sh down        # stop the apps, leave the cluster running
./watchman.sh halt        # also stop the kind containers (frees ~4GB RAM)
./watchman.sh destroy     # delete the cluster entirely (asks first)
```

`up` is idempotent — safe to re-run, and it restarts the kind containers if
`halt` stopped them. A full `halt` → `up` cycle is verified: all 3 nodes return
Ready, 17/17 demo pods come back, and both Cilium/Hubble and metrics-server
recover on their own.

Use `down` between code changes (fast). Use `halt` when you're done for the day
and want the memory back. Only `destroy` requires rebuilding from *Cluster
setup* afterwards.

The individual helpers still work if you'd rather drive the layers separately:
`deploy/port-forwards.sh`, `deploy/dev.sh`, `deploy/run-load.sh`.

### What to expect

- **0–35s** — everything calm and cream-coloured, `IDLE`.
- **~40s** — meters fill, blocks warm to yellow, badge flips to `TRAFFIC`.
- **~60–110s** — `frontend`, `product-catalog`, `recommendation`,
  `astronomy-db` and `frontend-proxy` cross the threshold, blink red with `!`
  badges, and the badge flips to `HEAVY LOAD`.
- **~135s** — load ramps down and everything returns to calm.

Measured at peak on this cluster: `product-catalog` 852%, `frontend` 632%,
`astronomy-db` 262%, `frontend-proxy` 218%, ~550 flows/s.

---

## The overload signal

**CPU as a percentage of the pod's CPU request. Threshold: 200%.**

Chosen after measuring both candidate signals against this specific app under
real load, not guessed up front:

| service | idle | under load | % of 50m request |
|---|---|---|---|
| product-catalog | 2m | 1699m | **3398%** |
| frontend | 8m | 865m | **1730%** |
| recommendation | 14m | 767m | **1534%** |
| astronomy-db | 3m | 677m | **1354%** |
| frontend-proxy | 15m | 214m | **428%** |
| shipping / quote / email | 1–3m | 1–3m | ~6% (off this path) |

Idle tops out at 30% of request; loaded services land at 428–3398%. The 200%
threshold sits in a wide empty gap, so it never flaps, and services genuinely
off the request path correctly stay calm.

**Request rate was rejected as the primary signal.** The flow-count sampling
was non-monotonic — `product-catalog` measured 1289 flows/5s *idle* but blank
*under load*, and `currency`/`quote` went blank under load, because the Hubble
CLI drops events at high volume. Flow data is excellent for *drawing* traffic
and useless for *gating* a blink.

Change it without touching code:

```bash
/tmp/aggregator -overload-cpu-pct 150
/tmp/aggregator -overload-signal rate -overload-flow-rate 50   # the rejected alternative
```

The UI reads the threshold from the server's snapshot, so it never hardcodes it.

---

## Design notes

**Services, not pods.** Nodes aggregate replicas: CPU% is
`sum(usage) / sum(requests)`, so one noisy replica can't light up a service
that is fine overall. The inspect panel lists the underlying pods.

**Fixed positions.** Node coordinates are hand-authored in
`frontend/src/topology.ts` from the OTel Demo's real architecture. A
force-directed layout re-settles whenever the graph changes, so nodes drift
mid-demo — bad when you're pointing at a screen. Services with no authored
position get an assign-once slot that never shuffles the existing ones.

**Edges are earned.** A line is drawn between two services only after Hubble
has actually observed a flow for that pair. Nothing is pre-drawn from a config
file. `payment` and `email` stay visibly edgeless because they're only
reachable via `checkout`, which is disabled here — that's real, not a bug.
Once seen, an edge persists (dimmed) so the graph doesn't flicker as rolling
windows decay.

**React owns the shell only.** The canvas is mounted once via a ref and driven
by a plain `requestAnimationFrame` loop reading a mutable store that the
WebSocket handler mutates directly. Live pod state never enters React state —
that would re-render on every 500ms tick and visibly stutter. React state is
limited to connection status, namespace list, selected service, and the
kube-system toggle. Summary counters sample the store at 4Hz.

**Colour is not the only cue.** Overload adds a heavier border, corner bolts,
a `!` badge, a shake, and steam particles; border thickness also grows with
load. Namespace identity lives in a tab on the node's left edge, separate from
the body fill which encodes load. Palette validated for colour-blind
separation against the cream surface (worst all-pairs CVD ΔE 11.5, normal
vision 26.5). Namespace hues are capped at three because all namespaces are on
screen simultaneously and only the first three slots clear the all-pairs
floors.

**Flow rates are labelled "flows/s", not "req/s".** They're Hubble traced flow
events. Pooled gRPC connections serve many application requests per traced
flow, so calling them requests would overstate what the number means.

---

## Cluster setup

```bash
kind create cluster --config deploy/kind-config.yaml     # disableDefaultCNI: true

helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium --version 1.20.0 -n kube-system \
  -f deploy/cilium-values.yaml

helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm install metrics-server metrics-server/metrics-server --version 3.13.1 \
  -n kube-system -f deploy/metrics-server-values.yaml

helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm install otel-demo open-telemetry/opentelemetry-demo --version 0.41.0 \
  -n otel-demo --create-namespace -f deploy/otel-demo-values.yaml
```

Versions in use: kind 0.32.0 (k8s 1.36.1), Cilium 1.20.0, metrics-server 0.8.1,
OTel Demo chart 0.41.0 (app 3.0.0), k6 2.1.0, Helm 3.21.3, Go 1.26.

### Deliberate deviations

- **Helm 3, not Helm 4.** 4.2.3 is current, but the Cilium and OTel charts are
  tested against 3 — not the place to absorb a major-version risk.
- **Trimmed the demo chart.** Jaeger/Prometheus/Grafana/OpenSearch/eBPF-profiler
  are disabled: several GiB, and this project *is* the observability view.
- **The bundled load-generator is disabled.** If it ran continuously, services
  would already be lit at t=0 and starting k6 would produce no visible change.
- **kafka is disabled**, which forces disabling `accounting`, `fraud-detection`
  and `checkout` (its init container blocks on `kafka:9092`). Kafka is a ~600MB
  pull and those services barely light up under browsing traffic.
- **CPU requests added** to 13 services. The chart ships memory limits but *no
  CPU resources at all*, which leaves "CPU% of request" undefined — there'd be
  no denominator to calibrate against. Requests, not limits, so nothing is
  CFS-throttled mid-demo.

---

## Gotchas hit on this machine

- **`kind load docker-image` fails** on Docker 29's containerd image store with
  `content digest ... not found`. Workaround used throughout:
  `docker save --platform linux/amd64 <img> -o x.tar && kind load image-archive x.tar`.
- **k6 sometimes dies at startup** with `failed to create fsnotify watcher: too
  many open files`. This host has `fs.inotify.max_user_instances=128` (kind
  recommends 512) and a busy desktop session already consumes most of it, so
  whether k6 starts depends on what else is running at that moment — it is
  intermittent, not deterministic.

  Piping the script in on stdin (which the Job does) does **not** avoid this:
  k6 creates the watcher regardless. The real fix is one command:

  ```bash
  sudo sysctl -w fs.inotify.max_user_instances=512     # persist in /etc/sysctl.d/
  ```

  `run-load.sh` detects this failure and says so, because the dangerous
  version of this bug is the silent one: the ramp dies, nothing lights up, and
  the demo just looks unimpressive rather than broken.
- **Don't drive load through `kubectl port-forward`.** It's a single-process TCP
  proxy: at 60 VUs it dropped **18% of requests** and the load never reached the
  backends, so nothing lit up. In-cluster, 5 VUs alone sustain ~426 req/s at 0%
  errors. This is why `run-load.sh` runs k6 as a pod.
- **Don't type `pkill -f vite`** (or any pattern matching your own command
  line) — `-f` matches the invoking shell too and kills your session. That's why
  the helpers live in scripts.

## Layout

```
aggregator/     Go service: pod watch, metrics polling, Hubble stream, WebSocket
  state.go      merged in-memory state + rolling windows
  k8s.go        client-go shared informer
  metrics.go    metrics-server polling
  hubble.go     Hubble Relay GetFlows subscription
  ws.go         snapshot-on-connect, then diffs
frontend/       Vite + React shell around a plain-canvas renderer
  topology.ts   service aggregation + hand-authored positions + observed edges
  renderer.ts   the rAF draw loop (no React)
  store.ts      mutable store the WebSocket mutates directly
load/browse.js  k6 ramp
deploy/         cluster values, k6 Job, helper scripts
```
