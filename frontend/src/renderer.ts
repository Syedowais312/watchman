import { store } from './store';
import {
  aggregateServices,
  contentBounds,
  hitTestNodes,
  NODE_H,
  NODE_W,
  serviceKeyOf,
  updateEdges,
  visibleEdges,
  type ServiceNode,
} from './topology';

// --- palette -----------------------------------------------------------
// Namespace identity is carried by a small tab on each node rather than by the
// body fill, because the body fill now encodes load. Capped at three hues:
// every namespace is on screen at once (the all-pairs case) and only the first
// three slots clear the CVD and normal-vision floors with all pairs in play.
const NS_COLORS = ['#3b82f6', '#f97316', '#10b981'];
const NS_OTHER = '#8a8a80';

// Reserved status steps for the load ramp — never categorical slots, so a state
// can't be misread as a series. Always paired with a text %, a meter and shape
// cues, never colour alone.
const CALM = '#fffbef';
const WARM = '#ffe08a';
const WARNING = '#ffc93c';
const CRITICAL = '#e23b3b';

const CREAM = '#f5e9cc';
const CREAM_DOT = '#eaddb9';
const PANEL = '#fffbef';
const INK = '#14110c';
const INK_SOFT = '#7a7060';

const PIXEL_FONT = '"Press Start 2P", ui-monospace, monospace';
const LABEL_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export function nsColor(ns: string, namespaces: string[]): string {
  const i = namespaces.indexOf(ns);
  return i >= 0 && i < NS_COLORS.length ? NS_COLORS[i] : NS_OTHER;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const r = ((pa >> 16) & 255) + (((pb >> 16) & 255) - ((pa >> 16) & 255)) * t;
  const g = ((pa >> 8) & 255) + (((pb >> 8) & 255) - ((pa >> 8) & 255)) * t;
  const bl = (pa & 255) + ((pb & 255) - (pa & 255)) * t;
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(bl)})`;
}

/** Calm -> warm -> warning -> critical, by load as a fraction of the threshold. */
function loadFill(ratio: number): string {
  if (ratio <= 0) return CALM;
  if (ratio < 0.45) return mix(CALM, WARM, ratio / 0.45);
  if (ratio < 0.8) return mix(WARM, WARNING, (ratio - 0.45) / 0.35);
  return mix(WARNING, CRITICAL, Math.min(1, (ratio - 0.8) / 0.2));
}

interface Packet {
  ax: number; ay: number;
  bx: number; by: number;
  t: number;
  dur: number;
  color: string;
  dst: string;
}

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string; size: number; gravity: number;
}

export interface RendererHandle {
  stop(): void;
  setSelected(key: string | null): void;
  setHover(x: number, y: number): void;
  setShowKubeSystem(v: boolean): void;
  hitTest(x: number, y: number): string | null;
}

export function startRenderer(canvas: HTMLCanvasElement): RendererHandle {
  const ctx = canvas.getContext('2d')!;
  let raf = 0;
  let selected: string | null = null;
  let hoverKey: string | null = null;
  let mouse = { x: -1, y: -1 };
  let showKubeSystem = false;
  let viewScale = 1;

  let nodes = new Map<string, ServiceNode>();
  const packets: Packet[] = [];
  const particles: Particle[] = [];
  const spawnCarry = new Map<string, number>();
  const bump = new Map<string, number>();
  const MAX_PACKETS = 380;
  const MAX_PARTICLES = 260;

  let last = performance.now();

  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  };

  /** Solid fill, heavy black outline, hard offset shadow — no blur. */
  const slab = (
    x: number, y: number, w: number, h: number,
    fill: string, border = 3, shadow = 4,
  ) => {
    if (shadow) px(x + shadow, y + shadow, w, h, INK);
    px(x - border, y - border, w + border * 2, h + border * 2, INK);
    px(x, y, w, h, fill);
  };

  function rebuild() {
    const thresh = store.overloadCfg.cpuPct || 200;
    nodes = aggregateServices([...store.pods.values()], thresh, showKubeSystem);

    const podToService = new Map<string, string>();
    for (const p of store.pods.values()) podToService.set(p.key, serviceKeyOf(p));
    updateEdges(store.edges, podToService);
  }

  function addParticle(p: Particle) {
    if (particles.length < MAX_PARTICLES) particles.push(p);
  }

  const centre = (n: ServiceNode) => ({ x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });

  function spawnPackets(dt: number) {
    for (const e of visibleEdges(nodes)) {
      if (e.rate <= 0) continue;
      const a = nodes.get(e.src);
      const b = nodes.get(e.dst);
      if (!a || !b) continue;

      const k = e.src + '>' + e.dst;
      const perSec = Math.min(e.rate * 1.8, 24);
      const carry = (spawnCarry.get(k) ?? 0) + perSec * dt;
      let n = Math.floor(carry);
      spawnCarry.set(k, carry - n);

      const ca = centre(a);
      const cb = centre(b);
      const color = nsColor(a.ns, store.namespaces);

      while (n-- > 0 && packets.length < MAX_PACKETS) {
        const dist = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
        packets.push({
          ax: ca.x, ay: ca.y,
          bx: cb.x, by: cb.y,
          t: 0,
          dur: Math.max(0.4, dist / 320),
          color,
          dst: e.dst,
        });
      }
    }
  }

  function drawEdges() {
    for (const e of visibleEdges(nodes)) {
      const a = nodes.get(e.src)!;
      const b = nodes.get(e.dst)!;
      const ca = centre(a);
      const cb = centre(b);

      // A persistent thin line: this pair has carried real observed traffic at
      // some point. Alpha rises with the current rate so live routes read
      // stronger without idle ones vanishing.
      const live = e.rate > 0;
      ctx.strokeStyle = live
        ? `rgba(20,17,12,${Math.min(0.5, 0.2 + e.rate * 0.03)})`
        : 'rgba(20,17,12,0.13)';
      ctx.lineWidth = live ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(ca.x, ca.y);
      ctx.lineTo(cb.x, cb.y);
      ctx.stroke();

      // Direction arrow, set back from the target so the block doesn't hide it.
      const dx = cb.x - ca.x;
      const dy = cb.y - ca.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const tipX = cb.x - ux * (NODE_W / 2 + 6);
      const tipY = cb.y - uy * (NODE_H / 2 + 2);
      ctx.fillStyle = live ? 'rgba(20,17,12,0.75)' : 'rgba(20,17,12,0.25)';
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - ux * 7 - uy * 4, tipY - uy * 7 + ux * 4);
      ctx.lineTo(tipX - ux * 7 + uy * 4, tipY - uy * 7 - ux * 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawNode(n: ServiceNode, now: number) {
    const thresh = store.overloadCfg.cpuPct || 200;
    const ratio = n.cpuPct >= 0 ? n.cpuPct / thresh : 0;
    const seed = hash(n.key);

    const b = bump.get(n.key) ?? 0;
    const lift = b > 0 ? Math.sin(b * Math.PI) * 2 : 0;
    const shake = n.overload ? Math.sin(now / 40 + seed * 3) * 2 : 0;

    const x = n.x + shake;
    const y = n.y - lift;

    let fill = loadFill(ratio);
    if (n.overload) {
      // Blink between critical and a lighter critical, so it stays alarming on
      // a bright cream background.
      fill = Math.sin(now / 115) > 0 ? CRITICAL : mix(CRITICAL, '#ffffff', 0.34);
    }

    // Secondary non-colour cue: the border thickens with load, so magnitude is
    // legible in greyscale and for colour-blind viewers.
    const border = n.overload ? 5 : ratio > 0.8 ? 4 : 3;
    slab(x, y, NODE_W, NODE_H, fill, border, 4);

    // namespace identity tab
    px(x, y, 7, NODE_H, nsColor(n.ns, store.namespaces));
    px(x + 7, y, 1, NODE_H, INK);

    const onDark = n.overload;
    // 7px rather than 8px: at NODE_W this fits "PRODUCT-CATALOG" and
    // "RECOMMENDATION" in full instead of truncating them.
    ctx.font = `7px ${PIXEL_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = onDark ? '#fff' : INK;
    const name = n.name.length > 15 ? n.name.slice(0, 14) + '…' : n.name;
    ctx.fillText(name.toUpperCase(), x + 12, y + 8);

    ctx.font = `9px ${LABEL_FONT}`;
    ctx.fillStyle = onDark ? '#ffe0e0' : INK_SOFT;
    const cpuTxt = n.cpuPct >= 0 ? `${Math.round(n.cpuPct)}%` : 'n/a';
    ctx.fillText(`x${n.replicas}  cpu ${cpuTxt}`, x + 12, y + 21);

    // load meter — redundant magnitude cue alongside the fill
    const mw = NODE_W - 20;
    px(x + 12, y + 34, mw, 6, onDark ? 'rgba(0,0,0,0.28)' : '#e7d9b6');
    if (ratio > 0) {
      px(x + 12, y + 34, Math.max(2, Math.min(mw, mw * ratio)), 6,
        n.overload ? '#fff' : ratio > 0.8 ? CRITICAL : WARNING);
    }
    ctx.globalAlpha = 0.45;
    px(x + 12, y + 34, mw, 1, INK);
    ctx.globalAlpha = 1;

    if (n.overload) {
      const t = 5;
      px(x - 3, y - 3, t, t, INK);
      px(x + NODE_W - 2, y - 3, t, t, INK);
      px(x - 3, y + NODE_H - 2, t, t, INK);
      px(x + NODE_W - 2, y + NODE_H - 2, t, t, INK);

      const bs = 16;
      const bx = x + NODE_W - 9;
      const by = y - 11;
      slab(bx, by, bs, bs, PANEL, 3, 2);
      ctx.fillStyle = CRITICAL;
      ctx.font = `9px ${PIXEL_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', bx + bs / 2, by + bs / 2 + 1);

      if (Math.random() < 0.18) {
        addParticle({
          x: x + 8 + Math.random() * (NODE_W - 16),
          y: y - 2,
          vx: (Math.random() - 0.5) * 16,
          vy: -24 - Math.random() * 16,
          life: 0, maxLife: 0.7, color: '#ffffff', size: 4, gravity: -6,
        });
      }
    }

    if (n.ready < n.replicas) {
      // Hatch when replicas aren't all ready, so "starting" never reads as load.
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 8, y, NODE_W - 8, NODE_H);
      ctx.clip();
      ctx.strokeStyle = 'rgba(20,17,12,0.35)';
      ctx.lineWidth = 3;
      for (let i = -NODE_H; i < NODE_W; i += 9) {
        ctx.beginPath();
        ctx.moveTo(x + i, y + NODE_H);
        ctx.lineTo(x + i + NODE_H, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (selected === n.key || hoverKey === n.key) {
      const c = selected === n.key ? INK : INK_SOFT;
      const bx = x - 8, by = y - 8;
      const bw = NODE_W + 16, bh = NODE_H + 16;
      const L = 7;
      px(bx, by, L, 3, c); px(bx, by, 3, L, c);
      px(bx + bw - L, by, L, 3, c); px(bx + bw - 3, by, 3, L, c);
      px(bx, by + bh - 3, L, 3, c); px(bx, by + bh - L, 3, L, c);
      px(bx + bw - L, by + bh - 3, L, 3, c); px(bx + bw - 3, by + bh - L, 3, L, c);
    }
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    rebuild();

    // background (unscaled, so the dither pitch stays constant)
    px(0, 0, cssW, cssH, CREAM);
    ctx.fillStyle = CREAM_DOT;
    for (let y = 0; y < cssH; y += 10) {
      for (let x = y % 20 === 0 ? 0 : 5; x < cssW; x += 10) ctx.fillRect(x, y, 2, 2);
    }

    // Fit the fixed layout to the viewport. Node positions never change; only
    // the zoom does, so the graph never rearranges itself mid-session.
    const bounds = contentBounds(nodes);
    viewScale = bounds.w > 0 && bounds.h > 0
      ? Math.max(0.5, Math.min(2.2, Math.min(cssW / bounds.w, cssH / bounds.h)))
      : 1;
    ctx.scale(viewScale, viewScale);

    hoverKey = mouse.x >= 0 ? hitTestNodes(nodes, mouse.x / viewScale, mouse.y / viewScale) : null;

    // Entry marker, placed to the left of the proxy rather than above it: above
    // collides with the overload "!" badge exactly when the demo matters most.
    const entry = nodes.get('otel-demo/frontend-proxy');
    if (entry) {
      ctx.font = `7px ${PIXEL_FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = INK_SOFT;
      ctx.fillText('ENTRY →', entry.x - 10, entry.y + NODE_H / 2);
    }

    drawEdges();

    spawnPackets(dt);
    for (let i = packets.length - 1; i >= 0; i--) {
      const q = packets[i];
      q.t += dt / q.dur;
      if (q.t >= 1) {
        bump.set(q.dst, 1);
        for (let k = 0; k < 3; k++) {
          addParticle({
            x: q.bx, y: q.by,
            vx: (Math.random() - 0.5) * 70,
            vy: (Math.random() - 0.5) * 70,
            life: 0, maxLife: 0.26, color: q.color, size: 3, gravity: 24,
          });
        }
        packets.splice(i, 1);
        continue;
      }
      const x = q.ax + (q.bx - q.ax) * q.t;
      const y = q.ay + (q.by - q.ay) * q.t;
      px(x - 4, y - 4, 8, 8, INK);
      px(x - 2, y - 2, 4, 4, q.color);
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const s = particles[i];
      s.life += dt;
      if (s.life >= s.maxLife) {
        particles.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += s.gravity * dt;
      ctx.globalAlpha = 1 - s.life / s.maxLife;
      px(s.x, s.y, s.size, s.size, s.color);
      ctx.globalAlpha = 1;
    }

    for (const [k, v] of bump) {
      const nv = v - dt * 3.4;
      if (nv <= 0) bump.delete(k);
      else bump.set(k, nv);
    }

    for (const n of nodes.values()) drawNode(n, now);

    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    stop: () => cancelAnimationFrame(raf),
    setSelected: (k) => { selected = k; },
    setHover: (x, y) => { mouse = { x, y }; },
    setShowKubeSystem: (v) => { showKubeSystem = v; },
    hitTest: (x, y) => hitTestNodes(nodes, x / viewScale, y / viewScale),
  };
}
