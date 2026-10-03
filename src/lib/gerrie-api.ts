import { supabase } from './supabase';
import { isMissingColumn } from './postgrestErrors';
import type { ReportDefinition } from './reporting';
import { fallbackToolLabel } from './agentLogText';
import type { UUID } from '../types';

/**
 * Frontend-koppeling met Gerrie (de `gerrie-agent` Edge Function).
 *
 * We gebruiken bewust géén `supabase.functions.invoke`: die buffert de hele
 * respons. Gerrie streamt via Server-Sent Events zodat de chat live kan tonen
 * waar hij mee bezig is ("Klanten zoeken…"). Daarom een directe `fetch` met het
 * sessietoken, en een kleine SSE-parser.
 */

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL as string}/functions/v1`;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface GerrieStatus { kind: 'thinking' | 'tool'; label: string }

/** Door Gerrie voorgestelde acties — openen vooringevuld in het bestaande formulier. */
export interface GerrieProposalLine { description: string; quantity: number; unit_price: number; vat: number }
export interface GerrieInvoiceProposal {
  type: 'invoice';
  client_id: UUID;
  client_name: string;
  lines: GerrieProposalLine[];
  notes: string | null;
  due_date: string | null;
  total_eur: number;
}
export interface GerrieQuoteProposal {
  type: 'quote';
  client_id: UUID;
  client_name: string;
  lines: GerrieProposalLine[];
  notes: string | null;
  valid_until: string | null;
  total_eur: number;
}
export interface GerrieClientProposal {
  type: 'client';
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: string;
}
export interface GerrieSendInvoiceProposal {
  type: 'send_invoice';
  id: UUID;
  number: string;
  client_name: string;
  recipient_email: string;
  recipient_name: string | null;
}
export interface GerrieSendQuoteProposal {
  type: 'send_quote';
  id: UUID;
  number: string;
  client_name: string;
  recipient_email: string;
  recipient_name: string | null;
}
/** Eén factuur/offerte binnen een reeks die je regel voor regel afvinkt. */
export interface GerrieSendDocumentItem {
  id: UUID;
  number: string;
  client_name: string;
  recipient_email: string;
  recipient_name: string | null;
  total_eur: number;
  status: string;
  date: string | null;
}
/** Documenten die de agent wilde versturen maar die afvielen, met de reden. */
export interface GerrieSkippedDocument { number: string; reason: string }
export interface GerrieSendInvoicesProposal {
  type: 'send_invoices';
  items: GerrieSendDocumentItem[];
  total: number;
  skipped: GerrieSkippedDocument[];
}
export interface GerrieSendQuotesProposal {
  type: 'send_quotes';
  items: GerrieSendDocumentItem[];
  total: number;
  skipped: GerrieSkippedDocument[];
}
export interface GerrieConvertQuoteProposal {
  type: 'convert_quote';
  id: UUID;
  number: string;
  client_name: string;
  total_eur: number;
}
export interface GerrieEditInvoiceProposal {
  type: 'edit_invoice';
  id: UUID;
  number: string;
  client_name: string;
  changes: { lines?: GerrieProposalLine[]; notes?: string | null; due_date?: string | null };
}
export interface GerrieEditQuoteProposal {
  type: 'edit_quote';
  id: UUID;
  number: string;
  client_name: string;
  changes: { lines?: GerrieProposalLine[]; notes?: string | null; valid_until?: string | null };
}
export interface GerrieEditClientProposal {
  type: 'edit_client';
  id: UUID;
  name: string;
  changes: { name?: string; contact_name?: string | null; email?: string | null; phone?: string | null; notes?: string | null; status?: string };
}
export interface GerrieSendRemindersProposal {
  type: 'send_reminders';
  /** Bedrag en dagen-te-laat zijn later toegevoegd; voorstellen van vóór die
   *  wijziging staan nog in de wachtrij, vandaar optioneel. */
  invoices: Array<{ id: UUID; number: string; client_name: string; level: number; total_eur?: number; days_overdue?: number; recipient_email?: string | null }>;
  total: number;
}
export interface GerrieProposalSubtask { label: string; done: boolean }
export interface GerrieProjectProposal {
  type: 'project';
  name: string;
  client_id: UUID | null;
  client_name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
}
export interface GerrieEditProjectProposal {
  type: 'edit_project';
  id: UUID;
  name: string;
  changes: { name?: string; client_id?: UUID | null; description?: string | null; start_date?: string | null; end_date?: string | null; archived?: boolean };
}
export interface GerrieTaskProposal {
  type: 'task';
  project_id: UUID;
  project_name: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  planned_date: string | null;
  start_date: string | null;
  end_date: string | null;
  estimated_minutes: number;
  tags: string[];
  subtasks: GerrieProposalSubtask[];
}
/** Eén regel van een takenlijst: dezelfde velden als een losse taak, minus wat de lijst deelt. */
export interface GerrieCreateTasksItem {
  title: string;
  description: string | null;
  priority: string;
  planned_date: string | null;
  end_date: string | null;
  estimated_minutes: number;
}
/**
 * MEERDERE taken in één project, af te vinken per regel (zie AgentBatchBoard).
 * Elke regel wordt bij akkoord een gewone GerrieTaskProposal en loopt langs
 * onApplyProposal — dezelfde opslagweg als "Taak aanmaken".
 */
export interface GerrieCreateTasksProposal {
  type: 'create_tasks';
  project_id: UUID;
  project_name: string;
  source: { kind: 'meeting' | 'chat'; recording_id: UUID | null; title: string | null; date: string | null };
  items: GerrieCreateTasksItem[];
  total: number;
}
export interface GerrieEditTaskProposal {
  type: 'edit_task';
  id: UUID;
  title: string;
  /** Null bij een losse taak die nog niet aan een project gekoppeld is. */
  project_id: UUID | null;
  changes: { title?: string; description?: string | null; status?: string; priority?: string; planned_date?: string | null; start_date?: string | null; end_date?: string | null; estimated_minutes?: number; tags?: string[]; subtasks?: GerrieProposalSubtask[] };
}
export interface GerrieCalendarEventProposal {
  type: 'calendar_event';
  source_id: UUID;
  source_name: string;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  description: string | null;
  location: string | null;
}
export interface GerrieWeekActionProposal {
  type: 'week_action';
  items: Array<{ title: string; planned_date: string }>;
  total: number;
}
/** Eén klantmail binnen een voorstel; in de wachtrij vink je ze stuk voor stuk af. */
export interface GerrieClientEmailItem {
  client_id: UUID;
  client_name: string;
  recipient_email: string;
  subject: string;
  /** Platte tekst met witregels tussen de alinea's; de app maakt er bij verzending HTML van. */
  body: string;
}
export interface GerrieSendClientEmailProposal {
  type: 'send_client_email';
  items: GerrieClientEmailItem[];
  total: number;
  /** 'template' = de vaste tekst van de agent met variabelen ingevuld. */
  origin: 'compose' | 'template';
  /** Klanten die de agent wilde mailen maar (nog) geen e-mailadres hebben. */
  skipped: string[];
}
/**
 * Een voorstel uit de HANDELINGENREGISTRY — de lange staart van wat de app kan.
 *
 * Eén type voor alle handelingen samen, in plaats van een eigen type per handeling.
 * De server heeft de gegevens al opgezocht en gecontroleerd en schrijft `title` en
 * `sub`: dat is precies wat de gebruiker leest voordat hij akkoord geeft. `payload`
 * is wat de uitvoerder in `src/lib/actions/` nodig heeft.
 *
 * Zo kost een nieuwe handeling geen nieuw voorsteltype, geen nieuwe kaart en geen
 * nieuwe tak in de uitvoerder — alleen een regel aan beide kanten.
 */
export interface GerrieRegistryActionProposal {
  type: 'action';
  /** Sleutel in ACTION_EXECUTORS, bv. 'gallery.publish'. */
  action_id: string;
  title: string;
  /** Wat er gebeurt; bij iets onomkeerbaars begint dit met een waarschuwing. */
  sub: string;
  kind: 'money' | 'mail' | 'agenda' | 'work' | 'insight' | 'agent';
  /** 'high' = onomkeerbaar of naar buiten gericht; de knop heet dan anders. */
  risk?: 'normal' | 'high';
  payload: Record<string, unknown>;
}
/** Een door Gerrie klaargezette agent; goedkeuren opent de agent-editor vooringevuld. */
export interface GerrieAgentProposal {
  type: 'agent';
  name: string;
  icon: string | null;
  max_emails_per_run: number;
  instruction: string;
  mode: RoutineMode;
  enabled_tools: string[];
  schedule_kind: RoutineScheduleKind;
  hour: number;
  day_of_week: number | null;
  day_of_month: number | null;
  email_mode: AgentEmailMode;
  email_subject: string | null;
  email_body: string | null;
}
export interface GerrieReportProposal {
  type: 'report';
  name: string;
  /** Pure JSON-rapportdefinitie; opent vooringevuld in de rapportbouwer. */
  definition: ReportDefinition;
}
/** Door Gerrie voorgestelde urenregistratie — bevestigen in de chat voert hem uit. */
export interface GerrieTimeEntryProposal {
  type: 'time_entry';
  project_id: UUID | null;
  project_name: string | null;
  client_id: UUID | null;
  client_name: string | null;
  date: string;
  minutes: number;
  description: string | null;
  billable: boolean;
  hourly_rate_cents: number | null;
}
/**
 * Verwijzing naar een bestaand agenda-item. De agenda is multi-provider, dus alle
 * drie de velden gaan mee; de agenda-functie kiest welke hij nodig heeft.
 */
export interface GerrieCalendarEventRef { event_id: UUID | null; source_id: UUID; provider_event_id: string | null }
export interface GerrieEditCalendarEventProposal {
  type: 'edit_calendar_event';
  ref: GerrieCalendarEventRef;
  title: string;
  source_name: string;
  current: { date: string; start_time: string; end_time: string; location: string | null };
  changes: { title?: string; date?: string; start_time?: string; end_time?: string; description?: string | null; location?: string | null };
}
export interface GerrieCancelCalendarEventProposal {
  type: 'cancel_calendar_event';
  ref: GerrieCalendarEventRef;
  title: string;
  source_name: string;
  date: string;
  start_time: string;
  /** Genodigden krijgen een afzegging — dat hoort op de kaart te staan. */
  has_attendees: boolean;
}
export interface GerrieClientContactProposal {
  type: 'client_contact';
  client_id: UUID;
  client_name: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  gives_portal_access: boolean;
}
export interface GerrieEditClientContactProposal {
  type: 'edit_client_contact';
  id: UUID;
  name: string;
  client_name: string;
  changes: { name?: string; email?: string | null; phone?: string | null; role?: string | null; gives_portal_access?: boolean };
}
export interface GerrieProjectTeamProposal {
  type: 'project_team';
  project_id: UUID;
  project_name: string;
  add: Array<{ user_id: UUID; name: string }>;
  remove: Array<{ user_id: UUID; name: string }>;
}
export interface GerrieTaskAssignProposal {
  type: 'task_assign';
  task_id: UUID;
  task_title: string;
  project_name: string | null;
  /** De VOLLEDIGE nieuwe set; leeg = niemand meer toegewezen. */
  assignees: Array<{ user_id: UUID; name: string }>;
}
export interface GerrieSupplierProposal {
  type: 'supplier';
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  iban: string | null;
  vat_number: string | null;
  kvk_number: string | null;
  city: string | null;
}
export interface GerriePurchaseInvoiceLine { description: string; amount_eur: number; vat_rate: number }
export interface GerriePurchaseInvoiceProposal {
  type: 'purchase_invoice';
  supplier_id: UUID | null;
  supplier_name: string | null;
  supplier_invoice_number: string;
  date: string;
  due_date: string | null;
  notes: string | null;
  lines: GerriePurchaseInvoiceLine[];
  total_eur: number;
}
export interface GerrieContractProposal {
  type: 'contract';
  client_id: UUID;
  client_name: string;
  title: string;
  body: string;
  amount_eur: number | null;
  valid_until: string | null;
}
/**
 * Een campagne blijft ALTIJD een concept: er is geen veld waarmee hij verstuurd of
 * ingepland kan worden, en de doelgroep zit er bewust niet in. Bij een campagne gaat
 * er in één klik post naar een heel segment dat je niet regel voor regel hebt gezien.
 */
export interface GerrieCampaignProposal {
  type: 'campaign';
  name: string;
  subject: string;
  preheader: string | null;
  body_text: string;
  audience_note: string | null;
}
export interface GerrieContentProposal {
  type: 'content';
  kind: 'note' | 'document';
  title: string;
  content: string;
  client_id: UUID | null;
  client_name: string | null;
  project_id: UUID | null;
  project_name: string | null;
}
/** Correctie op een bestaande urenregistratie; `current` toont waar hij nu op staat. */
export interface GerrieEditTimeEntryProposal {
  type: 'edit_time_entry';
  id: UUID;
  current: { date: string; minutes: number; description: string | null; billable: boolean; project_name: string | null; client_name: string | null };
  changes: { entry_date?: string; minutes?: number; description?: string | null; billable?: boolean };
}
export interface GerrieTicketProposal {
  type: 'ticket';
  title: string;
  description: string | null;
  client_id: UUID | null;
  client_name: string;
  priority: string;
  status: string;
}
export interface GerrieEditTicketProposal {
  type: 'edit_ticket';
  id: UUID;
  title: string;
  changes: { title?: string; description?: string | null; status?: string; priority?: string; notes?: string | null };
}
/** Een reactie op een ticket. `is_internal: false` = de klant leest hem in het portaal. */
export interface GerrieTicketNoteProposal {
  type: 'ticket_note';
  ticket_id: UUID;
  ticket_title: string;
  body: string;
  is_internal: boolean;
}
export type GerrieProposal = GerrieRegistryActionProposal | GerrieInvoiceProposal | GerrieQuoteProposal | GerrieClientProposal | GerrieSendInvoiceProposal | GerrieSendQuoteProposal | GerrieSendInvoicesProposal | GerrieSendQuotesProposal | GerrieConvertQuoteProposal | GerrieEditInvoiceProposal | GerrieEditQuoteProposal | GerrieEditClientProposal | GerrieSendRemindersProposal | GerrieProjectProposal | GerrieEditProjectProposal | GerrieTaskProposal | GerrieCreateTasksProposal | GerrieEditTaskProposal | GerrieCalendarEventProposal | GerrieEditCalendarEventProposal | GerrieCancelCalendarEventProposal | GerrieClientContactProposal | GerrieEditClientContactProposal | GerrieProjectTeamProposal | GerrieTaskAssignProposal | GerrieWeekActionProposal | GerrieTimeEntryProposal | GerrieEditTimeEntryProposal | GerrieTicketProposal | GerrieEditTicketProposal | GerrieTicketNoteProposal | GerrieSupplierProposal | GerriePurchaseInvoiceProposal | GerrieContractProposal | GerrieCampaignProposal | GerrieContentProposal | GerrieReportProposal | GerrieSendClientEmailProposal | GerrieAgentProposal;

/**
 * De uitvoer-handlers voor een door Gerrie voorgestelde actie.
 *
 * Twee soorten. De verstuur-/aanmaak-types (onSendInvoice, onCreateCalendarEvent, …)
 * dóen het meteen. De concept-types (onCreateInvoiceDraft, onCreateTask, …) openen het
 * vooringevulde formulier — dat is een tweede lezing, geen uitvoering.
 *
 * Dat tweede pad was lang het enige, en daardoor kon Gerrie strikt genomen geen factuur
 * AANMAKEN: hij zette een scherm klaar en jij drukte op opslaan. Voor een geplande agent
 * die om 08:00 draait terwijl niemand kijkt, is dat helemaal onwerkbaar. Daarom is er nu
 * onApplyProposal: dezelfde voorstellen, maar écht weggeschreven zodra jij akkoord geeft.
 * Het formulier blijft als tweede knop bestaan voor wie liever eerst kijkt.
 *
 * Gedeeld door de chat-dock (GerrieChat), het Commandocentrum én de goedkeurwachtrij,
 * zodat een goedgekeurd voorstel overal identiek wordt uitgevoerd.
 */
export interface GerrieActionHandlers {
  /**
   * Voert een CONCEPT-voorstel écht uit in plaats van het formulier te openen, en geeft
   * een korte bevestigingszin terug ("Factuur 2026-014 aangemaakt voor Jansen"). Eén
   * handler voor alle concept-types: de uitvoering loopt langs precies dezelfde opslagweg
   * als het formulier, dus er is geen tweede plek waar de validatie kan gaan afwijken.
   * Ontbreekt de handler, dan valt alles terug op het formulier.
   */
  onApplyProposal?: (proposal: GerrieProposal) => Promise<string>;
  /**
   * Voert een handeling uit de registry uit (voorsteltype 'action') en geeft de
   * bevestigingszin terug. Eén handler voor de hele lange staart: welke handeling
   * het is, staat in `action_id`, en de uitvoerder daarvoor zit in src/lib/actions/.
   */
  onRunRegistryAction?: (proposal: GerrieRegistryActionProposal) => Promise<string>;
  onCreateInvoiceDraft?: (proposal: GerrieInvoiceProposal) => void;
  onCreateQuoteDraft?: (proposal: GerrieQuoteProposal) => void;
  onCreateClientDraft?: (proposal: GerrieClientProposal) => void;
  /** Verstuurt ÉÉN factuur. Een reeks facturen loopt hier per aangevinkte regel
   *  langs, zodat een mislukte verzending de rest niet meesleept. */
  onSendInvoice?: (proposal: GerrieSendInvoiceProposal) => Promise<void>;
  onSendQuote?: (proposal: GerrieSendQuoteProposal) => Promise<void>;
  onConvertQuote?: (proposal: GerrieConvertQuoteProposal) => Promise<void>;
  onEditInvoice?: (proposal: GerrieEditInvoiceProposal) => void;
  onEditQuote?: (proposal: GerrieEditQuoteProposal) => void;
  onEditClient?: (proposal: GerrieEditClientProposal) => void;
  onSendReminders?: (proposal: GerrieSendRemindersProposal) => Promise<void>;
  onCreateProject?: (proposal: GerrieProjectProposal) => void;
  onEditProject?: (proposal: GerrieEditProjectProposal) => void;
  onCreateTask?: (proposal: GerrieTaskProposal) => void;
  onEditTask?: (proposal: GerrieEditTaskProposal) => void;
  onCreateCalendarEvent?: (proposal: GerrieCalendarEventProposal) => Promise<void>;
  /** Wijzigt een bestaand agenda-item (native of Google/Microsoft). */
  onEditCalendarEvent?: (proposal: GerrieEditCalendarEventProposal) => Promise<void>;
  /** Zegt een agenda-item af; genodigden krijgen bericht. */
  onCancelCalendarEvent?: (proposal: GerrieCancelCalendarEventProposal) => Promise<void>;
  /** Voegt een contactpersoon toe bij een klant. */
  onCreateClientContact?: (proposal: GerrieClientContactProposal) => Promise<void>;
  onEditClientContact?: (proposal: GerrieEditClientContactProposal) => Promise<void>;
  /** Zet teamleden op een project of haalt ze eraf. */
  onSetProjectTeam?: (proposal: GerrieProjectTeamProposal) => Promise<void>;
  /** Vervangt de toewijzing van een taak door de opgegeven set. */
  onAssignTask?: (proposal: GerrieTaskAssignProposal) => Promise<void>;
  onCreateWeekAction?: (proposal: GerrieWeekActionProposal) => Promise<void>;
  onLogTimeEntry?: (proposal: GerrieTimeEntryProposal) => Promise<void>;
  /** Past een bestaande urenregistratie aan (voert uit; geen formulier). */
  onEditTimeEntry?: (proposal: GerrieEditTimeEntryProposal) => Promise<void>;
  /** Opent het ticketformulier vooringevuld met een nieuw ticket. */
  onCreateTicket?: (proposal: GerrieTicketProposal) => void;
  /** Opent een bestaand ticket met de voorgestelde wijziging erin. */
  onEditTicket?: (proposal: GerrieEditTicketProposal) => void;
  /** Plaatst een reactie op een ticket (voert uit). Bij is_internal=false leest de klant hem. */
  onAddTicketNote?: (proposal: GerrieTicketNoteProposal) => Promise<void>;
  /** Opent het leveranciersformulier vooringevuld met een concept. */
  onCreateSupplier?: (proposal: GerrieSupplierProposal) => void;
  /** Opent het inkoopfactuurformulier vooringevuld; boekt niets. */
  onCreatePurchaseInvoice?: (proposal: GerriePurchaseInvoiceProposal) => void;
  /** Opent de contracteditor met een concept-contract. */
  onCreateContract?: (proposal: GerrieContractProposal) => void;
  /** Maakt een CONCEPT-campagne aan en opent hem in Marketing. Verstuurt niets. */
  onCreateCampaign?: (proposal: GerrieCampaignProposal) => Promise<void>;
  /** Opent het notitie- of documentformulier vooringevuld. */
  onCreateContent?: (proposal: GerrieContentProposal) => void;
  onCreateReport?: (proposal: GerrieReportProposal) => void;
  /** Verstuurt ÉÉN klantmail. De wachtrij roept hem per aangevinkte mail aan, zodat
   *  een mislukte mail de rest niet meesleept en je per regel ziet wat er misging. */
  onSendClientEmail?: (item: GerrieClientEmailItem) => Promise<void>;
  /**
   * Maakt de door Gerrie samengestelde agent écht aan, zet hem aan en laat hem
   * meteen één keer draaien. Bewust geen tussenstap meer in een formulier: de
   * kaart in de chat laat al zien wat hij mag, en alles wat hij daarna wil
   * versturen komt gewoon als afvinklijst terug.
   */
  onCreateAgent?: (proposal: GerrieAgentProposal) => Promise<void>;
}

export interface GerrieResult {
  conversationId: UUID;
  messageId: UUID;
  text: string;
  budget?: { remainingFraction: number };
  proposal?: GerrieProposal;
  /** Audit-id van een voorgestelde actie; gebruik om uitvoering terug te melden. */
  auditId?: string;
}

export interface GerrieRequest {
  organizationId: UUID;
  conversationId: UUID | null;
  message: string;
  /** 'cheap' = het zuinige model voor parallelle deel-agents; laat weg voor de gewone chat ('strong'). */
  modelKind?: 'strong' | 'cheap';
  onStatus?: (status: GerrieStatus) => void;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export async function streamGerrieReply(req: GerrieRequest): Promise<GerrieResult> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in om met Gerrie te praten.');

  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ organizationId: req.organizationId, conversationId: req.conversationId, message: req.message, modelKind: req.modelKind }),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    let message = 'Gerrie is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: GerrieResult | null = null;
  let errorMessage: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE-blokken zijn gescheiden door een lege regel.
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (!parsed) continue;
      if (parsed.event === 'status') req.onStatus?.(parsed.data as GerrieStatus);
      else if (parsed.event === 'delta') req.onDelta?.(String((parsed.data as { text?: string }).text ?? ''));
      else if (parsed.event === 'done') result = parsed.data as GerrieResult;
      else if (parsed.event === 'error') errorMessage = String((parsed.data as { message?: string }).message ?? 'Onbekende fout.');
    }
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!result) throw new Error('Gerrie gaf geen antwoord terug. Probeer het opnieuw.');
  return result;
}

/**
 * Wat er met een voorstel gebeurde. De server (ai_action_decide) beslist of dat
 * mag: alleen wat nog open staat, alleen wie erover gaat — en legt vast wie het
 * besliste. Een afgehandeld voorstel verandert daarna niet meer.
 */
type DecisionOutcome = 'claim' | 'executed' | 'failed' | 'rejected';

/** Zo heet een afwijzing in de audit; de API toont het als `rejected`. */
const REJECTED_DETAIL = 'Afgewezen door gebruiker.';

/** Een eerdere uitvoering die nooit een uitkomst meldde: de claim liep af. */
interface StaleClaim { by: string; until: string }

/** Een weigering van de server, met zijn status: een 4xx is een antwoord, geen storing. */
class DecisionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/**
 * Wie een voorstel vastzette (claim), per voorstel: de uitkomst die daarop volgt,
 * hoort bij die persoon — ook als er intussen iemand anders inlogde.
 */
const claimedBy = new Map<string, string | null>();

async function postDecision(
  organizationId: UUID, auditId: string, outcome: DecisionOutcome, detail?: string,
): Promise<{ stale_claim?: StaleClaim }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  if (outcome === 'claim') claimedBy.set(auditId, data.session?.user?.id ?? null);
  // Een afwijzing gaat als "mislukt, afgewezen door gebruiker": dat verstaat
  // de server sinds jaar en dag. Zo klopt het ook als de app al vernieuwd is
  // en de server (nog) niet.
  const body = outcome === 'rejected'
    ? { action: 'confirm', organizationId, auditId, outcome: 'failed', detail: REJECTED_DETAIL }
    : { action: 'confirm', organizationId, auditId, outcome, detail };
  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'De beslissing kon niet worden vastgelegd. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new DecisionError(message, res.status);
  }
  try { return (await res.json()) ?? {}; } catch { return {}; }
}

// ── Uitkomsten die nog moeten aankomen ──────────────────────────────────────
//
// Het voorstel is uitgevoerd, maar de melding daarvan kwam niet aan (netwerk
// weg, tabblad dicht). Dan staat het na tien minuten weer open in de wachtrij,
// en voert iemand het een tweede keer uit. Daarom: eerst opschrijven, dan
// versturen. Wat niet aankwam, gaat alsnog mee vóór de volgende claim.

const OUTBOX_KEY = 'resofly.gerrie.decision-outbox';
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingOutcome {
  /** Wie het uitvoerde. Een ander account op dezelfde browser verstuurt hem niet op eigen naam. */
  userId: string | null;
  organizationId: string;
  auditId: string;
  outcome: 'executed' | 'failed' | 'rejected';
  detail?: string;
  at: number;
}

function readOutbox(): PendingOutcome[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(parsed)
      ? (parsed as PendingOutcome[]).filter((e) => e && typeof e.auditId === 'string' && Date.now() - Number(e.at) < OUTBOX_MAX_AGE_MS)
      : [];
  } catch { return []; }
}

function writeOutbox(entries: PendingOutcome[]): void {
  try {
    if (entries.length > 0) localStorage.setItem(OUTBOX_KEY, JSON.stringify(entries.slice(-50)));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch { /* geen opslag (privévenster): dan alleen de pogingen in reportOutcome */ }
}

function forgetOutcome(auditId: string): void {
  writeOutbox(readOutbox().filter((e) => e.auditId !== auditId));
}

/**
 * Eén uitkomst versturen. True: de server heeft hem, of wil hem nooit (al
 * afgehandeld, mag niet). Alleen namens wie het uitvoerde: is er intussen een
 * ander account ingelogd (gedeelde computer), dan blijft hij liggen.
 */
async function deliverOutcome(entry: PendingOutcome): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  if (!entry.userId || data.session?.user?.id !== entry.userId) return false;
  try {
    await postDecision(entry.organizationId, entry.auditId, entry.outcome, entry.detail);
    return true;
  } catch (e) {
    return e instanceof DecisionError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429;
  }
}

/**
 * Wat eerder bleef liggen, alsnog versturen — alleen wat van de ingelogde
 * gebruiker zelf is. Van een ander account (gedeelde computer) blijft het
 * liggen tot die weer inlogt: anders kwam "besloten door" op de verkeerde naam.
 */
export async function flushDecisionOutbox(): Promise<void> {
  for (const entry of readOutbox()) {
    if (await deliverOutcome(entry)) forgetOutcome(entry.auditId);
  }
}

async function reportOutcome(entry: PendingOutcome): Promise<void> {
  // Synchroon opgeschreven, vóór de eerste await: ook een tabblad dat nu dichtgaat, verliest hem niet.
  writeOutbox([...readOutbox().filter((e) => e.auditId !== entry.auditId), entry]);
  for (const wait of [0, 1500, 5000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (await deliverOutcome(entry)) { forgetOutcome(entry.auditId); return; }
  }
  // Blijft in de outbox; flushDecisionOutbox stuurt hem vóór de volgende claim.
}

/**
 * De uitkomst NA het uitvoeren. Het werk is dan al gebeurd: een melding die niet
 * aankomt, laat dat niet alsnog als fout zien — maar gaat ook niet verloren.
 */
export async function confirmGerrieAction(organizationId: UUID, auditId: string, outcome: 'executed' | 'failed' | 'rejected', detail?: string): Promise<void> {
  // Na een uitvoering ging de claim van DIT voorstel altijd vooraf: wie die deed,
  // is degene die het uitvoerde. Zonder claim (een reeks waarin alles werd
  // overgeslagen) is er niets uitgevoerd en beslist wie nu is ingelogd.
  const userId = claimedBy.has(auditId)
    ? claimedBy.get(auditId) ?? null
    : (await supabase.auth.getSession()).data.session?.user?.id ?? null;
  claimedBy.delete(auditId);
  await reportOutcome({ userId, organizationId, auditId, outcome, detail, at: Date.now() });
}

/**
 * Vastzetten VÓÓR het uitvoeren. Klikken twee mensen tegelijk op Akkoord, dan
 * voert maar één het uit; de ander krijgt een duidelijke fout in plaats van een
 * tweede factuur of mail. Gooit als het niet mag of al gebeurd is.
 *
 * Eerst gaan de uitkomsten mee die nog lagen: was dit voorstel eigenlijk al
 * uitgevoerd, dan weet de server dat vóór hij het opnieuw vastzet. Liep een
 * eerdere poging af zonder uitkomst (ander apparaat, tabblad dicht), dan vraagt
 * de app eerst of het echt opnieuw moet — `quiet` slaat dat over voor de
 * volgende regels van een reeks die al liep.
 */
export async function claimGerrieAction(organizationId: UUID, auditId: string, options: { quiet?: boolean } = {}): Promise<void> {
  await flushDecisionOutbox();
  const response = await postDecision(organizationId, auditId, 'claim');
  const stale = response.stale_claim;
  if (!stale || options.quiet || typeof window === 'undefined') return;
  const started = new Date(new Date(stale.until).getTime() - 10 * 60_000);
  const when = Number.isNaN(started.getTime()) ? 'eerder' : started.toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' });
  const again = window.confirm(
    `Dit voorstel is al eens gestart (${when}), maar er kwam nooit een uitkomst binnen. Misschien is het toen al uitgevoerd — kijk dat eerst na.\n\nToch nu uitvoeren?`);
  if (!again) {
    await confirmGerrieAction(organizationId, auditId, 'failed', 'Niet opnieuw uitgevoerd: eerst nagaan of een eerdere poging al gelukt was.');
    throw new Error('Niet uitgevoerd. Kijk eerst na of het eerder al gebeurd is; daarna kun je het opnieuw proberen.');
  }
}

/** Afwijzen. Gooit als het niet kan (al afgehandeld, of iemand anders is het aan het uitvoeren). */
export async function rejectGerrieAction(organizationId: UUID, auditId: string): Promise<void> {
  await postDecision(organizationId, auditId, 'rejected');
}

/**
 * Eén voorstel uitvoeren zoals het hoort: vastzetten, uitvoeren, de uitkomst
 * melden. Mislukt het vastzetten, dan gebeurt er niets.
 */
export async function runGerrieDecision<T>(organizationId: UUID, auditId: string | undefined | null, run: () => Promise<T>): Promise<T> {
  if (!auditId) return await run();
  await claimGerrieAction(organizationId, auditId);
  try {
    const result = await run();
    void confirmGerrieAction(organizationId, auditId, 'executed');
    return result;
  } catch (e) {
    void confirmGerrieAction(organizationId, auditId, 'failed', e instanceof Error ? e.message : undefined);
    throw e;
  }
}

/**
 * Voor een reeks (mails, facturen, herinneringen) die per regel wordt
 * uitgevoerd: elke handler zet het voorstel eerst (opnieuw) vast. Zo blijft het
 * van deze gebruiker zolang hij er regels uit verstuurt.
 */
/**
 * De uitkomst van een reeks: iets verstuurd = uitgevoerd; niets verstuurd en
 * niets mislukt = afgewezen (alles bewust overgeslagen); anders mislukt — dan
 * kan het nog een keer.
 */
export function batchDecision(result: { sent: number; skipped: number; failed?: number }): { outcome: 'executed' | 'failed' | 'rejected'; detail: string } {
  const failed = result.failed ?? 0;
  const detail = `${result.sent} verstuurd, ${result.skipped} overgeslagen${failed ? `, ${failed} mislukt` : ''}.`;
  if (result.sent > 0) return { outcome: 'executed', detail };
  return { outcome: failed > 0 ? 'failed' : 'rejected', detail };
}

export function claimingHandlers(organizationId: UUID, auditId: string, handlers: GerrieActionHandlers): GerrieActionHandlers {
  let claimed = false;
  return new Proxy(handlers, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        // De eerste regel vraagt na als een eerdere poging zonder uitkomst bleef; de volgende niet elk opnieuw.
        await claimGerrieAction(organizationId, auditId, { quiet: claimed });
        claimed = true;
        return (value as (...params: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Haalt het resterende AI-tegoed op (fractie 0..1, of null als er geen limiet is),
 * zodat de tegoed-balk al bij het openen van de chat kan verschijnen. Best-effort.
 */
export async function loadGerrieBudget(organizationId: UUID): Promise<number | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return null;
    const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
      body: JSON.stringify({ action: 'budget', organizationId }),
    });
    if (!res.ok) return null;
    const payload = await res.json();
    return typeof payload?.remainingFraction === 'number' ? payload.remainingFraction : null;
  } catch {
    return null;
  }
}

/** Eén niet-streamende POST naar `gerrie-agent` (voor acties zonder SSE). */
async function postGerrie(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'Gerrie is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

// Hier stond de multi-agent missie-API (planGerrieMission / estimateGerrieMission).
// Het missiebord is vervangen door "Nu uitvoeren": één opdracht via streamGerrieReply.
// De acties 'plan' en 'estimate' bestaan nog wél op gerrie-agent; die zijn bewust
// blijven staan, maar worden door de app niet meer aangeroepen.

/**
 * Eén beurt van de agent-bouwer: óf een vervolgvraag, óf de complete agent.
 * Het model moet altijd één van beide leveren, dus de gebruiker loopt nooit vast
 * op een vaag tekstantwoord.
 */
export type AgentDesignStep =
  | { kind: 'question'; question: string; suggestions: string[] }
  | { kind: 'agent'; summary: string; agent: GerrieAgentProposal }
  | { kind: 'budget' };

/**
 * Laat Gerrie uit een gesprekje een complete agent bouwen. Stuurt het hele
 * gesprek mee (laatste 12 beurten), zodat "maak hem maandelijks" ook nog werkt
 * nadat er al een agent lag.
 */
export async function designGerrieAgent(
  organizationId: UUID,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<AgentDesignStep> {
  const payload = await postGerrie({ action: 'design_agent', organizationId, messages });
  const kind = String(payload?.kind ?? '');
  if (kind === 'budget') return { kind: 'budget' };
  if (kind === 'agent' && payload?.agent) {
    return { kind: 'agent', summary: String(payload.summary ?? ''), agent: payload.agent as GerrieAgentProposal };
  }
  return {
    kind: 'question',
    question: String(payload?.question ?? 'Kun je dat iets concreter maken?'),
    suggestions: Array.isArray(payload?.suggestions) ? (payload.suggestions as unknown[]).map(String) : [],
  };
}

export interface GerrieUsageRow { user_id: UUID; messages: number; tokens: number; cost_usd: number }

/**
 * Haalt het AI-gebruik op voor het admin-dashboard: PER GEBRUIKER over alle
 * organisaties (zelfde telling als de kostenlimiet). Loopt via de Edge Function
 * (service-role), zodat het niet door de per-org RLS wordt beperkt.
 */
export async function loadGerrieUsage(organizationId: UUID): Promise<GerrieUsageRow[]> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return [];
  const res = await fetch(`${FUNCTIONS_BASE}/gerrie-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify({ action: 'usage', organizationId }),
  });
  if (!res.ok) {
    let message = 'AI-gebruik laden mislukt.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  const payload = await res.json();
  return (payload?.rows ?? []) as GerrieUsageRow[];
}

