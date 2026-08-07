#!/bin/bash
# Single control script for the whole demo.
#
#   ./watchman.sh up        start everything (cluster if halted, forwards, apps)
#   ./watchman.sh down      stop the local apps + port-forwards, leave cluster up
#   ./watchman.sh halt      also stop the kind containers (frees ~4GB RAM)
#   ./watchman.sh status    show what's running
#   ./watchman.sh load      run the k6 ramp (the demo moment)
#   ./watchman.sh load-stop cancel the ramp
#   ./watchman.sh destroy   delete the cluster entirely (asks first)
#
# The helpers live in scripts rather than being typed inline because a
# `pkill -f vite` at the prompt also matches the invoking shell's own command
# line and kills your session. Patterns below use the [v]ite bracket form.
set -uo pipefail
export PATH="/usr/local/go/bin:$HOME/.local/bin:$PATH"

ROOT="$(cd "$(dirname "$0")" && pwd)"
CLUSTER=watchman
NODES=("${CLUSTER}-control-plane" "${CLUSTER}-worker" "${CLUSTER}-worker2")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

cluster_exists() {
  docker ps -a --filter "name=${CLUSTER}-control-plane" --format '{{.Names}}' | grep -q .
}

cluster_running() {
  docker ps --filter "name=${CLUSTER}-control-plane" --format '{{.Names}}' | grep -q .
}

wait_api() {
  echo -n "waiting for the Kubernetes API"
  for _ in $(seq 1 90); do
    if kubectl get --raw=/readyz >/dev/null 2>&1; then echo " - ready"; return 0; fi
    echo -n "."
    sleep 2
  done
  echo " - TIMED OUT"
  return 1
}

wait_pods() {
  echo -n "waiting for otel-demo pods"
  for _ in $(seq 1 90); do
    local bad total
    bad=$(kubectl get pods -n otel-demo --no-headers 2>/dev/null | grep -cvE 'Running|Completed')
    total=$(kubectl get pods -n otel-demo --no-headers 2>/dev/null | wc -l)
    if [ "${total:-0}" -gt 5 ] && [ "${bad:-1}" -eq 0 ]; then echo " - all ready"; return 0; fi
    echo -n "."
    sleep 3
  done
  echo " - still settling (check: kubectl get pods -n otel-demo)"
}

cmd_up() {
  if ! cluster_exists; then
    echo "No '${CLUSTER}' cluster found. Create it using the steps in README.md"
    echo "(kind create cluster --config deploy/kind-config.yaml, then the helm installs)."
    return 1
  fi

  if cluster_running; then
    say "cluster already running"
  else
    say "starting kind nodes"
    docker start "${NODES[@]}" >/dev/null
    wait_api || return 1
    # Cilium and the demo pods need a moment to resettle after a cold start.
    wait_pods
  fi

  say "starting port-forwards (hubble-relay :4245, frontend-proxy :8080)"
  "$ROOT/deploy/port-forwards.sh" start

  say "starting aggregator (:8090) and Vite (:5173)"
  "$ROOT/deploy/dev.sh" start

  say "waiting for the aggregator to subscribe to Hubble"
  for _ in $(seq 1 40); do
    grep -q 'hubble: subscribed' /tmp/agg.log 2>/dev/null && break
    sleep 1
  done

  cmd_status
  say "open http://127.0.0.1:5173   then run: ./watchman.sh load"
}

cmd_down() {
  say "stopping aggregator + Vite"
  "$ROOT/deploy/dev.sh" stop
  say "stopping port-forwards"
  "$ROOT/deploy/port-forwards.sh" stop
  echo
  echo "Cluster is still running. To free its memory too: ./watchman.sh halt"
}

cmd_halt() {
  cmd_down
  say "stopping kind nodes"
  if cluster_running; then
    docker stop "${NODES[@]}" >/dev/null
    echo "kind nodes stopped (cluster preserved on disk)"
  else
    echo "kind nodes already stopped"
  fi
  echo
  echo "Bring it all back with: ./watchman.sh up"
}

cmd_status() {
  say "status"
  if cluster_running; then
    printf 'cluster       RUNNING\n'
    kubectl get nodes --no-headers 2>/dev/null | awk '{printf "  node        %-26s %s\n", $1, $2}'
    printf '  otel-demo   %s/%s pods Running\n' \
      "$(kubectl get pods -n otel-demo --no-headers 2>/dev/null | grep -c Running)" \
      "$(kubectl get pods -n otel-demo --no-headers 2>/dev/null | wc -l)"
  elif cluster_exists; then
    printf 'cluster       STOPPED (preserved on disk - ./watchman.sh up)\n'
  else
    printf 'cluster       DOES NOT EXIST\n'
  fi

  pgrep -x aggregator >/dev/null && printf 'aggregator    RUNNING :8090\n' || printf 'aggregator    stopped\n'
  pgrep -f "[v]ite" >/dev/null   && printf 'vite          RUNNING :5173\n' || printf 'vite          stopped\n'
  local n
  n=$(pgrep -cf "[p]ort-forward" 2>/dev/null || true)
  if [ "${n:-0}" -gt 0 ]; then printf 'port-forwards RUNNING (%s)\n' "$n"; else printf 'port-forwards stopped\n'; fi

  echo
  probe() {
    # One line per endpoint. Checking the exit code rather than piping straight
    # to -w avoids printing both "HTTP 000" and a failure line for one probe.
    local label="$1" url="$2" code
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null)
    if [ "${code:-000}" = "000" ]; then
      printf '%-13s not answering (%s)\n' "$label" "$url"
    else
      printf '%-13s HTTP %s (%s)\n' "$label" "$code" "$url"
    fi
  }
  local health
  health=$(curl -s --max-time 2 http://127.0.0.1:8090/healthz 2>/dev/null)
  if [ -n "$health" ]; then
    printf '%-13s %s\n' "aggregator" "$health"
  else
    printf '%-13s not answering (http://127.0.0.1:8090/healthz)\n' "aggregator"
  fi
  probe "vite" http://127.0.0.1:5173/
  probe "demo app" http://127.0.0.1:8080/api/products
}

cmd_destroy() {
  read -r -p "Delete the '${CLUSTER}' cluster and everything in it? [y/N] " ans
  case "$ans" in
    y|Y)
      cmd_down
      say "deleting cluster"
      kind delete cluster --name "$CLUSTER"
      ;;
    *) echo "cancelled" ;;
  esac
}

case "${1:-status}" in
  up)        cmd_up ;;
  down)      cmd_down ;;
  halt)      cmd_halt ;;
  status)    cmd_status ;;
  load)      "$ROOT/deploy/run-load.sh" ;;
  load-stop) "$ROOT/deploy/run-load.sh" stop ;;
  destroy)   cmd_destroy ;;
  *)
    sed -n '3,10p' "$0" | sed 's/^#\ \{0,1\}//'
    exit 1
    ;;
esac
