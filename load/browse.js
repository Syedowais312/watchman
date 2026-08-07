import http from 'k6/http';
import { check, sleep } from 'k6';

// Load generator for the watchman demo.
//
// Drives REAL HTTP traffic through the OTel demo's frontend-proxy. Nothing here
// touches the aggregator or the WebSocket stream — pods light up because they
// are genuinely doing work, and Hubble/metrics-server observe that work.
//
// Run:  k6 run load/browse.js
// The demo moment is the ramp at ~40s, where the canvas goes from dark to
// several blocks blinking.

// Defaults to the in-cluster Service. kubectl port-forward is a single-process
// TCP proxy and became the bottleneck at 60 VUs (18% of requests failed and the
// load never reached the backends), so the load generator runs as a pod instead.
// To drive it from the host anyway: BASE=http://127.0.0.1:8080 k6 run load/browse.js
const BASE = __ENV.BASE || 'http://frontend-proxy:8080';

// Each request path fans out to a different backend, so the whole graph lights
// up rather than one hot pod:
//   /api/products        -> product-catalog -> astronomy-db
//   /api/recommendations -> recommendation  -> product-catalog
//   /api/data            -> ad              -> flagd
//   /api/shipping        -> shipping        -> quote
//   /api/cart            -> cart            -> valkey-cart
//   /api/currency        -> currency
const PRODUCT_IDS = [
  '0PUK6V6EV0', '1YMWWN1N4O', '2ZYFJ3GM2N', '66VCHSJNUP',
  '6E92ZMYYFZ', '9SIQT8TOJO', 'L9ECAV7KIM', 'LS4PSXUNUM', 'OLJCESPC7Z',
];
const CATEGORIES = ['telescopes', 'binoculars', 'accessories', 'books', 'travel'];

export const options = {
  scenarios: {
    browse: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        // Sized against measurement: in-cluster, 5 VUs alone sustain ~426 req/s
        // with 0% errors. Pushing to 140 VUs drove the cluster into timeouts,
        // which paradoxically LOWERS CPU (requests fail instead of doing work)
        // and the blink never fires. 35 VUs is the sweet spot on this box.
        { duration: '15s', target: 4 },   // quiet baseline — nodes stay calm
        { duration: '20s', target: 12 },  // warming up — load meters fill
        { duration: '45s', target: 35 },  // THE MOMENT — services cross 200%
        { duration: '45s', target: 35 },  // hold, so it can be talked over
        { duration: '15s', target: 2 },   // ramp down — blinking subsides
      ],
      gracefulRampDown: '10s',
    },
  },
  // A demo cluster under deliberate overload will be slow; that's the point.
  // Only fail the run if requests actually error out.
  thresholds: {
    checks: ['rate>0.90'],
  },
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const id = pick(PRODUCT_IDS);
  const category = pick(CATEGORIES);

  // A browsing session, roughly what a real user does.
  const res = http.batch([
    ['GET', `${BASE}/api/products`, null, { tags: { name: 'products' } }],
    ['GET', `${BASE}/api/products/${id}`, null, { tags: { name: 'product' } }],
    ['GET', `${BASE}/api/recommendations?productIds=${id}`, null, { tags: { name: 'recommendations' } }],
    ['GET', `${BASE}/api/data?contextKeys=${category}`, null, { tags: { name: 'ads' } }],
  ]);

  check(res[0], { 'products 200': (r) => r.status === 200 });
  check(res[2], { 'recommendations 200': (r) => r.status === 200 });

  // Cart + shipping exercise valkey, shipping and quote.
  const itemList = encodeURIComponent(JSON.stringify([{ productId: id, quantity: 1 }]));
  const address = encodeURIComponent(
    JSON.stringify({
      streetAddress: '1600 Amphitheatre Parkway',
      city: 'Mountain View',
      state: 'CA',
      country: 'US',
      zipCode: '94043',
    }),
  );

  const tail = http.batch([
    ['GET', `${BASE}/api/cart`, null, { tags: { name: 'cart' } }],
    ['GET', `${BASE}/api/currency`, null, { tags: { name: 'currency' } }],
    [
      'GET',
      `${BASE}/api/shipping?itemList=${itemList}&currencyCode=USD&address=${address}`,
      null,
      { tags: { name: 'shipping' } },
    ],
  ]);
  check(tail[0], { 'cart 200': (r) => r.status === 200 });

  // Short think-time: the point is to saturate, not to model a real user.
  sleep(0.2 + Math.random() * 0.3);
}
