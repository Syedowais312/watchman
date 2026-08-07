package main

import (
	"context"
	"log"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// PollMetrics feeds per-pod CPU/memory from metrics-server into the state.
//
// metrics-server only recomputes every --metric-resolution (15s here), so
// polling faster than that just re-reads the same sample. 5s keeps latency low
// without hammering the API.
func PollMetrics(ctx context.Context, mc metricsclient.Interface, st *State, interval time.Duration, namespaces []string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	scrape := func() {
		targets := namespaces
		if len(targets) == 0 {
			targets = []string{""} // all namespaces
		}
		for _, ns := range targets {
			list, err := mc.MetricsV1beta1().PodMetricses(ns).List(ctx, metav1.ListOptions{})
			if err != nil {
				log.Printf("metrics: list %q failed: %v", ns, err)
				continue
			}
			for i := range list.Items {
				m := &list.Items[i]
				var cpu, mem int64
				for _, c := range m.Containers {
					cpu += c.Usage.Cpu().MilliValue()
					mem += c.Usage.Memory().Value()
				}
				st.SetMetrics(m.Namespace, m.Name, cpu, mem)
			}
		}
	}

	scrape()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			scrape()
		}
	}
}
