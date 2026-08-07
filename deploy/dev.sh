#!/bin/bash
# Starts (or restarts) the two local processes: the Go aggregator and the Vite
# dev server. Both are detached so they survive the shell that launched them.
#
#   ./deploy/dev.sh start
#   ./deploy/dev.sh stop
#   ./deploy/dev.sh status
#
# Kept in a script rather than inline because a `pkill -f vite` typed at the
# prompt also matches the invoking shell's own command line and kills the caller.
export PATH="/usr/local/go/bin:$HOME/.local/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

AGG_BIN=/tmp/aggregator

stop() {
  pkill -x aggregator 2>/dev/null
  for pid in $(pgrep -f "[v]ite" 2>/dev/null); do kill "$pid" 2>/dev/null; done
  for pid in $(pgrep -f "[n]pm run dev" 2>/dev/null); do kill "$pid" 2>/dev/null; done
}

case "${1:-start}" in
  stop)
    stop
    echo "stopped"
    ;;
  status)
    pgrep -x aggregator >/dev/null && echo "aggregator: running" || echo "aggregator: stopped"
    pgrep -f "[v]ite" >/dev/null && echo "vite:       running" || echo "vite:       stopped"
    pgrep -f "[p]ort-forward" >/dev/null && echo "port-fwd:   running" || echo "port-fwd:   stopped"
    curl -s --max-time 2 http://127.0.0.1:8090/healthz || echo "aggregator not answering"
    ;;
  start)
    stop
    (cd "$ROOT/aggregator" && go build -o "$AGG_BIN" .) || exit 1
    setsid nohup "$AGG_BIN" > /tmp/agg.log 2>&1 < /dev/null &
    disown 2>/dev/null
    cd "$ROOT/frontend"
    setsid nohup npm run dev -- --host 127.0.0.1 --port 5173 > /tmp/vitedev.log 2>&1 < /dev/null &
    disown 2>/dev/null
    echo "started: aggregator :8090, vite :5173"
    ;;
esac
