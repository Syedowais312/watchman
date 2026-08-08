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

# Stream the run, keeping a copy so the outcome can be checked afterwards.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
kubectl -n "$NS" logs -f job/k6-load 2>&1 | tee "$LOG"

# Fail loudly on the known startup flake. Checked *after* streaming rather than
# in a background subshell, because `logs -f` returns immediately when the pod
# dies and would kill a backgrounded checker before it ran. Without this the
# ramp dies silently, nothing lights up, and the demo merely looks
# unimpressive instead of obviously broken.
if grep -q 'fsnotify watcher' "$LOG"; then
  cat >&2 <<'MSG'

  ============================================================
  k6 FAILED TO START - no load was generated.

    failed to create fsnotify watcher: too many open files

  This host's inotify instance limit (128) is exhausted; a busy
  desktop session is usually enough to do it. One-line fix:

    sudo sysctl -w fs.inotify.max_user_instances=512

  Then re-run ./deploy/run-load.sh
  ============================================================

MSG
  exit 1
fi

if grep -qE 'level=error|thresholds.*crossed' "$LOG"; then
  echo >&2
  echo "note: k6 reported errors above - check http_req_failed before trusting the run." >&2
fi
