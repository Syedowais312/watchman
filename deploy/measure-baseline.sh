#!/bin/bash
# Measures idle vs. under-load CPU and Hubble flow rate for the OTel demo pods.
# Used to pick the overload threshold against real numbers instead of guessing.
export PATH="$HOME/.local/bin:$PATH"
OUT=/tmp/baseline
mkdir -p $OUT

sample() {
  local tag="$1"
  kubectl top pods -n otel-demo --no-headers 2>/dev/null \
    | awk -v t="$tag" '{gsub(/m$/,"",$2); print t"\tCPU\t"$1"\t"$2}' >> $OUT/samples.tsv
  timeout 5 hubble observe --server 127.0.0.1:4245 -f --namespace otel-demo -o json 2>/dev/null \
    | jq -r 'select(.flow.destination.namespace=="otel-demo")
             | (.flow.destination.labels[]? | select(startswith("k8s:app.kubernetes.io/component")))' 2>/dev/null \
    | sed 's|k8s:app.kubernetes.io/component=||' | sort | uniq -c \
    | awk -v t="$tag" '{print t"\tFLOWS5s\t"$2"\t"$1}' >> $OUT/samples.tsv
}

rm -f $OUT/samples.tsv

echo "--- idle samples ---"
sample idle
sleep 5
sample idle

echo "--- starting load ---"
# Real HTTP traffic through the real frontend-proxy. Not injected events.
for w in $(seq 1 24); do
  ( end=$((SECONDS+70))
    while [ $SECONDS -lt $end ]; do
      curl -s -o /dev/null http://127.0.0.1:8080/api/products
      curl -s -o /dev/null "http://127.0.0.1:8080/api/recommendations?productIds="
      curl -s -o /dev/null "http://127.0.0.1:8080/api/data?contextKeys=telescopes"
    done ) &
done

sleep 25
echo "--- load samples ---"
sample load
sleep 5
sample load
wait
echo DONE_MEASURE
