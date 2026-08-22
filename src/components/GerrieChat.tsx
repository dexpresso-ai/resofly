import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { streamGerrieReply, confirmGerrieAction, loadGerrieBudget, type GerrieStatus, type GerrieActionHandlers, type GerrieProposal } from '../lib/gerrie-api';
import { euro, formatMinutes } from '../lib/format';
import { supabase } from '../lib/supabase';
import { AgentBatchBoard, asBatchProposal } from './AgentBatchBoard';
import { isFormBackedProposal, openProposal, proposalLabel, proposalVerb, type ProposalKind } from '../lib/gerrie-proposals';
import type { UUID } from '../types';

/**
 * Gerrie — drijvende AI-chatassistent (rechtsonder), gekoppeld aan Claude.
 *
 * De koppeling loopt via de `gerrie-agent` Edge Function (zie src/lib/gerrie-api.ts).
 * Gerrie leest mee in de workspace (klanten, facturen, offertes, projecten, tickets,
 * financiële cijfers) én voert acties uit: versturen, aanmaken, wijzigen. Nooit uit
 * zichzelf — elke actie komt eerst als kaart in dit gesprek en gebeurt pas als de
 * gebruiker daarop akkoord geeft.
 */

type ChatRole = 'user' | 'assistant';
interface ChatMessage { id: string; role: ChatRole; text: string; proposal?: GerrieProposal; auditId?: string }

let idSeq = 0;
const nextId = () => `gerrie-${Date.now()}-${++idSeq}`;

/**
 * Startbericht van Gerrie: een tijdgebonden begroeting (goedemorgen/-middag/
 * -avond) met — indien beschikbaar — de voornaam van de gebruiker, gevolgd door
 * een vlot hulpzinnetje. De begroeting wordt berekend op het moment dat het
 * bericht wordt gemaakt (chat openen / organisatie wisselen).
 */
function buildIntro(firstName: string | null): string {
  const hour = new Date().getHours();
  const greeting =
    hour < 6 ? 'Goedenavond' : hour < 12 ? 'Goedemorgen' : hour < 18 ? 'Goedemiddag' : 'Goedenavond';
  const hello = firstName ? `${greeting}, ${firstName}! 👋` : `${greeting}! 👋`;
  return (
    `${hello}\n` +
    'Klaar voor een productieve dag? ✨ Vraag me gerust naar je facturen, offertes, ' +
    'klanten of planning — of laat me snel je cijfers checken. Waar kan ik je mee helpen?'
  );
}

