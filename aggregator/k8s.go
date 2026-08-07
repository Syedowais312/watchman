package main

import (
	"context"
	"log"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
)

// componentOf returns a short human-friendly service name for a pod, falling
// back through the conventional label set before giving up on the pod name.
func componentOf(p *corev1.Pod) string {
	for _, l := range []string{
		"app.kubernetes.io/component",
		"app.kubernetes.io/name",
		"app",
		"k8s-app",
	} {
		if v, ok := p.Labels[l]; ok && v != "" {
			return v
		}
	}
	return p.Name
}

func cpuRequestMilli(p *corev1.Pod) int64 {
	var total int64
	for _, c := range p.Spec.Containers {
		if q, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			total += q.MilliValue()
		}
	}
	return total
}

func podReady(p *corev1.Pod) bool {
	for _, c := range p.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func toPodState(p *corev1.Pod) *PodState {
	return &PodState{
		Namespace:   p.Namespace,
		Name:        p.Name,
		Component:   componentOf(p),
		Node:        p.Spec.NodeName,
		Phase:       string(p.Status.Phase),
		Ready:       podReady(p),
		CPUReqMilli: cpuRequestMilli(p),
	}
}

// WatchPods maintains the topology half of the state from the Kubernetes API.
// Uses a shared informer so we get a full initial list plus a delta stream,
// rather than hand-rolling resourceVersion bookkeeping.
func WatchPods(ctx context.Context, cs kubernetes.Interface, st *State, namespaces []string) error {
	keep := map[string]bool{}
	for _, ns := range namespaces {
		keep[ns] = true
	}
	interesting := func(ns string) bool { return len(keep) == 0 || keep[ns] }

	factory := informers.NewSharedInformerFactory(cs, 10*time.Minute)
	podInformer := factory.Core().V1().Pods().Informer()

	_, err := podInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc: func(obj any) {
			p, ok := obj.(*corev1.Pod)
			if !ok || !interesting(p.Namespace) {
				return
			}
			st.UpsertPod(toPodState(p))
		},
		UpdateFunc: func(_, obj any) {
			p, ok := obj.(*corev1.Pod)
			if !ok || !interesting(p.Namespace) {
				return
			}
			st.UpsertPod(toPodState(p))
		},
		DeleteFunc: func(obj any) {
			p, ok := obj.(*corev1.Pod)
			if !ok {
				// On a missed delete the object arrives wrapped in a tombstone.
				tomb, isTomb := obj.(cache.DeletedFinalStateUnknown)
				if !isTomb {
					return
				}
				p, ok = tomb.Obj.(*corev1.Pod)
				if !ok {
					return
				}
			}
			if !interesting(p.Namespace) {
				return
			}
			st.DeletePod(p.Namespace, p.Name)
		},
	})
	if err != nil {
		return err
	}

	factory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), podInformer.HasSynced) {
		log.Printf("k8s: pod informer cache did not sync")
	} else {
		log.Printf("k8s: pod informer synced")
	}
	return nil
}