// ── Gerrie Routines (gebruikers bouwen eigen geplande agents) ─────────────────

export type RoutineScheduleKind = 'daily' | 'weekly' | 'monthly';
export type RoutineMode = 'report' | 'propose';
export type RoutineStatus = 'draft' | 'active' | 'paused' | 'archived';
/** Wie schrijft de klantmail: de agent zelf, of jouw vastgelegde tekst met variabelen. */
export type AgentEmailMode = 'compose' | 'template';
export type RoutineRunStatus = 'claimed' | 'running' | 'succeeded' | 'failed' | 'partial' | 'skipped_budget' | 'cancelled';

export interface GerrieRoutine {
  id: UUID;
  name: string;
  description: string | null;
  /** Zelfgekozen embleem-sleutel; null = de app leidt hem af uit opdracht + tools. */
  icon: string | null;
  /** Zelfgekozen kleurtint 0..359; null = afgeleid uit het agent-id. */
  hue: number | null;
  /** Klantmail: schrijft de agent zelf, of gebruikt hij de vaste tekst hieronder? */
  email_mode: AgentEmailMode;
  email_subject: string | null;
  email_body: string | null;
  /** Hard plafond op het aantal klantmails dat één run mag klaarzetten. */
  max_emails_per_run: number;
  instruction: string;
  model_kind: 'cheap' | 'strong';
  mode: RoutineMode;
  enabled_tools: string[];
  schedule_kind: RoutineScheduleKind;
  hour: number;
  day_of_week: number | null;
  day_of_month: number | null;
  timezone: string;
  status: RoutineStatus;
  /** Wanneer de agent gearchiveerd is ("verwijderd"). Null = gewoon in gebruik. */
  archived_at: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  consecutive_failures: number;
  delivery: { channels: string[]; recipient_user_ids: string[] };
  created_at: string;
  updated_at: string;
}

