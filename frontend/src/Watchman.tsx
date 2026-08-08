import { useEffect, useRef, useState } from 'react';
import { answerQuestion, fetchEvents, knownServices, type ChatEvent } from './chat';

interface Msg {
  role: 'user' | 'watchman';
  text: string;
}

const SPRITE: Record<string, string> = {
  '0': '#14110c', // ink
  '1': '#fffbef', // panel
  '2': '#3b82f6', // blue
  '3': '#ffc93c', // accent
  '4': '#f97316', // orange
  '5': '#e23b3b', // critical
};

// A 10x14 pixel mascot: helmet, face, chest badge, legs.
const ROWS = [
  '  222222  ',
  ' 22222222 ',
  '2222222222',
  '1111111111',
  '1101111011',
  '1111111111',
  '1100330011',
  '1111111111',
  '2222222222',
  '2222332222', // chest badge (turns red while an event is hot)
  '2222222222',
  '2222222222',
  '0 0 00 0 0',
  '0 0 00 0 0',
];

const RECENT_MS = 2 * 60 * 1000;

export function Watchman() {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the event log warm so the badge reflects reality without waiting for
  // a question. The chat re-fetches on submit anyway.
  useEffect(() => {
    let alive = true;
    const poll = () => fetchEvents().then((ev) => alive && setEvents(ev));
    poll();
    const id = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  const hot = events.some((e) => {
    if (e.active) return true;
    const end = (e.end_time ?? e.start_time) * 1000;
    return Date.now() - end < RECENT_MS;
  });

  const ask = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', text: q }]);
    setBusy(true);
    const fresh = await fetchEvents();
    setEvents(fresh);
    // Rule-based only: no LLM call, no external network. Every reply is
    // templated from events the aggregator actually logged, so Watchman can't
    // invent a service, a number, or an incident that never happened.
    const reply = answerQuestion(q, fresh, knownServices());
    setMsgs((m) => [...m, { role: 'watchman', text: reply }]);
    setBusy(false);
  };

  return (
    <div className="watchman">
      {open && (
        <div className="watchman-chat">
          <div className="watchman-chat-head">
            <span className="logo" />
            WATCHMAN
            <button className="close" onClick={() => setOpen(false)} aria-label="Close chat">
              x
            </button>
          </div>
          <div className="watchman-msgs" ref={listRef}>
            {msgs.length === 0 && (
              <div className="msg msg-watchman">
                I'm Watchman. I only answer from overload events I've actually recorded — nothing
                from anywhere else. Ask me, for example, whether product-catalog overloaded.
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`msg msg-${m.role}`}>
                {m.text}
              </div>
            ))}
            {busy && (
              <div className="msg msg-watchman typing" aria-label="Watchman is thinking">
                <i />
                <i />
                <i />
              </div>
            )}
          </div>
          <form
            className="watchman-input"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="ask about a service…"
              aria-label="Ask Watchman"
            />
            <button type="submit" disabled={busy}>
              {busy ? '…' : '>'}
            </button>
          </form>
        </div>
      )}

      <button
        className="watchman-sprite"
        onClick={() => setOpen((v) => !v)}
        aria-label="Talk to Watchman"
      >
        {hot && <span className="watchman-badge">!</span>}
        {ROWS.map((row, r) => (
          <div className="wm-row" key={r}>
            {[...row].map((ch, c) => (
              <i
                key={c}
                className="wm-px"
                style={{
                  background: r === 9 && hot ? SPRITE['5'] : SPRITE[ch] ?? 'transparent',
                }}
              />
            ))}
          </div>
        ))}
      </button>
    </div>
  );
}
