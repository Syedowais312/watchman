package main

import (
	"sort"
	"sync"
	"time"
)

// windowSec is the rolling window, in seconds, over which flow rates are
// averaged. Short enough that starting k6 shows up on the canvas within a
// couple of seconds, long enough that the number doesn't flicker.
const windowSec = 10

// ring is a fixed-size per-second bucket ring used for rolling counts. Buckets
// are addressed by (unix second % windowSec) and lazily zeroed as time moves
// forward, so an idle pod decays to zero instead of holding a stale rate.
type ring struct {
	buckets [windowSec]int64
	lastSec int64
}

func (r *ring) advance(now int64) {
	if r.lastSec == 0 {
		r.lastSec = now
		return
	}
	if now <= r.lastSec {
		return
	}
	if now-r.lastSec >= windowSec {
		r.buckets = [windowSec]int64{}
	} else {
		for s := r.lastSec + 1; s <= now; s++ {
			r.buckets[s%windowSec] = 0
		}
	}
	r.lastSec = now
}

func (r *ring) add(now, n int64) {
	r.advance(now)
	r.buckets[now%windowSec] += n
}

func (r *ring) total(now int64) int64 {
	r.advance(now)
	var sum int64
	for _, b := range r.buckets {
		sum += b
	}
	return sum
}

func (r *ring) rate(now int64) float64 {
	return float64(r.total(now)) / float64(windowSec)
}

// PodState is the merged per-pod view: topology from the K8s watch, CPU/memory
// from metrics-server, and traffic from Hubble.
type PodState struct {
	Namespace string
	Name      string
	Component string // app.kubernetes.io/component, the human-friendly service name
	Node      string
	Phase     string
	Ready     bool

	CPUMilli    int64 // from metrics-server
	MemBytes    int64 // from metrics-server
	CPUReqMilli int64 // summed container requests, from the pod spec

	rx ring // flows with this pod as destination
	tx ring // flows with this pod as source

	// metricsSeen is false until metrics-server has reported for this pod, so
	// the UI can distinguish "0% CPU" from "no data yet".
	metricsSeen bool
}

func (p *PodState) key() string { return p.Namespace + "/" + p.Name }

// cpuPct is CPU usage as a percentage of the pod's CPU request. Returns -1 when
// the pod has no CPU request, since the ratio is undefined rather than zero.
func (p *PodState) cpuPct() float64 {
	if p.CPUReqMilli <= 0 {
		return -1
	}
	return float64(p.CPUMilli) / float64(p.CPUReqMilli) * 100
}

type edgeKey struct{ Src, Dst string }

type edgeState struct {
	count ring
}

// State is the whole in-memory world. No persistence: everything here is a
// rolling window over live data.
type State struct {
	mu    sync.RWMutex
	pods  map[string]*PodState
	edges map[edgeKey]*edgeState

	// Overload rule, resolved at startup from flags.
	overloadSignal    string // "cpu" or "rate"
	cpuPctThreshold   float64
	flowRateThreshold float64
}

func NewState(signal string, cpuPct, flowRate float64) *State {
	return &State{
		pods:              map[string]*PodState{},
		edges:             map[edgeKey]*edgeState{},
		overloadSignal:    signal,
		cpuPctThreshold:   cpuPct,
		flowRateThreshold: flowRate,
	}
}

func (s *State) UpsertPod(p *PodState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.pods[p.key()]; ok {
		// Preserve the rolling flow windows and metrics across topology updates;
		// a pod update event carries no traffic or CPU data.
		existing.Component = p.Component
		existing.Node = p.Node
		existing.Phase = p.Phase
		existing.Ready = p.Ready
		existing.CPUReqMilli = p.CPUReqMilli
		return
	}
	s.pods[p.key()] = p
}

func (s *State) DeletePod(namespace, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := namespace + "/" + name
	delete(s.pods, key)
	for k := range s.edges {
		if k.Src == key || k.Dst == key {
			delete(s.edges, k)
		}
	}
}

// SetMetrics records a metrics-server sample. Pods absent from the topology are
// ignored rather than created, so the K8s watch stays the source of truth.
func (s *State) SetMetrics(namespace, name string, cpuMilli, memBytes int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pods[namespace+"/"+name]
	if !ok {
		return
	}
	p.CPUMilli = cpuMilli
	p.MemBytes = memBytes
	p.metricsSeen = true
}

// RecordFlow counts one observed Hubble flow. Endpoints not in the topology are
// still counted on the side that is known, so pod->world traffic isn't lost.
// Reports whether either endpoint matched a watched pod.
func (s *State) RecordFlow(srcNS, srcName, dstNS, dstName string) bool {
	now := time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()

	srcKey, dstKey := "", ""
	if srcNS != "" && srcName != "" {
		srcKey = srcNS + "/" + srcName
		if p, ok := s.pods[srcKey]; ok {
			p.tx.add(now, 1)
		} else {
			srcKey = ""
		}
	}
	if dstNS != "" && dstName != "" {
		dstKey = dstNS + "/" + dstName
		if p, ok := s.pods[dstKey]; ok {
			p.rx.add(now, 1)
		} else {
			dstKey = ""
		}
	}
	if srcKey == "" || dstKey == "" || srcKey == dstKey {
		return srcKey != "" || dstKey != ""
	}
	k := edgeKey{Src: srcKey, Dst: dstKey}
	e, ok := s.edges[k]
	if !ok {
		e = &edgeState{}
		s.edges[k] = e
	}
	e.count.add(now, 1)
	return true
}

