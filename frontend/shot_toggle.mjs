import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(3500);
await p.click('.toggle');           // flip kube-system ON
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/kube_on.png' });
console.log('statbar:', await p.evaluate(() => document.querySelector('.statbar')?.textContent));
await b.close();
