package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

func kubeConfig(explicit string) (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}
	path := explicit
	if path == "" {
		if env := os.Getenv("KUBECONFIG"); env != "" {
			path = env
		} else {
			home, _ := os.UserHomeDir()
			path = filepath.Join(home, ".kube", "config")
		}
	}
	return clientcmd.BuildConfigFromFlags("", path)
}

// cors sets the local-dev CORS headers for /api/events, which the chat fetches
// from the Vite dev server on a different port. Returns false if the request
// was already fully handled (the OPTIONS preflight).
func cors(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r != nil && r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}

func main() {
	var (
		kubeconfig  = flag.String("kubeconfig", "", "path to kubeconfig (default: in-cluster, then $KUBECONFIG, then ~/.kube/config)")
		hubbleAddr  = flag.String("hubble", "127.0.0.1:4245", "Hubble Relay gRPC address")
		listen      = flag.String("listen", ":8090", "HTTP listen address for the WebSocket server")
		nsFlag      = flag.String("namespaces", "otel-demo,kube-system", "comma-separated namespaces to watch (empty = all)")
		metricsIvl  = flag.Duration("metrics-interval", 5*time.Second, "metrics-server poll interval")
		pushIvl     = flag.Duration("push-interval", 500*time.Millisecond, "WebSocket push interval")
		signalFlag  = flag.String("overload-signal", "cpu", "overload signal: cpu | rate")
		cpuPct      = flag.Float64("overload-cpu-pct", 200, "overload when CPU exceeds this %% of the pod's CPU request")
		rateThresh  = flag.Float64("overload-flow-rate", 50, "overload when inbound flows/sec exceeds this (only for -overload-signal=rate)")
		logState    = flag.Bool("log-state", true, "log merged state to stdout every second")
	)
	flag.Parse()

	var namespaces []string
	for _, ns := range strings.Split(*nsFlag, ",") {
		if s := strings.TrimSpace(ns); s != "" {
			namespaces = append(namespaces, s)
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() { <-sigCh; log.Printf("shutting down"); cancel() }()

	cfg, err := kubeConfig(*kubeconfig)
	if err != nil {
		log.Fatalf("kubeconfig: %v", err)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("kubernetes client: %v", err)
	}
	mc, err := metricsclient.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("metrics client: %v", err)
	}

	st := NewState(*signalFlag, *cpuPct, *rateThresh)

	if err := WatchPods(ctx, cs, st, namespaces); err != nil {
		log.Fatalf("pod watch: %v", err)
	}
	go PollMetrics(ctx, mc, st, *metricsIvl, namespaces)
	go StreamFlows(ctx, *hubbleAddr, st)

	hub := NewHub(st)
	go hub.Run(ctx, *pushIvl)

	if *logState {
		go logMergedState(ctx, st)
	}

	anthropicKey := os.Getenv("ANTHROPIC_API_KEY")

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", hub.ServeWS)
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, r *http.Request) {
		// The Vite dev server runs on :5173, so the chat's on-demand fetch is a
		// cross-origin request. Local demo tool: allow any origin.
		if !cors(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(st.Events()); err != nil {
			log.Printf("events: encode: %v", err)
		}
	})
	mux.HandleFunc("/api/chat", func(w http.ResponseWriter, r *http.Request) {
		if !cors(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Question string `json:"question"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		reply, err := AskClaude(r.Context(), anthropicKey, body.Question, st.Events())
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			log.Printf("chat: claude: %v", err)
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"reply": reply})
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, "ok flows=%d clients=%d\n", flowsSeen.Load(), hub.ClientCount())
	})

	srv := &http.Server{Addr: *listen, Handler: mux}
	go func() {
		log.Printf("aggregator: listening on %s (ws at /ws)", *listen)
		log.Printf("aggregator: overload signal=%s cpuPct=%.0f flowRate=%.0f", *signalFlag, *cpuPct, *rateThresh)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("http: %v", err)
		}
	}()

	<-ctx.Done()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer shutCancel()
	_ = srv.Shutdown(shutCtx)
}

// logMergedState prints the merged view once a second. This is the Phase 2
// checkpoint: it must visibly react to real traffic against the demo app.
func logMergedState(ctx context.Context, st *State) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pods, edges, namespaces := st.View()

			active := make([]PodView, 0, len(pods))
			overloaded := 0
			for _, p := range pods {
				if p.Overload {
					overloaded++
				}
				if p.RxRate > 0 || p.CPUMilli > 0 {
					active = append(active, p)
				}
			}
			sort.Slice(active, func(i, j int) bool { return active[i].CPUMilli > active[j].CPUMilli })

			fmt.Printf("\n=== %s | ns=%v pods=%d edges=%d flows=%d overloaded=%d ===\n",
				time.Now().Format("15:04:05"), namespaces, len(pods), len(edges), flowsSeen.Load(), overloaded)
			fmt.Printf("%-22s %8s %8s %9s %9s %s\n", "POD", "CPU(m)", "CPU%", "RX/s", "TX/s", "STATE")
			for i, p := range active {
				if i >= 10 {
					break
				}
				cpuPct := "  n/a"
				if p.CPUPct >= 0 {
					cpuPct = fmt.Sprintf("%6.0f%%", p.CPUPct)
				}
				state := ""
				if p.Overload {
					state = "OVERLOAD"
				}
				fmt.Printf("%-22s %8d %8s %9.1f %9.1f %s\n",
					truncate(p.Component, 22), p.CPUMilli, cpuPct, p.RxRate, p.TxRate, state)
			}
			for i, e := range edges {
				if i >= 6 {
					break
				}
				fmt.Printf("   edge %-28s -> %-28s %6.1f/s\n", shortKey(e.Src), shortKey(e.Dst), e.Rate)
			}
		}
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// shortKey trims the trailing ReplicaSet/pod hash so log lines stay readable.
func shortKey(k string) string {
	parts := strings.SplitN(k, "/", 2)
	if len(parts) != 2 {
		return k
	}
	name := parts[1]
	if seg := strings.Split(name, "-"); len(seg) > 2 {
		name = strings.Join(seg[:len(seg)-2], "-")
	}
	return name
}
