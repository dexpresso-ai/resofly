import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { streamGerrieReply, type GerrieStatus, type GerrieProposal, type GerrieInvoiceProposal, type GerrieQuoteProposal, type GerrieClientProposal } from '../lib/gerrie-api';
import { euro } from '../lib/format';
import type { UUID } from '../types';

/**
 * Gerrie — drijvende AI-chatassistent (rechtsonder), gekoppeld aan Claude.
 *
 * De koppeling loopt via de `gerrie-agent` Edge Function (zie src/lib/gerrie-api.ts).
 * Gerrie kan in deze versie MEELEZEN in de workspace (klanten, facturen, offertes,
 * projecten, tickets, financiële cijfers). Echte acties (aanmaken/versturen) komen
 * later en vragen dan altijd eerst een bevestiging van de gebruiker.
 */

type ChatRole = 'user' | 'assistant';
interface ChatMessage { id: string; role: ChatRole; text: string; proposal?: GerrieProposal }

let idSeq = 0;
const nextId = () => `gerrie-${Date.now()}-${++idSeq}`;

const INTRO_TEXT =
  'Hoi! Ik ben Gerrie, je AI-assistent. Ik kan meekijken in je workspace — ' +
  'vraag me bijvoorbeeld naar openstaande facturen, een klant of je omzet. ' +
  'Waar kan ik je mee helpen?';

/** Voorbeeldvragen die de huidige (lees-)mogelijkheden laten zien. */
const SUGGESTIONS = [
  'Welke facturen staan open?',
  'Wat is mijn omzet dit jaar?',
  'Zoek klant op naam',
  'Welke offertes lopen er nog?',
];

export function GerrieChat({ organizationId, onCreateInvoiceDraft, onCreateQuoteDraft, onCreateClientDraft }: {
  organizationId: UUID;
  onCreateInvoiceDraft?: (proposal: GerrieInvoiceProposal) => void;
  onCreateQuoteDraft?: (proposal: GerrieQuoteProposal) => void;
  onCreateClientDraft?: (proposal: GerrieClientProposal) => void;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([{ id: nextId(), role: 'assistant', text: INTRO_TEXT }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<UUID | null>(null);
  // Resterend AI-tegoed als fractie 0..1 (null = geen limiet ingesteld / nog onbekend).
  const [budget, setBudget] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Houd de gespreksweergave onderaan zodra er iets bijkomt.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking, status, open]);

  // Focus de invoer wanneer het paneel opent.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Wissel je van organisatie, dan begint Gerrie met een schone lei.
  useEffect(() => {
    setConversationId(null);
    setBudget(null);
    setMessages([{ id: nextId(), role: 'assistant', text: INTRO_TEXT }]);
  }, [organizationId]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: trimmed }]);
    setThinking(true);
    setStatus(null);
    try {
      const result = await streamGerrieReply({
        organizationId,
        conversationId,
        message: trimmed,
        onStatus: (s: GerrieStatus) => setStatus(s.label),
      });
      setConversationId(result.conversationId);
      if (result.budget) setBudget(result.budget.remainingFraction);
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: result.text, proposal: result.proposal }]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Er ging iets mis.';
      setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: `⚠️ ${reason}` }]);
    } finally {
      setThinking(false);
      setStatus(null);
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

  // Kies de juiste voorstel-kaart + actie op basis van het type voorstel.
  function proposalCard(p: GerrieProposal) {
    if (p.type === 'invoice') return <ProposalCard title="Conceptfactuur openen & controleren" sub={`${p.client_name} · ${euro(p.total_eur)} · ${lineLabel(p.lines.length)}`} onClick={() => onCreateInvoiceDraft?.(p)} />;
    if (p.type === 'quote') return <ProposalCard title="Conceptofferte openen & controleren" sub={`${p.client_name} · ${euro(p.total_eur)} · ${lineLabel(p.lines.length)}`} onClick={() => onCreateQuoteDraft?.(p)} />;
    return <ProposalCard title="Nieuwe klant openen & controleren" sub={[p.name, p.email].filter(Boolean).join(' · ')} onClick={() => onCreateClientDraft?.(p)} />;
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
                {m.proposal ? (
                  <div className="gerrie-stack">
                    <div className="gerrie-bubble">{m.text}</div>
                    {proposalCard(m.proposal)}
                  </div>
                ) : (
                  <div className="gerrie-bubble">{m.text}</div>
                )}
              </div>
            ))}
            {thinking && (
              <div className="gerrie-msg assistant">
                <span className="gerrie-msg-avatar" aria-hidden="true"><RobotIcon /></span>
                {status
                  ? <div className="gerrie-bubble gerrie-bubble-status">{status}</div>
                  : <div className="gerrie-typing" aria-label="Gerrie typt"><span /><span /><span /></div>}
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
          {budget !== null && (
            <div className="gerrie-budget" role="status" aria-label="Resterend AI-tegoed deze maand">
              <span className="gerrie-budget-label">AI-tegoed</span>
              <span className="gerrie-budget-track">
                <span className="gerrie-budget-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ width: `${Math.round(budget * 100)}%` }} />
              </span>
              <span className="gerrie-budget-pct">{Math.round(budget * 100)}%</span>
            </div>
          )}
          <p className="gerrie-foot-note">Gerrie kan meelezen in je workspace. Acties vraagt hij straks altijd eerst ter bevestiging.</p>
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

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

function lineLabel(n: number): string { return `${n} regel${n === 1 ? '' : 's'}`; }

function ProposalCard({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  return (
    <button className="gerrie-proposal" onClick={onClick}>
      <span className="gerrie-proposal-icon" aria-hidden="true"><DocIcon /></span>
      <span className="gerrie-proposal-body">
        <span className="gerrie-proposal-title">{title}</span>
        <span className="gerrie-proposal-sub">{sub}</span>
      </span>
    </button>
  );
}