/** Eerste letter hoofdletter, rest klein — voor nette weergave van een voornaam. */
function capitalizeName(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Bepaalt een voornaam voor de begroeting uit de auth-gebruiker. Voorkeur voor
 * een echte naam uit de account-metadata (bv. via Google-login); valt anders
 * terug op het deel vóór de @ van het e-mailadres, maar alléén als dat eruitziet
 * als een losse voornaam. Lukt niets, dan null → begroeting zonder naam.
 */
function deriveFirstName(user: { email?: string | null; user_metadata?: Record<string, unknown> } | null): string | null {
  if (!user) return null;
  const meta = user.user_metadata ?? {};
  for (const key of ['first_name', 'given_name', 'voornaam', 'full_name', 'name']) {
    const raw = meta[key];
    if (typeof raw === 'string' && raw.trim()) {
      return capitalizeName(raw.trim().split(/\s+/)[0]);
    }
  }
  const local = (user.email ?? '').split('@')[0] ?? '';
  const candidate = local.split(/[._\-+]/)[0] ?? '';
  // Alleen overnemen bij een geloofwaardige losse voornaam (geen samengeplakte
  // volledige naam zoals "gerjanvanlopik"), anders liever geen naam tonen.
  if (/^[a-z]{2,12}$/i.test(candidate)) return capitalizeName(candidate);
  return null;
}

/** Voorbeeldvragen die de huidige (lees-)mogelijkheden laten zien. */
const SUGGESTIONS = [
  'Welke facturen staan open?',
  'Wat is mijn omzet dit jaar?',
  'Zoek klant op naam',
  'Welke offertes lopen er nog?',
];

// ── Spraakherkenning (Web Speech API, browser-native) ────────────────────────
// De browser transcribeert live; geen backend en geen kosten. Niet elke browser
// ondersteunt dit (Chrome/Edge wel, Firefox niet, iOS wisselend) — de mic-knop
// verschijnt daarom alleen als de API bestaat. De uitgesproken tekst belandt in
// het invoerveld zodat de gebruiker hem nakijkt vóór verzenden (Gerrie kan
// acties uitvoeren, dus niet automatisch versturen).
interface SpeechAlternativeLike { transcript: string }
interface SpeechResultLike { isFinal: boolean; 0: SpeechAlternativeLike }
interface SpeechResultListLike { length: number; [index: number]: SpeechResultLike }
interface SpeechResultEventLike { resultIndex: number; results: SpeechResultListLike }
interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const SpeechRecognitionImpl: SpeechRecognitionCtor | undefined =
  typeof window === 'undefined'
    ? undefined
    : (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition;
const speechSupported = Boolean(SpeechRecognitionImpl);

export function GerrieChat({ organizationId, ...handlers }: { organizationId: UUID } & GerrieActionHandlers) {
  // De losse handlers blijven met hun eigen naam in beeld (dat leest prettiger in de
  // kaarten hieronder), maar we houden ook de hele set bij de hand: "Openen" geeft een
  // voorstel door aan de gedeelde openProposal, en die verwacht het complete pakket.
  const {
    onApplyProposal, onRunRegistryAction, onSendInvoice, onSendQuote, onConvertQuote, onSendReminders,
    onCreateCalendarEvent, onCreateWeekAction, onLogTimeEntry, onSendClientEmail, onCreateAgent,
    onAddTicketNote, onEditTimeEntry, onEditCalendarEvent, onCancelCalendarEvent,
    onCreateClientContact, onEditClientContact, onSetProjectTeam, onAssignTask, onCreateCampaign,
  } = handlers;
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState<string | null>(null);
  const firstNameRef = useRef<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(() => [{ id: nextId(), role: 'assistant', text: buildIntro(null) }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<UUID | null>(null);
  // Resterend AI-tegoed als fractie 0..1 (null = geen limiet ingesteld / nog onbekend).
  const [budget, setBudget] = useState<number | null>(null);

  // Spraakherkenning: actief-luisteren + een korte melding bij microfoonproblemen.
  const [listening, setListening] = useState(false);
  const [micNote, setMicNote] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechBaseRef = useRef('');   // tekst in het veld bij start (inspreken vult aan)
  const speechFinalRef = useRef('');  // opgebouwde definitieve transcriptie deze sessie

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Houd de gespreksweergave onderaan zodra er iets bijkomt.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, thinking, status, open]);

  // Focus de invoer wanneer het paneel opent.
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  // Haal het resterende tegoed op zodra de chat opent, zodat de balk meteen verschijnt
  // (nog vóór het eerste bericht). null = geen limiet ingesteld → geen balk.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadGerrieBudget(organizationId).then((f) => { if (!cancelled && f !== null) setBudget(f); });
    return () => { cancelled = true; };
  }, [open, organizationId]);

  // Houd de hoogte van het tekstveld kloppend, ook bij programmatische wijziging (spraak).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  // Stop met luisteren als het paneel sluit; breek de herkenner af bij unmount.
  useEffect(() => { if (!open) recognitionRef.current?.stop(); }, [open]);
  useEffect(() => () => recognitionRef.current?.abort(), []);

  // Haal eenmalig de voornaam van de ingelogde gebruiker op voor een persoonlijke
  // begroeting. Lukt het niet, dan blijft het startbericht zonder naam.
  useEffect(() => {
    let active = true;
    void supabase.auth.getUser().then(({ data }) => {
      if (active) setFirstName(deriveFirstName(data.user));
    });
    return () => { active = false; };
  }, []);

  // Personaliseer het startbericht zodra de voornaam binnen is — maar alleen
  // zolang het gesprek nog niet is begonnen (enkel het introbericht in beeld).
  useEffect(() => {
    firstNameRef.current = firstName;
    setMessages((prev) =>
      prev.length === 1 && prev[0].role === 'assistant' && !conversationId
        ? [{ ...prev[0], text: buildIntro(firstName) }]
        : prev);
  }, [firstName, conversationId]);

  // Wissel je van organisatie, dan begint Gerrie met een schone lei.
  useEffect(() => {
    setConversationId(null);
    setBudget(null);
    setMessages([{ id: nextId(), role: 'assistant', text: buildIntro(firstNameRef.current) }]);
  }, [organizationId]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || thinking) return;
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: trimmed }]);
    setThinking(true);
    setStatus(null);

    const assistantId = nextId();
    let streamed = '';
    let placed = false;
    try {
      const result = await streamGerrieReply({
        organizationId,
        conversationId,
        message: trimmed,
        onStatus: (s: GerrieStatus) => setStatus(s.label),
        onDelta: (delta: string) => {
          streamed += delta;
          if (!placed) {
            placed = true;
            setThinking(false);
            setStatus(null);
            setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', text: streamed }]);
          } else {
            setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, text: streamed } : m)));
          }
        },
      });
      setConversationId(result.conversationId);
      if (result.budget) setBudget(result.budget.remainingFraction);
      // Finaliseer: definitieve tekst + eventueel een voorstel op het bericht zetten.
      setMessages((prev) => {
        const finalMsg: ChatMessage = { id: assistantId, role: 'assistant', text: result.text, proposal: result.proposal, auditId: result.auditId };
        return prev.some((m) => m.id === assistantId)
          ? prev.map((m) => (m.id === assistantId ? finalMsg : m))
          : [...prev, finalMsg];
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Er ging iets mis.';
      setMessages((prev) => {
        const errMsg: ChatMessage = { id: assistantId, role: 'assistant', text: `⚠️ ${reason}` };
        return prev.some((m) => m.id === assistantId)
          ? prev.map((m) => (m.id === assistantId ? errMsg : m))
          : [...prev, errMsg];
      });
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

  // ── Inspreken (Web Speech API) ─────────────────────────────────────────────
  function stopDictation() { recognitionRef.current?.stop(); }

  function startDictation() {
    if (!SpeechRecognitionImpl || thinking || listening) return;
    setMicNote(null);
    // Vanaf de huidige tekst beginnen zodat inspreken aanvult i.p.v. overschrijft.
    speechBaseRef.current = draft ? `${draft.replace(/\s+$/, '')} ` : '';
    speechFinalRef.current = '';
    const recognition = new SpeechRecognitionImpl();
    recognition.lang = 'nl-NL';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) speechFinalRef.current += text;
        else interim += text;
      }
      setDraft(`${speechBaseRef.current}${speechFinalRef.current}${interim}`.slice(0, 4000));
    };
    recognition.onerror = (event) => {
      setListening(false);
      recognitionRef.current = null;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') setMicNote('Geef de browser toegang tot je microfoon om in te spreken.');
      else if (event.error === 'no-speech') setMicNote('Ik hoorde niets — probeer het nog eens.');
      else if (event.error !== 'aborted') setMicNote('Spraakherkenning lukte even niet. Probeer het opnieuw.');
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      setDraft((d) => d.replace(/\s+$/, ''));
      inputRef.current?.focus();
    };
    recognitionRef.current = recognition;
    try { recognition.start(); setListening(true); }
    catch { setListening(false); recognitionRef.current = null; }
  }

  function toggleDictation() { if (listening) stopDictation(); else startDictation(); }

  // Meld een uitgevoerde/mislukte actie terug voor de audit (best-effort).
  async function runConfirmed<T>(auditId: string | undefined, action: () => Promise<T>): Promise<T> {
    try {
      const result = await action();
      if (auditId) void confirmGerrieAction(organizationId, auditId, 'executed');
      return result;
    } catch (e) {
      if (auditId) void confirmGerrieAction(organizationId, auditId, 'failed', e instanceof Error ? e.message : undefined);
      throw e;
    }
  }

  /** Icoon per soort voorstel — dezelfde indeling als de goedkeurwachtrij. */
  function kindIcon(kind: ProposalKind): ReactNode {
    if (kind === 'mail') return <MailIcon />;
    if (kind === 'agenda') return <CalendarIcon />;
    if (kind === 'insight') return <ChartIcon />;
    if (kind === 'agent') return <RobotIcon />;
    return <DocIcon />;
  }

  // Kies de juiste voorstel-kaart + actie op basis van het type voorstel.
  function proposalCard(p: GerrieProposal, auditId?: string) {
    // De concept-voorstellen (factuur, offerte, klant, project, taak, ticket, notitie,
    // leverancier, inkoopfactuur, contract, rapportage) delen één kaart. "Aanmaken"
    // schrijft het écht weg; "Openen" zet het eerst vooringevuld in het scherm, voor
    // wie de regels of de grootboekrekeningen zelf wil nalopen. De teksten komen uit
    // dezelfde bron als de wachtrij, zodat beide plekken hetzelfde beloven.
    // Een handeling uit de registry: de server schreef de titel en het onderschrift,
    // dus hier is er niets meer te bedenken — alleen uitvoeren of laten staan.
    if (p.type === 'action') {
      return <ConfirmActionCard
        icon={kindIcon(p.kind)}
        title={`${p.title}?`}
        sub={p.sub}
        confirmLabel={proposalVerb(p)} pendingLabel="Bezig…" doneLabel={p.title}
        onConfirm={() => runConfirmed(auditId, () => onRunRegistryAction
          ? onRunRegistryAction(p)
          : Promise.reject(new Error('Uitvoeren is hier niet beschikbaar.')))}
      />;
    }
    if (isFormBackedProposal(p)) {
      const info = proposalLabel(p);
      const verb = proposalVerb(p);
      return <ConfirmActionCard
        icon={kindIcon(info.kind)}
        title={`${info.title}?`}
        sub={info.sub}
        confirmLabel={verb} pendingLabel={`${verb}…`} doneLabel={info.title}
        secondaryLabel="Openen" onSecondary={() => openProposal(p, handlers)}
        onConfirm={() => runConfirmed(auditId, () => onApplyProposal
          ? onApplyProposal(p)
          : Promise.reject(new Error('Uitvoeren is hier niet beschikbaar.')))}
      />;
    }
    if (p.type === 'send_invoice') return <ConfirmActionCard icon={<MailIcon />} title={`Factuur ${p.number} versturen?`} sub={`Naar ${p.recipient_email}${p.client_name ? ` · ${p.client_name}` : ''}`} confirmLabel="Versturen" pendingLabel="Versturen…" doneLabel={`Factuur ${p.number} verstuurd naar ${p.recipient_email}`} onConfirm={() => runConfirmed(auditId, () => onSendInvoice ? onSendInvoice(p) : Promise.reject(new Error('Versturen is hier niet beschikbaar.')))} />;
    if (p.type === 'send_quote') return <ConfirmActionCard icon={<MailIcon />} title={`Offerte ${p.number} versturen?`} sub={`Naar ${p.recipient_email}${p.client_name ? ` · ${p.client_name}` : ''}`} confirmLabel="Versturen" pendingLabel="Versturen…" doneLabel={`Offerte ${p.number} verstuurd naar ${p.recipient_email}`} onConfirm={() => runConfirmed(auditId, () => onSendQuote ? onSendQuote(p) : Promise.reject(new Error('Versturen is hier niet beschikbaar.')))} />;
    if (p.type === 'convert_quote') return <ConfirmActionCard icon={<DocIcon />} title={`Offerte ${p.number} omzetten naar factuur?`} sub={`${p.client_name} · ${euro(p.total_eur)}`} confirmLabel="Omzetten" pendingLabel="Omzetten…" doneLabel={`Factuur gemaakt van offerte ${p.number}`} onConfirm={() => runConfirmed(auditId, () => onConvertQuote ? onConvertQuote(p) : Promise.reject(new Error('Omzetten is hier niet beschikbaar.')))} />;
    if (p.type === 'week_action') return <ConfirmActionCard icon={<CalendarIcon />} title={`${p.total} actiepunt${p.total === 1 ? '' : 'en'} toevoegen?`} sub={p.items.map((i) => i.title).join(' · ')} confirmLabel="Toevoegen" pendingLabel="Toevoegen…" doneLabel={`${p.total} actiepunt${p.total === 1 ? '' : 'en'} toegevoegd`} onConfirm={() => runConfirmed(auditId, () => onCreateWeekAction ? onCreateWeekAction(p) : Promise.reject(new Error('Toevoegen is hier niet beschikbaar.')))} />;
    if (p.type === 'calendar_event') return <ConfirmActionCard icon={<CalendarIcon />} title="Agenda-item aanmaken?" sub={`${p.title} · ${p.date} ${p.start_time}–${p.end_time} · ${p.source_name}`} confirmLabel="Aanmaken" pendingLabel="Aanmaken…" doneLabel={`Agenda-item aangemaakt: ${p.title}`} onConfirm={() => runConfirmed(auditId, () => onCreateCalendarEvent ? onCreateCalendarEvent(p) : Promise.reject(new Error('Aanmaken is hier niet beschikbaar.')))} />;
    if (p.type === 'time_entry') {
      const target = [p.client_name, p.project_name].filter(Boolean).join(' · ') || 'geen koppeling';
      return <ConfirmActionCard icon={<ClockIcon />} title={`${formatMinutes(p.minutes)} registreren?`} sub={`${target} · ${p.date} · ${p.billable ? 'declarabel' : 'niet-declarabel'}`} confirmLabel="Registreren" pendingLabel="Registreren…" doneLabel={`${formatMinutes(p.minutes)} geregistreerd${p.project_name ? ` op ${p.project_name}` : ''}`} onConfirm={() => runConfirmed(auditId, () => onLogTimeEntry ? onLogTimeEntry(p) : Promise.reject(new Error('Registreren is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'edit_calendar_event') {
      const wordt = `${p.changes.date ?? p.current.date} ${p.changes.start_time ?? p.current.start_time}–${p.changes.end_time ?? p.current.end_time}`;
      return <ConfirmActionCard icon={<CalendarIcon />} title={`Agenda-item "${p.title}" aanpassen?`}
        sub={`${p.current.date} ${p.current.start_time}–${p.current.end_time}  →  ${wordt} · ${p.source_name}`}
        confirmLabel="Aanpassen" pendingLabel="Aanpassen…" doneLabel={`"${p.title}" aangepast`}
        onConfirm={() => runConfirmed(auditId, () => onEditCalendarEvent ? onEditCalendarEvent(p) : Promise.reject(new Error('Aanpassen is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'cancel_calendar_event') {
      return <ConfirmActionCard icon={<CalendarIcon />} title={`Agenda-item "${p.title}" afzeggen?`}
        sub={`${p.date} ${p.start_time} · ${p.source_name}${p.has_attendees ? ' — genodigden krijgen een afzegging' : ''}`}
        confirmLabel="Afzeggen" pendingLabel="Afzeggen…" doneLabel={`"${p.title}" afgezegd`}
        onConfirm={() => runConfirmed(auditId, () => onCancelCalendarEvent ? onCancelCalendarEvent(p) : Promise.reject(new Error('Afzeggen is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'client_contact') {
      return <ConfirmActionCard icon={<UserIcon />} title={`Contactpersoon ${p.name} toevoegen bij ${p.client_name}?`}
        sub={[p.role, p.email, p.gives_portal_access ? 'krijgt toegang tot het klantportaal' : 'geen portaaltoegang'].filter(Boolean).join(' · ')}
        confirmLabel="Toevoegen" pendingLabel="Toevoegen…" doneLabel={`${p.name} toegevoegd bij ${p.client_name}`}
        onConfirm={() => runConfirmed(auditId, () => onCreateClientContact ? onCreateClientContact(p) : Promise.reject(new Error('Toevoegen is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'edit_client_contact') {
      const portaal = p.changes.gives_portal_access === true ? 'krijgt portaaltoegang'
        : p.changes.gives_portal_access === false ? 'verliest portaaltoegang' : '';
      return <ConfirmActionCard icon={<UserIcon />} title={`Contactpersoon ${p.name} wijzigen?`}
        sub={[p.client_name, portaal].filter(Boolean).join(' · ')}
        confirmLabel="Wijzigen" pendingLabel="Wijzigen…" doneLabel={`${p.name} bijgewerkt`}
        onConfirm={() => runConfirmed(auditId, () => onEditClientContact ? onEditClientContact(p) : Promise.reject(new Error('Wijzigen is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'project_team') {
      const sub = [
        p.add.length ? `erbij: ${p.add.map((m) => m.name).join(', ')}` : '',
        p.remove.length ? `eraf: ${p.remove.map((m) => m.name).join(', ')}` : '',
      ].filter(Boolean).join(' · ');
      return <ConfirmActionCard icon={<UserIcon />} title={`Projectteam van "${p.project_name}" bijwerken?`} sub={sub}
        confirmLabel="Bijwerken" pendingLabel="Bijwerken…" doneLabel={`Projectteam van "${p.project_name}" bijgewerkt`}
        onConfirm={() => runConfirmed(auditId, () => onSetProjectTeam ? onSetProjectTeam(p) : Promise.reject(new Error('Bijwerken is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'task_assign') {
      return <ConfirmActionCard icon={<UserIcon />} title={`Taak "${p.task_title}" toewijzen?`}
        sub={p.assignees.length ? p.assignees.map((a) => a.name).join(', ') : 'niemand meer toegewezen'}
        confirmLabel="Toewijzen" pendingLabel="Toewijzen…" doneLabel={`"${p.task_title}" toegewezen`}
        onConfirm={() => runConfirmed(auditId, () => onAssignTask ? onAssignTask(p) : Promise.reject(new Error('Toewijzen is hier niet beschikbaar.')))} />;
    }
    if (p.type === 'campaign') {
      return <ConfirmActionCard
        icon={<MailIcon />}
        title={`Concept-campagne "${p.name}" aanmaken?`}
        sub={`${p.subject} — hij blijft een concept; jij kiest de doelgroep en verstuurt zelf`}
        confirmLabel="Concept aanmaken" pendingLabel="Aanmaken…"
        doneLabel={`Concept-campagne "${p.name}" staat klaar in Marketing`}
        onConfirm={() => runConfirmed(auditId, () => onCreateCampaign ? onCreateCampaign(p) : Promise.reject(new Error('Campagnes zijn hier niet beschikbaar.')))}
      />;
    }
    if (p.type === 'ticket_note') {
      // De klant-zichtbare variant krijgt bewust een ander woord in de knop: dit is
      // het verschil tussen een memo voor jezelf en post naar buiten.
      const naarKlant = !p.is_internal;
      return <ConfirmActionCard
        icon={<MailIcon />}
        title={naarKlant ? `Reactie naar de klant plaatsen op "${p.ticket_title}"?` : `Interne notitie plaatsen op "${p.ticket_title}"?`}
        sub={naarKlant ? `De klant leest dit in het portaal — ${p.body}` : p.body}
        confirmLabel={naarKlant ? 'Plaatsen voor de klant' : 'Plaatsen'} pendingLabel="Plaatsen…"
        doneLabel={naarKlant ? 'Reactie geplaatst; de klant kan hem lezen' : 'Interne notitie geplaatst'}
        onConfirm={() => runConfirmed(auditId, () => onAddTicketNote ? onAddTicketNote(p) : Promise.reject(new Error('Reageren is hier niet beschikbaar.')))}
      />;
    }
    if (p.type === 'edit_time_entry') {
      const was = `${p.current.date} · ${formatMinutes(p.current.minutes)}`;
      const wordt = [
        p.changes.entry_date ?? p.current.date,
        formatMinutes(p.changes.minutes ?? p.current.minutes),
      ].join(' · ');
      return <ConfirmActionCard icon={<ClockIcon />} title="Urenregistratie aanpassen?" sub={`${was}  →  ${wordt}`}
        confirmLabel="Aanpassen" pendingLabel="Aanpassen…" doneLabel="Urenregistratie aangepast"
        onConfirm={() => runConfirmed(auditId, () => onEditTimeEntry ? onEditTimeEntry(p) : Promise.reject(new Error('Aanpassen is hier niet beschikbaar.')))} />;
    }
    // Reeksen (mail, facturen, offertes, herinneringen) krijgen ook in de chat het
    // afvinkbord: je leest elke regel en vinkt hem los af. Eén knop "versturen"
    // onder een stapel post zou hier net zo min kloppen als in de wachtrij.
    const batch = asBatchProposal(p);
    if (batch) {
      return <AgentBatchBoard
        proposal={batch}
        canWrite
        handlers={{ onSendClientEmail, onSendInvoice, onSendQuote, onSendReminders }}
        onResolved={({ sent, skipped }) => {
          if (auditId) void confirmGerrieAction(organizationId, auditId, sent > 0 ? 'executed' : 'failed', `${sent} verstuurd, ${skipped} overgeslagen.`);
        }}
      />;
    }
    if (p.type === 'agent') {
      const days = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
      const when = p.schedule_kind === 'daily' ? `elke dag om ${String(p.hour).padStart(2, '0')}:00`
        : p.schedule_kind === 'weekly' ? `elke ${days[(p.day_of_week ?? 1) - 1]} om ${String(p.hour).padStart(2, '0')}:00`
        : `maandelijks op dag ${p.day_of_month ?? 1} om ${String(p.hour).padStart(2, '0')}:00`;
      // Akkoord = de agent bestaat, staat aan en draait meteen zijn eerste ronde.
      // Wat hij daarna wil versturen komt gewoon weer als afvinklijst terug.
      return <ConfirmActionCard
        icon={<RobotIcon />}
        title={`Agent "${p.name}" aanmaken en aanzetten?`}
        sub={`${when} · ${p.mode === 'propose' ? 'zet acties klaar die jij afvinkt' : 'kijkt alleen mee'}`}
        confirmLabel="Aanmaken en starten" pendingLabel="Aanmaken…" doneLabel={`Agent "${p.name}" staat aan en draait zijn eerste ronde`}
        onConfirm={() => runConfirmed(auditId, () => onCreateAgent ? onCreateAgent(p) : Promise.reject(new Error('Agents aanmaken is hier niet beschikbaar.')))}
      />;
    }
    // Onbekend voorstel (nieuwer type dan deze build kent): liever niets tonen dan
    // een knop die het verkeerde doet.
    return null;
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
                    {proposalCard(m.proposal, m.auditId)}
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

          {micNote && <p className="gerrie-mic-note" role="status">{micNote}</p>}

          <div className="gerrie-composer">
            <textarea
              ref={inputRef}
              className="gerrie-input"
              rows={1}
              placeholder={listening ? 'Luisteren… spreek je bericht in' : 'Typ een bericht aan Gerrie…'}
              value={draft}
              onInput={onInput}
              onKeyDown={onKeyDown}
            />
            {speechSupported && (
              <button
                type="button"
                className={`gerrie-mic${listening ? ' is-listening' : ''}`}
                onClick={toggleDictation}
                disabled={thinking}
                aria-label={listening ? 'Stoppen met inspreken' : 'Inspreken'}
                aria-pressed={listening}
                title={listening ? 'Stoppen met inspreken' : 'Spreek je bericht in'}
              >
                <MicIcon />
              </button>
            )}
            <button className="gerrie-send" onClick={() => void send(draft)} disabled={!draft.trim() || thinking} aria-label="Versturen">
              <SendIcon />
            </button>
          </div>
          {budget !== null && (
            <div className="gerrie-budget" role="status" aria-label="Resterend AI-tegoed deze maand">
              <span className="gerrie-budget-label">AI-tegoed</span>
              <span className="gerrie-budget-track">
                <span className="gerrie-budget-fill" data-low={budget <= 0.2 ? 'true' : 'false'} style={{ '--fill': Math.round(budget * 100) / 100 } as React.CSSProperties} />
              </span>
              <span className="gerrie-budget-pct">{Math.round(budget * 100)}%</span>
            </div>
          )}
          <p className="gerrie-foot-note">Gerrie leest mee in je workspace en kan acties uitvoeren — altijd pas nadat jij op de kaart akkoord geeft.</p>
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

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3M8.5 21h7" />
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


/**
 * Bevestigkaart voor een actie (versturen, aanmaken, omzetten, …) — beheert eigen status.
 *
 * `onConfirm` mag een zin teruggeven; die vervangt dan `doneLabel`. Zo meldt de kaart
 * wat er ECHT gebeurd is ("Factuur 2026-014 aangemaakt als concept") in plaats van wat
 * de knop vooraf beloofde — het nummer weet je immers pas achteraf.
 *
 * `onSecondary` is de zachte weg ernaast: hetzelfde voorstel eerst vooringevuld in een
 * scherm openen in plaats van het meteen weg te schrijven.
 */
function ConfirmActionCard({ icon, title, sub, confirmLabel, pendingLabel, doneLabel, onConfirm, secondaryLabel, onSecondary }: {
  icon: ReactNode; title: string; sub: string;
  confirmLabel: string; pendingLabel: string; doneLabel: string;
  onConfirm: () => Promise<void | string>;
  secondaryLabel?: string; onSecondary?: () => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error' | 'cancelled'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function go() {
    setState('busy'); setError(null);
    try {
      const result = await onConfirm();
      setDone(typeof result === 'string' && result.trim() ? result : null);
      setState('done');
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt.'); setState('error'); }
  }

  if (state === 'done') return <div className="gerrie-send-result ok">✓ {done ?? doneLabel}</div>;
  if (state === 'cancelled') return <div className="gerrie-send-result cancelled">Geannuleerd.</div>;

  return (
    <div className="gerrie-send-card">
      <div className="gerrie-send-head">
        <span className="gerrie-proposal-icon" aria-hidden="true">{icon}</span>
        <span className="gerrie-proposal-body">
          <span className="gerrie-proposal-title">{title}</span>
          <span className="gerrie-proposal-sub">{sub}</span>
        </span>
      </div>
      {state === 'error' && error && <div className="gerrie-send-error">{error}</div>}
      <div className="gerrie-send-actions">
        <button className="gerrie-cancel" onClick={() => setState('cancelled')} disabled={state === 'busy'}>Annuleren</button>
        {secondaryLabel && onSecondary && (
          <button className="gerrie-cancel" onClick={onSecondary} disabled={state === 'busy'}>{secondaryLabel}</button>
        )}
        <button className="gerrie-confirm" onClick={go} disabled={state === 'busy'}>{state === 'busy' ? pendingLabel : state === 'error' ? 'Opnieuw proberen' : confirmLabel}</button>
      </div>
    </div>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <rect x="7" y="11" width="3" height="6" rx="0.5" />
      <rect x="13" y="7" width="3" height="10" rx="0.5" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