export interface GerrieRoutineRun {
  id: UUID;
  agent_id: UUID;
  conversation_id: UUID | null;
  triggered_by: 'schedule' | 'manual' | 'retry';
  status: RoutineRunStatus;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  cost_usd: number;
  proposals_created: number;
  error: string | null;
  created_at: string;
}

/** Velden die de beheer-Edge-Function (gerrie-agent-runner) accepteert bij create/update. */
export interface GerrieRoutineInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  hue?: number | null;
  email_mode?: AgentEmailMode;
  email_subject?: string | null;
  email_body?: string | null;
  max_emails_per_run?: number;
  instruction: string;
  model_kind: 'cheap' | 'strong';
  mode: RoutineMode;
  enabled_tools: string[];
  schedule_kind: RoutineScheduleKind;
  hour: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  timezone: string;
  // Bewust géén budget-velden: kosten lopen via het maandtegoed van het account
  // (secret GERRIE_MONTHLY_USER_COST_EUR). `max_emails_per_run` is geen budget maar
  // een grens op hoeveel post één run mag klaarzetten, en wordt wél afgedwongen.
  delivery: { channels: string[] };
}

const RUNNER_FN = 'gerrie-agent-runner';

async function postRunner(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Je sessie is verlopen. Log opnieuw in.');
  const res = await fetch(`${FUNCTIONS_BASE}/${RUNNER_FN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = 'De Routines-motor is even niet bereikbaar. Probeer het zo opnieuw.';
    try { const payload = await res.json(); if (payload?.error) message = String(payload.error); } catch { /* geen JSON */ }
    throw new Error(message);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Alle Routines van de organisatie (owner/admin, via RLS). */
export async function listRoutines(organizationId: UUID): Promise<GerrieRoutine[]> {
  const { data, error } = await supabase.from('ai_agents')
    .select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as GerrieRoutine[];
}

/** De runs van één Routine (nieuwste eerst) — de historie op zijn detailpagina. */
export async function listRoutineRuns(organizationId: UUID, agentId: UUID, limit = 100): Promise<GerrieRoutineRun[]> {
  const { data, error } = await supabase.from('ai_agent_runs')
    .select('*').eq('organization_id', organizationId).eq('agent_id', agentId)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as GerrieRoutineRun[];
}

/**
 * Maakt een nieuwe Routine aan of werkt een bestaande bij.
 *
 * `activate` zet een nieuwe agent in dezelfde aanroep aan — een net samengestelde
 * agent hoort niet als slapend concept te blijven liggen.
 */
export async function saveRoutine(organizationId: UUID, input: GerrieRoutineInput, id?: UUID, activate = false): Promise<{ id?: string; status?: string }> {
  const payload = await postRunner({ action: id ? 'update' : 'create', organizationId, id, activate: !id && activate, ...input });
  return { id: typeof payload?.id === 'string' ? payload.id : id, status: typeof payload?.status === 'string' ? payload.status : undefined };
}

/** Activeer/pauzeer een Routine. */
export async function setRoutineStatus(organizationId: UUID, id: UUID, status: RoutineStatus): Promise<{ next_run_at: string | null }> {
  const payload = await postRunner({ action: 'set_status', organizationId, id, status });
  return { next_run_at: typeof payload?.next_run_at === 'string' ? payload.next_run_at : null };
}

/**
 * "Verwijdert" een Routine — dat wil zeggen: archiveert hem.
 *
 * Een agent heeft namens jou gewerkt; die historie gooien we niet weg. Hij gaat
 * uit en verdwijnt uit de galerij, maar zijn runs en logboek blijven raadpleegbaar
 * onder "Archief".
 */
export async function archiveRoutine(organizationId: UUID, id: UUID): Promise<void> {
  await postRunner({ action: 'archive', organizationId, id });
}

/** Haalt een gearchiveerde Routine terug; hij komt gepauzeerd terug. */
export async function restoreRoutine(organizationId: UUID, id: UUID): Promise<void> {
  await postRunner({ action: 'restore', organizationId, id });
}

/** Draait een Routine direct (handmatig; verandert het schema niet). Wacht op het resultaat. */
export async function runRoutineNow(organizationId: UUID, id: UUID): Promise<{ status: string; proposalsCreated?: number }> {
  const payload = await postRunner({ action: 'run_now', organizationId, id });
  return { status: String(payload?.status ?? 'onbekend'), proposalsCreated: Number(payload?.proposalsCreated ?? 0) };
}

/** Openstaande voorstellen van één run (uit de goedkeurwachtrij ai_action_audit). */
export async function listRunProposals(organizationId: UUID, runId: UUID): Promise<Array<{ auditId: string; proposal: GerrieProposal }>> {
  const { data, error } = await supabase.from('ai_action_audit')
    .select('id, params, status').eq('organization_id', organizationId).eq('agent_run_id', runId).eq('status', 'proposed');
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((r: { id: string; params: unknown }) => ({ auditId: String(r.id), proposal: r.params as GerrieProposal }))
    .filter((r) => r.proposal && typeof r.proposal.type === 'string');
}

/**
 * Eén openstaande beslissing in de goedkeurwachtrij: een agent heeft iets
 * klaargezet en wacht op een mens.
 */
export interface AgentApproval {
  auditId: string;
  proposal: GerrieProposal;
  createdAt: string;
  runId: UUID | null;
  agentId: UUID | null;
  /** Naam van de agent; valt terug op "Gerrie-agent" als de naam niet leesbaar is. */
  agentName: string;
  agentIcon: string | null;
  agentHue: number | null;
  /**
   * Waar dit voorstel vandaan komt.
   *
   * 'agent' — een geplande Gerrie-agent, ons eigen model binnen onze eigen app.
   * 'mcp'   — de eigen AI van een teamlid, gekoppeld van buitenaf.
   * 'api'   — andere software, via een API-sleutel (webshop, Zapier, …).
   *
   * Dat onderscheid hoort zichtbaar te zijn en niet weggepoetst: een voorstel
   * van een model of programma dat niet van ons is, lees je met andere ogen dan
   * een voorstel van een agent die iemand hier zelf heeft ingericht.
   */
  source: 'agent' | 'mcp' | 'api';
}

/**
 * Alles wat op dit moment op jouw akkoord wacht — over álle agents heen.
 *
 * Bewust alleen voorstellen mét `agent_run_id`: dat zijn de voorstellen die
 * ONBEWAAKT zijn ontstaan (een geplande agent draaide terwijl niemand keek) en
 * dus nergens anders getoond worden. Voorstellen uit de chat of uit een live
 * missie in het commandocentrum kregen hun akkoord-knop al op het scherm waar ze
 * ontstonden; die hier nóg een keer tonen zou elke genegeerde chat-suggestie voor
 * altijd op het startscherm plakken.
 *
 * De agentnamen zijn best-effort: `ai_agents` is owner/admin-only, dus een gewoon
 * teamlid ziet de wachtrij wél maar de naam niet. Dan valt hij terug op een
 * neutraal label in plaats van de hele kaart te laten mislukken.
 */
export async function listPendingAgentApprovals(organizationId: UUID, limit = 30): Promise<AgentApproval[]> {
  // Drie soorten voorstellen wachten hier: die van een geplande agent, die van
  // een gekoppelde AI (MCP) en die van een API-sleutel. Alle drie zijn ze
  // headless klaargezet terwijl er niemand keek — precies waarvoor deze wachtrij
  // bestaat.
  const pending = (columns: string, sources: string) => supabase.from('ai_action_audit')
    .select(columns)
    .eq('organization_id', organizationId)
    .eq('status', 'proposed')
    .or(sources)
    .order('created_at', { ascending: false })
    .limit(limit);
  let { data, error } = await pending(
    'id, params, created_at, agent_id, agent_run_id, mcp_grant_id, api_key_id, result',
    'agent_run_id.not.is.null,mcp_grant_id.not.is.null,api_key_id.not.is.null',
  );
  // De app loopt vóór op de database: zonder de API-migratie bestaat de kolom
  // api_key_id nog niet. Dan de wachtrij zoals hij was, in plaats van leeg.
  if (error && isMissingColumn(error, 'api_key_id')) {
    ({ data, error } = await pending(
      'id, params, created_at, agent_id, agent_run_id, mcp_grant_id, result',
      'agent_run_id.not.is.null,mcp_grant_id.not.is.null',
    ));
  }
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as Array<{
    id: string; params: unknown; created_at: string;
    agent_id: string | null; agent_run_id: string | null;
    mcp_grant_id: string | null; api_key_id?: string | null; result: { via?: string } | null;
  }>;
  const valid = rows.filter((r) => r.params && typeof (r.params as GerrieProposal).type === 'string');
  if (valid.length === 0) return [];

  const agentIds = [...new Set(valid.map((r) => r.agent_id).filter((id): id is string => Boolean(id)))];
  const names = new Map<string, { name: string; icon: string | null; hue: number | null }>();
  if (agentIds.length > 0) {
    const { data: agents } = await supabase.from('ai_agents')
      .select('id, name, icon, hue').eq('organization_id', organizationId).in('id', agentIds);
    for (const a of (agents ?? []) as Array<{ id: string; name: string | null; icon: string | null; hue: number | null }>) {
      names.set(a.id, { name: a.name?.trim() || 'Naamloze agent', icon: a.icon ?? null, hue: a.hue ?? null });
    }
  }

  return valid.map((r) => {
    const meta = r.agent_id ? names.get(r.agent_id) : undefined;
    const fromMcp = Boolean(r.mcp_grant_id);
    const fromApi = !fromMcp && Boolean(r.api_key_id);
    // De naam van de koppeling of sleutel staat in de rij zelf en niet in
    // mcp_grants/api_keys: die tabellen geven via RLS niet altijd de rijen van
    // collega's, en deze wachtrij is van het hele team. Zonder die kopie stond
    // hier bij het voorstel van een collega geen afzender.
    const external = fromMcp || fromApi;
    return {
      auditId: String(r.id),
      proposal: r.params as GerrieProposal,
      createdAt: r.created_at,
      runId: (r.agent_run_id as UUID | null) ?? null,
      agentId: (r.agent_id as UUID | null) ?? null,
      agentName: fromMcp
        ? (r.result?.via?.trim() || 'Een gekoppelde AI')
        : fromApi ? (r.result?.via?.trim() || 'Een API-koppeling') : (meta?.name ?? 'Gerrie-agent'),
      agentIcon: external ? null : (meta?.icon ?? null),
      agentHue: external ? null : (meta?.hue ?? null),
      source: fromMcp ? 'mcp' as const : fromApi ? 'api' as const : 'agent' as const,
    };
  });
}

// ── Het logboek van een run ──────────────────────────────────────────────────

export type RunEventKind = 'start' | 'tool' | 'proposal' | 'answer' | 'delivery' | 'reply' | 'error' | 'finish';

/** Eén stap uit het logboek: wat de agent op dat moment deed. */
export interface GerrieRunEvent {
  id: UUID;
  seq: number;
  kind: RunEventKind;
  label: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/** Het volledige logboek van één run, in de volgorde waarin het gebeurde. */
export async function listRunEvents(organizationId: UUID, runId: UUID): Promise<GerrieRunEvent[]> {
  const { data, error } = await supabase.from('ai_agent_run_events')
    .select('id, seq, kind, label, detail, created_at')
    .eq('organization_id', organizationId).eq('run_id', runId)
    .order('seq', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { id: string; seq: number; kind: string; label: string; detail: unknown; created_at: string }) => ({
    id: r.id as UUID,
    seq: Number(r.seq),
    kind: r.kind as RunEventKind,
    label: String(r.label ?? ''),
    detail: (r.detail && typeof r.detail === 'object' ? r.detail : {}) as Record<string, unknown>,
    created_at: r.created_at,
  }));
}

/** Wat er met de voorstellen van een run is gebeurd — óók de afgehandelde. */
export interface GerrieRunDecision {
  auditId: string;
  action: string;
  status: 'proposed' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'auto_executed' | string;
  detail: string | null;
  createdAt: string;
}

export async function listRunDecisions(organizationId: UUID, runId: UUID): Promise<GerrieRunDecision[]> {
  const { data, error } = await supabase.from('ai_action_audit')
    .select('id, action, status, result, created_at')
    .eq('organization_id', organizationId).eq('agent_run_id', runId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { id: string; action: string; status: string; result: unknown; created_at: string }) => {
    const res = (r.result && typeof r.result === 'object' ? r.result : {}) as { detail?: unknown };
    return {
      auditId: String(r.id),
      action: String(r.action ?? ''),
      status: String(r.status ?? 'proposed'),
      detail: res.detail != null ? String(res.detail) : null,
      createdAt: r.created_at,
    };
  });
}

/** Eén beurt in het gesprek/transcript van een run. */
export interface GerrieRunMessage { role: 'user' | 'assistant'; content: string; created_at: string }

/** Het volledige transcript (user + assistant) van een run, oplopend gesorteerd. */
export async function loadRunTranscript(organizationId: UUID, conversationId: UUID): Promise<GerrieRunMessage[]> {
  const { data, error } = await supabase.from('ai_messages')
    .select('role, content, created_at').eq('organization_id', organizationId).eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((m: { role: string; content: string; created_at: string }) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? ''), created_at: m.created_at,
  }));
}

/** Antwoord op een run (bv. "ja, verstuur maar"). De agent draait nog een beurt; een
 *  eventueel voorstel belandt in de goedkeurwachtrij. */
export async function replyToRun(organizationId: UUID, runId: UUID, message: string): Promise<{ text: string; proposalCreated: number }> {
  const payload = await postRunner({ action: 'reply', organizationId, runId, message });
  return { text: String(payload?.text ?? ''), proposalCreated: Number(payload?.proposalCreated ?? 0) };
}

/**
 * Eén capability die je aan een agent kunt geven.
 *
 * `kind: 'read'` = meekijken; `kind: 'propose'` = klaarzetten, altijd achter jouw
 * akkoord. `module` bepaalt de groep in de bouwer én of dit teamlid hem überhaupt
 * te zien krijgt.
 */
export interface RoutineTool { name: string; label: string; module: string | null; moduleLabel: string | null; kind: 'read' | 'propose' }

/**
 * Alles wat een agent kan, afgeleid uit de échte tooldefinities in gerrieCore en
 * gefilterd op jouw modulerechten.
 *
 * Bewust een server-call en geen lijst in deze file: die lijst was handgeschreven en
 * liep achter — twaalf dingen die Gerrie in de chat allang kon waren aan een agent
 * niet te geven, puur omdat ze hier ontbraken. Wat de assistent kan, kan een agent nu
 * automatisch ook.
 */
export async function listRoutineTools(organizationId: UUID): Promise<RoutineTool[]> {
  const payload = await postRunner({ action: 'tools', organizationId });
  const rows = Array.isArray(payload?.tools) ? (payload.tools as unknown[]) : [];
  const tools = rows
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.name === 'string')
    .map((r) => ({
      name: String(r.name),
      label: String(r.label ?? r.name),
      module: r.module != null ? String(r.module) : null,
      moduleLabel: r.moduleLabel != null ? String(r.moduleLabel) : null,
      kind: r.kind === 'propose' ? 'propose' as const : 'read' as const,
    }));
  for (const t of tools) { toolLabels.set(t.name, t.label); toolKinds.set(t.name, t.kind); }
  return tools;
}

/**
 * Labels van de laatst opgehaalde catalogus, zodat schermen die alleen een naam in
 * handen hebben (een chip op de agentkaart, een regel in het logboek) er geen eigen
 * lijstje voor hoeven bij te houden. Begint gevuld met de terugval hieronder.
 */
const toolLabels = new Map<string, string>();

/**
 * En of die capability leest of schrijft.
 *
 * Bij een klassieke tool zie je dat aan de naam (`propose_…`), maar een handeling
 * uit de registry heet gewoon `action:gallery.publish` — daar valt niets aan af te
 * lezen. Zonder deze kaart belandde \"galerij publiceren\" op de agentkaart onder
 * \"kijkt mee\", en dat is precies het verkeerde om je in te vergissen.
 */
const toolKinds = new Map<string, 'read' | 'propose'>();

/** Leest deze capability alleen mee? */
export function routineToolIsRead(name: string): boolean {
  const known = toolKinds.get(name);
  if (known) return known === 'read';
  // Catalogus nog niet geladen: de naam is dan het enige houvast.
  return !name.startsWith('propose_');
}

/**
 * Menselijk label bij een tool-naam. Kent de catalogus hem niet (offline, oude
 * functie-versie), dan een algemeen label: een gebruiker ziet nooit de technische
 * naam, ook niet half vertaald ("gallery publish").
 */
export function routineToolLabel(name: string): string {
  return toolLabels.get(name) ?? fallbackToolLabel(name);
}

/** Het label van een handeling uit de registry ('inbox.list'), als de catalogus hem kent. */
export function registryActionLabel(actionId: string): string | null {
  return toolLabels.get(`action:${actionId}`) ?? null;
}

/**
 * Terugval als de catalogus niet op te halen is (offline, module dicht, oude
 * functie-versie). Bewust kort: hij dient om de bouwer bruikbaar te houden, niet om
 * de echte lijst te dupliceren.
 */
const ROUTINE_FALLBACK_TOOLS: RoutineTool[] = [
  { name: 'search_clients', label: 'Klanten opzoeken', module: 'clients', moduleLabel: 'Klanten', kind: 'read' },
  { name: 'list_invoices', label: 'Facturen bekijken', module: 'finance', moduleLabel: 'Financiën', kind: 'read' },
  { name: 'list_quotes', label: 'Offertes bekijken', module: 'finance', moduleLabel: 'Financiën', kind: 'read' },
  { name: 'list_due_reminders', label: 'Openstaande herinneringen', module: 'finance', moduleLabel: 'Financiën', kind: 'read' },
  { name: 'get_financial_summary', label: 'Financieel overzicht', module: 'finance', moduleLabel: 'Financiën', kind: 'read' },
  { name: 'list_projects', label: 'Projecten bekijken', module: 'projects', moduleLabel: 'Projecten', kind: 'read' },
  { name: 'list_tasks', label: 'Taken bekijken', module: 'projects', moduleLabel: 'Projecten', kind: 'read' },
  { name: 'list_tickets', label: 'Tickets bekijken', module: 'tickets', moduleLabel: 'Tickets', kind: 'read' },
];
for (const t of ROUTINE_FALLBACK_TOOLS) toolLabels.set(t.name, t.label);

/** Eén stap uit een proefrun: waarmee hij zocht en wat hij vond. */
export interface RoutinePreviewStep { kind: string; label: string; ok: boolean; detail: Record<string, unknown> }
export interface RoutinePreview {
  ok: boolean;
  /** true = je maandtegoed is op; er is niets gedraaid. */
  budget?: boolean;
  text: string;
  steps: RoutinePreviewStep[];
  tools: string[];
}

/**
 * Draait de agent één keer proef, vóór hij bestaat.
 *
 * Bewust alleen met lees-tools: een proefrun hoort niets klaar te zetten dat op je
 * akkoord gaat wachten. Er wordt ook geen agent, run of gesprek aangemaakt — je ziet
 * alleen wat hij vindt, plus de stappen die hij zette, zodat je kunt zien óf hij echt
 * gekeken heeft en waarmee hij filterde.
 */
export async function previewRoutine(organizationId: UUID, input: {
  instruction: string; enabled_tools: string[]; model_kind: 'cheap' | 'strong';
}): Promise<RoutinePreview> {
  const payload = await postRunner({ action: 'preview', organizationId, ...input });
  const steps = Array.isArray(payload?.steps) ? (payload.steps as unknown[]) : [];
  return {
    ok: payload?.ok === true,
    budget: payload?.budget === true,
    text: String(payload?.text ?? ''),
    steps: steps.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        kind: String(row.kind ?? ''),
        label: String(row.label ?? ''),
        ok: row.ok !== false,
        detail: (row.detail && typeof row.detail === 'object' ? row.detail : {}) as Record<string, unknown>,
      };
    }),
    tools: Array.isArray(payload?.tools) ? (payload.tools as unknown[]).map(String) : [],
  };
}

/** De catalogus, of de terugval als de server hem niet kon leveren. */
export async function listRoutineToolsSafe(organizationId: UUID): Promise<{ tools: RoutineTool[]; fallback: boolean }> {
  try {
    const tools = await listRoutineTools(organizationId);
    if (tools.length > 0) return { tools, fallback: false };
  } catch { /* val terug */ }
  return { tools: ROUTINE_FALLBACK_TOOLS, fallback: true };
}

function parseSseBlock(block: string): { event: string; data: unknown } | null {
  let event = 'message';
  let dataStr = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  try { return { event, data: JSON.parse(dataStr) }; } catch { return null; }
}