// --- wire types ---

type PodView struct {
	Key       string  `json:"key"`
	Namespace string  `json:"ns"`
	Name      string  `json:"name"`
	Component string  `json:"component"`
	Node      string  `json:"node"`
	Phase     string  `json:"phase"`
	Ready     bool    `json:"ready"`
	CPUMilli  int64   `json:"cpuMilli"`
	CPUReq    int64   `json:"cpuReqMilli"`
	CPUPct    float64 `json:"cpuPct"` // -1 when no CPU request is set
	MemBytes  int64   `json:"memBytes"`
	RxRate    float64 `json:"rxRate"` // flows/sec inbound
	TxRate    float64 `json:"txRate"` // flows/sec outbound
	Overload  bool    `json:"overload"`
	HasCPU    bool    `json:"hasCpu"`
}

type EdgeView struct {
	Src   string  `json:"src"`
	Dst   string  `json:"dst"`
	Rate  float64 `json:"rate"`  // flows/sec over the window
	Count int64   `json:"count"` // raw flows in the window
}

// Snapshot is the full world, sent to each client on connect.
type Snapshot struct {
	Type       string     `json:"type"` // "snapshot"
	Namespaces []string   `json:"namespaces"`
	Pods       []PodView  `json:"pods"`
	Edges      []EdgeView `json:"edges"`
	Overload   OverloadCfg `json:"overload"`
	TS         int64      `json:"ts"`
}

// Diff carries only what changed since the previous tick.
type Diff struct {
	Type     string     `json:"type"` // "diff"
	Added    []PodView  `json:"added,omitempty"`
	Removed  []string   `json:"removed,omitempty"`
	Updated  []PodView  `json:"updated,omitempty"`
	Edges    []EdgeView `json:"edges,omitempty"`
	TS       int64      `json:"ts"`
}

type OverloadCfg struct {
	Signal        string  `json:"signal"`
	CPUPct        float64 `json:"cpuPct"`
	FlowRate      float64 `json:"flowRate"`
}

func (s *State) overloadedLocked(p *PodState, now int64) bool {
	switch s.overloadSignal {
	case "rate":
		return p.rx.rate(now) >= s.flowRateThreshold
	default: // "cpu"
		pct := p.cpuPct()
		if pct < 0 {
			return false // no CPU request -> signal undefined, never blink
		}
		return pct >= s.cpuPctThreshold
	}
}

// View materialises the current merged state as wire types.
func (s *State) View() ([]PodView, []EdgeView, []string) {
	now := time.Now().Unix()
	s.mu.Lock()
	defer s.mu.Unlock()

	pods := make([]PodView, 0, len(s.pods))
	nsSet := map[string]struct{}{}
	for _, p := range s.pods {
		nsSet[p.Namespace] = struct{}{}
		pods = append(pods, PodView{
			Key:       p.key(),
			Namespace: p.Namespace,
			Name:      p.Name,
			Component: p.Component,
			Node:      p.Node,
			Phase:     p.Phase,
			Ready:     p.Ready,
			CPUMilli:  p.CPUMilli,
			CPUReq:    p.CPUReqMilli,
			CPUPct:    p.cpuPct(),
			MemBytes:  p.MemBytes,
			RxRate:    p.rx.rate(now),
			TxRate:    p.tx.rate(now),
			Overload:  s.overloadedLocked(p, now),
			HasCPU:    p.metricsSeen,
		})
	}
	sort.Slice(pods, func(i, j int) bool {
		if pods[i].Namespace != pods[j].Namespace {
			return pods[i].Namespace < pods[j].Namespace
		}
		return pods[i].Name < pods[j].Name
	})

	edges := make([]EdgeView, 0, len(s.edges))
	for k, e := range s.edges {
		c := e.count.total(now)
		if c == 0 {
			// Window has fully decayed; drop the edge so stale links disappear.
			delete(s.edges, k)
			continue
		}
		edges = append(edges, EdgeView{
			Src:   k.Src,
			Dst:   k.Dst,
			Rate:  float64(c) / float64(windowSec),
			Count: c,
		})
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].Rate > edges[j].Rate })

	namespaces := make([]string, 0, len(nsSet))
	for ns := range nsSet {
		namespaces = append(namespaces, ns)
	}
	sort.Strings(namespaces)

	return pods, edges, namespaces
}

func (s *State) Config() OverloadCfg {
	return OverloadCfg{Signal: s.overloadSignal, CPUPct: s.cpuPctThreshold, FlowRate: s.flowRateThreshold}
}
