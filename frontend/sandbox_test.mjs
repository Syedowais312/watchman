import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
p.on('pageerror', e => console.log('PAGE EXC:', e.message));
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);

const live = await p.evaluate(() => document.querySelector('.statbar')?.textContent);
console.log('LIVE   :', live?.slice(0, 70));

await p.click('.sandbox-btn');
await p.waitForTimeout(1200);
console.log('SANDBOX:', (await p.evaluate(() => document.querySelector('.sandbox-btn')?.textContent))?.trim());

// run synthetic load
await p.fill('.rps', '400');
await p.click('.sandbox-load .toggle');
await p.waitForTimeout(2500);
console.log('BOTTLENECK:', (await p.evaluate(() => document.querySelector('.bottleneck')?.textContent)) ?? 'none');
console.log('STATS  :', (await p.evaluate(() => document.querySelector('.statbar')?.textContent))?.slice(0, 60));
await p.screenshot({ path: '/tmp/sandbox_load.png' });

// click a node and scale it up
await p.mouse.click(800, 422);
await p.waitForTimeout(600);
const before = await p.evaluate(() => document.querySelector('.step-note')?.textContent);
for (let i = 0; i < 5; i++) { await p.click('.stepper-row .step:last-of-type'); await p.waitForTimeout(120); }
await p.waitForTimeout(900);
const after = await p.evaluate(() => document.querySelector('.step-note')?.textContent);
const reps = await p.evaluate(() => document.querySelector('.step-value')?.textContent);
console.log(`SCALE  : ${before} -> ${after} at ${reps} replicas`);
await p.screenshot({ path: '/tmp/sandbox_scaled.png' });
await b.close();
