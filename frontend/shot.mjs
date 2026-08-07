import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });
p.on('console', m => { if (m.type()==='error') console.log('PAGE ERR:', m.text()); });
p.on('pageerror', e => console.log('PAGE EXC:', e.message));
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(Number(process.env.WAIT || 4000));
if (process.env.CLICK) {
  // click a bot to open the inspect panel
  await p.mouse.click(Number(process.env.CX), Number(process.env.CY));
  await p.waitForTimeout(900);
}
await p.screenshot({ path: process.env.OUT || '/tmp/shot.png' });
const st = await p.evaluate(() => document.querySelector('.statbar')?.textContent);
console.log('statbar:', st);
await b.close();
