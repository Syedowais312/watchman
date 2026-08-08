import { store } from './store';

/**
 * Watchman's brain. Two tiers, both grounded in the aggregator's /api/events
 * log so Watchman can only ever state facts it actually recorded:
 *
 *   1. Claude (Haiku 4.5), proxied through the aggregator's /api/chat so the
 *      API key never reaches the browser. The aggregator hands Claude the real
 *      event log and instructs it never to invent data.
 *   2. A rule-based matcher, used when the key isn't configured or the call
 *      fails, so the demo still answers offline.
 *
 * Either way, no data matched means an honest "I don't have that", never a guess.
 */

export interface ChatEvent {
  service: string;
  metric: string;
  peak_value: number;
  start_time: number; // unix seconds
  end_time: number | null; // unix seconds, null while ongoing
  duration: number; // seconds
  active: boolean;
}

const API = `http://${window.location.hostname}:8090/api/events`;
const CHAT_API = `http://${window.location.hostname}:8090/api/chat`;

export async function fetchEvents(): Promise<ChatEvent[]> {
  try {
    const res = await fetch(API);
    if (!res.ok) return [];
    return (await res.json()) as ChatEvent[];
  } catch {
    return [];
  }
}

/**
 * Ask Claude, proxied server-side so the API key never reaches the browser.
 * The aggregator grounds it in the real event log and tells it never to invent
 * data. Returns null when the key isn't configured or the call fails, so the
 * caller can fall back to the offline rule-based matcher.
 */
export async function askClaude(question: string): Promise<string | null> {
  try {
    const res = await fetch(CHAT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { reply?: string };
    return data.reply?.trim() || null;
  } catch {
    return null;
  }
}

export function knownServices(): string[] {
  const s = new Set<string>();
  for (const p of store.pods.values()) s.add(p.component);
  return [...s];
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Lowercase, all separators flattened — "product-catalog" == "product catalog". */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Match a service name against the question.
 *
 * Two tiers, so a whole service name always beats a word fragment that happens
 * to appear in another service ("add the product to cart" must resolve to
 * cart, not product-catalog, even though both words are in the sentence):
 *
 *   1. Exact name: the service's compact name ("productcatalog", "cart")
 *      appears in the space-stripped question. Short names (<4 chars, e.g.
 *      "ad") must match as a whole word so "overload" can't be misread.
 *   2. Fragment: one of the name's words ("catalog", "cart") matches as a
 *      whole word in the question.
 *
 * Ties go to the shorter service name ("cart" beats "valkey-cart").
 */
export function matchService(raw: string, services: string[]): string | null {
  const q = normalize(raw);
  const qc = q.replace(/\s+/g, '');
  const words = new Set(q.split(' ').filter(Boolean));
  let best: { score: number; name: string } | null = null;

  for (const svc of services) {
    const n = svc.toLowerCase();
    const compact = n.replace(/[^a-z0-9]+/g, '');
    const fragments = n.split(/[^a-z0-9]+/).filter(Boolean);

    // Tier 1: the full name.
    if (words.has(compact) || (compact.length >= 4 && qc.includes(compact))) {
      const s = 10000 + compact.length;
      if (!best || s > best.score || (s === best.score && n.length < best.name.length)) {
        best = { score: s, name: n };
      }
      continue;
    }

    // Tier 2: a word from the name, whole-word only.
    for (const w of fragments) {
      if (words.has(w)) {
        const s = 100 + w.length;
        if (!best || s > best.score || (s === best.score && n.length < best.name.length)) {
          best = { score: s, name: n };
        }
      }
    }
  }
  return best ? best.name : null;
}

/**
 * A tiny, bounded time reference. Only the forms below are understood; anything
 * fancier is ignored (the whole window then applies).
 */
export function matchTime(raw: string): { from: number; to: number } | null {
  const q = normalize(raw);
  const now = Date.now();

  if (/(just now|recently)/.test(q)) return { from: now - 5 * MINUTE, to: now };
  if (/(in the last hour|past hour|last hour|this hour)/.test(q)) return { from: now - HOUR, to: now };
  if (/(today)/.test(q)) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return { from: d.getTime(), to: now };
  }

  const m = raw.toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (m) {
    let h = Number(m[1]) % 12;
    if (m[3] === 'pm') h += 12;
    const d = new Date();
    d.setHours(h, m[2] ? Number(m[2]) : 0, 0, 0);
    return { from: d.getTime(), to: now };
  }
  return null;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ampm}`;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
}

/**
 * Build Watchman's reply. Every number comes from `events` — real logged data.
 * Empty answer is an honest "no data", never an invention.
 */
export function answerQuestion(raw: string, events: ChatEvent[], services: string[]): string {
  const q = normalize(raw);
  if (!q) {
    return "Ask me about a service — for example, 'did product-catalog overload?'";
  }

  const svc = matchService(q, services);
  if (!svc) {
    if (events.length === 0) {
      return "Nothing in the log yet. I only answer from overload events I've actually recorded, and there aren't any.";
    }
    return "I don't have anything logged for that. I can only answer from what I've measured — try asking about a service like product-catalog or cart.";
  }

  const win = matchTime(raw);
  let hits = events.filter((e) => e.service === svc);
  if (win) {
    hits = hits.filter((e) => e.start_time * 1000 >= win.from && e.start_time * 1000 <= win.to);
  }

  if (hits.length === 0) {
    const where = win ? ' in that window' : '';
    return `I don't have anything logged for ${svc}${where}. I only answer from events I actually recorded.`;
  }

  hits.sort((a, b) => Number(b.active) - Number(a.active) || b.start_time - a.start_time);
  const ev = hits[0];
  const unit = ev.metric === 'rate' ? ' flows/s' : '% CPU';
  const ongoing = ev.active ? " and it's still ongoing" : '';
  return `Yes — ${svc} hit ${Math.round(ev.peak_value)}${unit} around ${formatTime(ev.start_time * 1000)}, lasted ${formatDuration(ev.duration)}${ongoing}.`;
}
