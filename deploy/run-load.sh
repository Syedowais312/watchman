#!/bin/bash
# Runs the k6 ramp inside the cluster and streams its output.
#
#   ./deploy/run-load.sh            # run the ramp
#   ./deploy/run-load.sh stop       # cancel a running ramp
#
# The script lives in load/browse.js and is shipped in as a ConfigMap, so
# editing it needs no image rebuild.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."

NS=otel-demo

if [ "${1:-run}" = "stop" ]; then
  kubectl -n "$NS" delete job k6-load --ignore-not-found
  echo "stopped"
  exit 0
fi

kubectl -n "$NS" create configmap k6-script \
  --from-file=browse.js=load/browse.js \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NS" delete job k6-load --ignore-not-found --wait=true
kubectl apply -f deploy/k6-job.yaml

echo "waiting for k6 pod..."
kubectl -n "$NS" wait --for=condition=ready pod -l app.kubernetes.io/component=k6-load --timeout=120s || true
kubectl -n "$NS" logs -f job/k6-load
