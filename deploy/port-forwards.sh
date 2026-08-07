#!/bin/bash
# Starts the port-forwards the demo depends on, detached so they survive the
# shell that launched them.
#
#   hubble-relay  127.0.0.1:4245  -> aggregator's Hubble gRPC source
#   frontend-proxy 127.0.0.1:8080 -> what k6 drives load against
#
# Kept in a script (rather than an inline pkill) because a `pkill -f` pattern
# mentioning "port-forward" also matches the calling shell's own command line
# and kills the caller.
export PATH="$HOME/.local/bin:$PATH"

stop() {
  for pid in $(pgrep -f "kubectl.*port-forward" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    kill "$pid" 2>/dev/null
  done
}

start_one() {
  local ns="$1" svc="$2" mapping="$3" logname="$4"
  setsid nohup kubectl -n "$ns" port-forward "svc/$svc" "$mapping" \
    --address 127.0.0.1 > "/tmp/pf_${logname}.log" 2>&1 < /dev/null &
  disown 2>/dev/null
}

case "${1:-start}" in
  stop)
    stop
    echo "stopped"
    ;;
  start)
    stop
    start_one kube-system hubble-relay 4245:80 hubble
    start_one otel-demo frontend-proxy 8080:8080 frontend
    echo "started"
    ;;
esac
