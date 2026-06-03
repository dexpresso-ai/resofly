import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

/**
 * Gerrie — drijvende AI-chatassistent (rechtsonder).
 *
 * Dit is voorlopig alléén de look & feel: er is nog geen backend gekoppeld.
 * De bedoeling is dat Gerrie straks een Claude-model achter zich heeft dat
 * échte acties in de workspace uitvoert, bijvoorbeeld:
 *   - "Maak een nieuwe klant aan met deze gegevens…"
 *   - "Verstuur een offerte naar…"
 *   - "Verstuur de factuur naar…"
 *   - "Maak een factuur voor…"
 *
 * De koppeling hoort op één plek thuis: `requestGerrieReply()` hieronder.
 * Vervang de gesimuleerde reactie door een echte call naar de agent-backend
 * en de rest van de UI werkt ongewijzigd verder.
 */

type ChatRole = 'user' | 'assistant';
interface ChatMessage { id: string; role: ChatRole; text: string }

let idSeq = 0;
const nextId = () => `gerrie-${Date.now()}-${++idSeq}`;

const INTRO_TEXT =
  'Hoi! Ik ben Gerrie, je AI-assistent. Straks kan ik dingen voor je regelen — ' +
  'een nieuwe klant aanmaken, een offerte of factuur versturen, of een factuur opstellen. ' +
  'Waar kan ik je mee helpen?';

const PREVIEW_REPLY =
  'Goed bezig! 🚧 Ik kan nog niet écht in je workspace meewerken — mijn koppeling met ' +
  'de backend wordt nog gebouwd. Binnenkort voer ik dit soort acties direct voor je uit.';

/** Voorbeeld-opdrachten die de toekomstige mogelijkheden laten zien. */
const SUGGESTIONS = [
  'Maak een nieuwe klant aan',
  'Verstuur een offerte',
  'Verstuur een factuur',
  'Maak een nieuwe factuur',
];

/**
 * 🔌 Backend-koppelpunt. Nu gesimuleerd; vervang door een echte aanroep naar de
 * Claude-agent die het bericht + de historie krijgt en een antwoord (of een
 * uitgevoerde actie) teruggeeft.
 */
async function requestGerrieReply(_message: string, _history: ChatMessage[]): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 850));
  return PREVIEW_REPLY;
}

export function GerrieChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: nextId(), role: 'assistant', text: INTRO_TEXT }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Houd de gespreksweergave onderaan zodra er iets bijkomt.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking, open]);

  // Focus de invoer wanneer het paneel opent.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: trimmed }]);
    setThinking(true);
    try {
      const history = messages;
      const reply = await requestGerrieReply(trimmed, history);
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: reply }]);
    } finally {
      setThinking(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); }
    if (e.key === 'Escape') setOpen(false);
  }

  // Eenvoudige auto-groei voor het tekstveld.
  function onInput(e: FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
    setDraft(el.value);
  }

  return (
    <div className="gerrie-root">
      {open && (
        <section className="gerrie-panel" role="dialog" aria-label="Gerrie chatassistent">
          <header className="gerrie-head">
            <span className="gerrie-avatar" aria-hidden="true"><RobotIcon /></span>
            <div className="gerrie-id">
              <div className="gerrie-name">Gerrie <span className="gerrie-badge">AI</span></div>
              <div className="gerrie-status"><span className="dot" />Online · assistent</div>
            </div>
            <button className="gerrie-head-close" onClick={() => setOpen(false)} aria-label="Chat sluiten">
              <ChevronDownIcon />
            </button>
          </header>

          <div className="gerrie-msgs" ref={scrollRef}>
            {messages.map((m) => (
              <div key={m.id} className={`gerrie-msg ${m.role}`}>
                <span className="gerrie-msg-avatar" aria-hidden="true">{m.role === 'assistant' ? <RobotIcon /> : <UserIcon />}</span>
                <div className="gerrie-bubble">{m.text}</div>
              </div>
            ))}
            {thinking && (
              <div className="gerrie-msg assistant">
                <span className="gerrie-msg-avatar" aria-hidden="true"><RobotIcon /></span>
                <div className="gerrie-typing" aria-label="Gerrie typt"><span /><span /><span /></div>
              </div>
            )}
          </div>

          {messages.length <= 1 && !thinking && (
            <div className="gerrie-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="gerrie-chip" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          )}

          <div className="gerrie-composer">
            <textarea
              ref={inputRef}
              className="gerrie-input"
              rows={1}
              placeholder="Typ een bericht aan Gerrie…"
              value={draft}
              onInput={onInput}
              onKeyDown={onKeyDown}
            />
            <button className="gerrie-send" onClick={() => void send(draft)} disabled={!draft.trim() || thinking} aria-label="Versturen">
              <SendIcon />
            </button>
          </div>
          <p className="gerrie-foot-note">Gerrie is in ontwikkeling — acties worden nog niet uitgevoerd.</p>
        </section>
      )}

      <button
        className={`gerrie-fab ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Gerrie sluiten' : 'Gerrie chatassistent openen'}
        aria-expanded={open}
      >
        {open ? <ChevronDownIcon /> : <RobotIcon />}
        {!open && <span className="gerrie-fab-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}

function RobotIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4.5V8" />
      <circle cx="12" cy="3.2" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="9.2" cy="13" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="13" r="1.15" fill="currentColor" stroke="none" />
      <path d="M9.5 16.6h5" />
      <path d="M2 12.5v3M22 12.5v3" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c0-4 3.6-6 7.5-6s7.5 2 7.5 6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
