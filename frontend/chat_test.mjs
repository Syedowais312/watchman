import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
p.on('pageerror', e => console.log('PAGE EXC:', e.message));
// fail loudly if anything still calls out to the network
p.on('request', r => { const u = r.url(); if (!/127\.0\.0\.1|localhost/.test(u)) console.log('EXTERNAL REQUEST:', u); });
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);

const badge = await p.evaluate(() => !!document.querySelector('.watchman-badge'));
console.log('badge visible (active overload):', badge);

await p.click('.watchman-sprite, .watchman button, .watchman');
await p.waitForTimeout(700);

const qs = [
  'Did product-catalog overload in the last hour?',   // <-- the demo question
  'did the product catalog have problems today',      // rough phrasing
  'what about add the product to cart',               // must resolve to cart, not product-catalog
  'how is email doing',                               // known service, no event
  'is the database on fire',                          // no service match
];
for (const q of qs) {
  await p.fill('.watchman-input input, .watchman input[type=text]', q);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(900);
  const last = await p.evaluate(() => {
    const m = [...document.querySelectorAll('.msg-watchman')];
    return m[m.length - 1]?.textContent?.trim();
  });
  console.log(`\nQ: ${q}\nA: ${last}`);
}
await p.screenshot({ path: '/tmp/watchman_chat.png' });
await b.close();
