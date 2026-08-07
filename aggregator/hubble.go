package main

import (
	"context"
	"io"
	"log"
	"sync/atomic"
	"time"

	"github.com/cilium/cilium/api/v1/flow"
	"github.com/cilium/cilium/api/v1/observer"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// flowsSeen counts every flow the aggregator has accepted, for the stdout
// heartbeat and to prove on the checkpoint that data is genuinely arriving.
var flowsSeen atomic.Int64

// StreamFlows subscribes to Hubble Relay and feeds observed pod-to-pod traffic
// into the state.
//
// Two filters matter for correctness of the counts:
//
//   - Reply=false: a request/response pair would otherwise be counted as two
//     flows in opposite directions, doubling every edge and making the arrows
//     symmetric (and meaningless).
//   - TO_ENDPOINT observation point: Cilium reports the same packet at several
//     points along the datapath (FROM_ENDPOINT, TO_OVERLAY, TO_STACK,
//     TO_ENDPOINT). Counting all of them inflates rates by a variable factor
//     depending on whether the pods are on the same node. TO_ENDPOINT fires
//     once, at delivery to the receiving pod. FlowFilter has no
//     observation-point field, so this one is applied client-side.
func StreamFlows(ctx context.Context, addr string, st *State) {
	for ctx.Err() == nil {
		if err := streamOnce(ctx, addr, st); err != nil && ctx.Err() == nil {
			log.Printf("hubble: stream ended: %v (reconnecting)", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func streamOnce(ctx context.Context, addr string, st *State) error {
	// Hubble Relay is deployed without TLS in this local cluster.
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer conn.Close()

	client := observer.NewObserverClient(conn)
	req := &observer.GetFlowsRequest{
		Follow: true,
		Whitelist: []*flow.FlowFilter{{
			Verdict: []flow.Verdict{flow.Verdict_FORWARDED},
			Reply:   []bool{false},
		}},
	}

	stream, err := client.GetFlows(ctx, req)
	if err != nil {
		return err
	}
	log.Printf("hubble: subscribed to %s", addr)

	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		f := resp.GetFlow()
		if f == nil {
			continue
		}
		// Count each packet once, at delivery to the destination pod.
		if f.GetTraceObservationPoint() != flow.TraceObservationPoint_TO_ENDPOINT {
			continue
		}
		src, dst := f.GetSource(), f.GetDestination()
		if src == nil || dst == nil {
			continue
		}
		// Pod-scoped endpoints only; world/host traffic has no pod name.
		if src.GetPodName() == "" || dst.GetPodName() == "" {
			continue
		}
		// Only count flows that touched a watched pod, so the counter reflects
		// the topology on screen rather than all cluster chatter.
		if st.RecordFlow(src.GetNamespace(), src.GetPodName(), dst.GetNamespace(), dst.GetPodName()) {
			flowsSeen.Add(1)
		}
	}
}
