import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Mic, Phone, PhoneIncoming, PhoneOutgoing, Play, Square, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { Button, Input, Select, Textarea } from './Ui';
import { MeetingRecorder } from './MeetingRecorder';
import {
  CALL_OUTCOME_ORDER, callCounterpart, callDurationLabel, callOutcomeLabel,
  describeMatches, formatPhone, matchPhoneLocally, normalizePhoneE164, telHref,
} from '../lib/calls';
import { clearPendingCall, rememberCall } from '../lib/callBridge';
import { createClientCall, deleteClientCall, findContactsByPhone, updateClientCall } from '../lib/repository';
import type { AppData, CallDirection, CallOutcome, CallSource, ClientCall, PhoneMatch, UUID } from '../types';

/**
 * Een telefoongesprek loggen — met de hand, of als afronding van een tik op een
 * telefoonlink.
 *
 * Het venster doet drie dingen die het loggen kort houden, want een gesprek dat
 * drie minuten kost om vast te leggen, wordt niet vastgelegd:
 *
 * 1. **Het nummer herkent zichzelf.** Tijdens het typen zoekt de app het nummer
 *    op in klanten, contactpersonen en leveranciers — eerst in wat al geladen
 *    is (meteen, zonder netwerk), daarna bij de database (ook wat niet geladen
 *    is). Meerdere treffers worden een keuze, nooit een gok: één kantoornummer
 *    hoort vaak bij meer dan één iemand.
 * 2. **De duur loopt mee.** Bel je vanuit de app, dan telt de timer; kom je
 *    terug van een tik op een telefoonlink, dan staat er een voorstel — met
 *    zoveel woorden als voorstel, want de app meet de gespreksduur niet, hij
 *    weet alleen hoe lang je weg was.
 * 3. **Opnemen gaat zoals bij een meeting.** Dezelfde recorder, dezelfde keten
 *    (R2 → ElevenLabs Scribe → Claude-samenvatting), dezelfde AVG-toestemming.
 *    Een opname hangt aan een bestaand gesprek, dus het gesprek wordt eerst
 *    opgeslagen; dat gebeurt vanzelf als je op opnemen drukt.
 */

export interface CallDraft {
  direction?: CallDirection;
  phone?: string;
  counterpartName?: string | null;
  clientId?: UUID | null;
  contactId?: UUID | null;
  supplierId?: UUID | null;
  projectId?: UUID | null;
  ticketId?: UUID | null;
  /** Voorstel voor de gespreksduur in seconden (bovengrens, zie callBridge). */
  proposedSeconds?: number | null;
  source?: CallSource;
  startedAt?: string;
}

interface Props {
  organizationId: UUID;
  data: AppData;
  canWrite: boolean;
  /** Bestaand gesprek bewerken; leeg = een nieuw gesprek loggen. */
  existing?: ClientCall | null;
  /** Voorinvulling bij een nieuw gesprek (klantdossier, of de telefoonlink-brug). */
  draft?: CallDraft | null;
  onClose: () => void;
  onSaved: () => void;
}

/** `datetime-local` wil 'JJJJ-MM-DDTuu:mm' in lokale tijd, niet ISO met Z. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

function matchKey(match: PhoneMatch): string {
  return `${match.match_kind}:${match.contact_id ?? match.supplier_id ?? match.client_id ?? ''}`;
}

export function CallLogDialog({ organizationId, data, canWrite, existing, draft, onClose, onSaved }: Props) {
  const editing = Boolean(existing);

  const [direction, setDirection] = useState<CallDirection>(existing?.direction ?? draft?.direction ?? 'outbound');
  const [outcome, setOutcome] = useState<CallOutcome>(existing?.outcome ?? 'answered');
  const [phone, setPhone] = useState(existing?.phone_raw ?? draft?.phone ?? '');
  const [counterpartName, setCounterpartName] = useState(existing?.counterpart_name ?? draft?.counterpartName ?? '');
  const [clientId, setClientId] = useState<string>(existing?.client_id ?? draft?.clientId ?? '');
  const [contactId, setContactId] = useState<string>(existing?.contact_id ?? draft?.contactId ?? '');
  const [supplierId, setSupplierId] = useState<string>(existing?.supplier_id ?? draft?.supplierId ?? '');
  const [projectId, setProjectId] = useState<string>(existing?.project_id ?? draft?.projectId ?? '');
  const [ticketId, setTicketId] = useState<string>(existing?.ticket_id ?? draft?.ticketId ?? '');
  const [startedAt, setStartedAt] = useState(toLocalInput(existing?.started_at ?? draft?.startedAt ?? new Date().toISOString()));
  const [seconds, setSeconds] = useState<number>(existing?.duration_seconds ?? draft?.proposedSeconds ?? 0);
  const [subject, setSubject] = useState(existing?.subject ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Zodra het gesprek bestaat kan er opgenomen worden; daarvóór niet. */
  const [callId, setCallId] = useState<UUID | null>(existing?.id ?? null);
  const [showRecorder, setShowRecorder] = useState(false);

  // De duur is een voorstel zolang hij van de telefoonlink-brug komt: de app
  // weet hoe lang je wég was, niet hoe lang je belde.
  const [durationIsProposal, setDurationIsProposal] = useState(Boolean(draft?.proposedSeconds) && !editing);

  // ── Timer, voor wie vanuit de app belt ────────────────────────────────────
  const [timerOn, setTimerOn] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!timerOn) return;
    timerRef.current = window.setInterval(() => { setSeconds(s => s + 1); setDurationIsProposal(false); }, 1000);
    return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
  }, [timerOn]);

  // ── Nummerherkenning ──────────────────────────────────────────────────────
  // Eerst lokaal, zodat er tijdens het typen meteen iets staat; daarna vraagt
  // de database het na, want die kent ook wat de app niet geladen heeft.
  const localMatches = useMemo(
    () => matchPhoneLocally(phone, { clients: data.clients, contacts: data.clientContacts, suppliers: data.suppliers }),
    [phone, data.clients, data.clientContacts, data.suppliers],
  );
  const [serverMatches, setServerMatches] = useState<PhoneMatch[]>([]);
  useEffect(() => {
    const e164 = normalizePhoneE164(phone);
    if (!e164) { setServerMatches([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      findContactsByPhone(organizationId, e164)
        .then(rows => { if (!cancelled) setServerMatches(rows); })
        .catch(() => { if (!cancelled) setServerMatches([]); });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [phone, organizationId]);

  /** Lokaal en server samengevoegd, zonder dubbele rijen. */
  const matches = useMemo(() => {
    const seen = new Set<string>();
    const all: PhoneMatch[] = [];
    for (const match of [...localMatches, ...serverMatches]) {
      const key = matchKey(match);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(match);
    }
    return all;
  }, [localMatches, serverMatches]);

  /** Eén treffer en nog niets gekozen: dan kiest de app hem alvast. */
  const autoAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (matches.length !== 1) return;
    if (clientId || contactId || supplierId || counterpartName.trim()) return;
    const key = matchKey(matches[0]);
    if (autoAppliedRef.current === key) return;
    autoAppliedRef.current = key;
    applyMatch(matches[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function applyMatch(match: PhoneMatch) {
    setClientId(match.client_id ?? '');
    setContactId(match.contact_id ?? '');
    setSupplierId(match.supplier_id ?? '');
    setCounterpartName(match.display_name);
  }

  const contactsOfClient = useMemo(
    () => data.clientContacts.filter(c => c.client_id === clientId && c.is_active).sort((a, b) => a.name.localeCompare(b.name, 'nl')),
    [data.clientContacts, clientId],
  );
  const projectsOfClient = useMemo(
    () => data.projects.filter(p => !clientId || p.client_id === clientId),
    [data.projects, clientId],
  );
  const ticketsOfClient = useMemo(
    () => data.tickets.filter(t => !clientId || t.client_id === clientId),
    [data.tickets, clientId],
  );

  const answered = outcome === 'answered';
  const dialHref = telHref(phone);

  function payload(): Record<string, unknown> {
    return {
      direction,
      outcome,
      phone_raw: phone.trim() || null,
      counterpart_name: counterpartName.trim() || null,
      client_id: clientId || null,
      contact_id: contactId || null,
      supplier_id: supplierId || null,
      project_id: projectId || null,
      ticket_id: ticketId || null,
      started_at: fromLocalInput(startedAt),
      // Alleen bij een gevoerd gesprek heeft een duur betekenis; de database
      // zet hem voor de rest toch op nul, maar dan staat het hier ook eerlijk.
      duration_seconds: answered ? Math.max(0, Math.round(seconds)) : 0,
      subject: subject.trim(),
      notes: notes.trim() || null,
      source: existing?.source ?? draft?.source ?? 'manual',
    };
  }

  /**
   * Slaat op en geeft de id terug. Bestaat het gesprek al (bewerken, of een
   * eerder opgeslagen concept omdat er opgenomen wordt), dan werkt hij bij.
   */
  async function persist(): Promise<UUID> {
    if (callId) {
      await updateClientCall(callId, payload(), organizationId);
      return callId;
    }
    const created = await createClientCall(organizationId, payload());
    setCallId(created.id);
    return created.id;
  }

  async function save() {
    if (!canWrite || saving) return;
    setSaving(true); setError(null);
    try {
      await persist();
      clearPendingCall();
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gesprek opslaan mislukt.');
    } finally {
      setSaving(false);
    }
  }

  /** Opnemen kan pas als het gesprek bestaat — dus eerst stil opslaan. */
  async function enableRecording() {
    if (!canWrite) return;
    setSaving(true); setError(null);
    try {
      await persist();
      setShowRecorder(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gesprek opslaan mislukt — opnemen kan pas als het gesprek bestaat.');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!existing || !canWrite) return;
    if (!window.confirm('Dit gesprek verwijderen? Een eventuele opname, transcript en samenvatting gaan mee.')) return;
    setSaving(true); setError(null);
    try {
      await deleteClientCall(existing.id, organizationId);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verwijderen mislukt.');
      setSaving(false);
    }
  }

  function startDialing() {
    if (!dialHref) return;
    // Onthouden vóór de navigatie: daarna kan het tabblad weg zijn.
    rememberCall({
      phone,
      counterpartName: counterpartName.trim() || null,
      clientId: clientId || null,
      contactId: contactId || null,
      supplierId: supplierId || null,
    });
    setTimerOn(true);
    window.location.href = dialHref;
  }

  const clientName = clientId ? (data.clients.find(c => c.id === clientId)?.name ?? null) : null;
  /**
   * De titel die de AI-samenvatting als context krijgt. Dezelfde kolom die een
   * meeting zijn afspraaktitel geeft — daardoor hoeft de notulen-pijplijn niets
   * te weten van gesprekken.
   */
  const recorderTitle = [
    'Telefoongesprek',
    counterpartName.trim() ? `met ${counterpartName.trim()}` : null,
    clientName ? `(${clientName})` : null,
  ].filter(Boolean).join(' ');

  /** Met wie je sprak, als ontvanger voor "samenvatting mailen". */
  const recorderAttendees = useMemo(() => {
    const contact = contactId ? data.clientContacts.find(c => c.id === contactId) : null;
    if (contact?.email) return [{ email: contact.email, name: contact.name }];
    const client = clientId ? data.clients.find(c => c.id === clientId) : null;
    if (client?.email) return [{ email: client.email, name: client.name }];
    return [];
  }, [contactId, clientId, data.clientContacts, data.clients]);

  return <Modal
    title={editing ? 'Gesprek bewerken' : 'Telefoongesprek loggen'}
    onClose={onClose}
    className="call-log-modal"
    footer={<>
      {editing && <Button variant="danger" onClick={remove} disabled={!canWrite || saving}><Trash2 size={14} /> Verwijderen</Button>}
      <span className="modal-foot-spacer" />
      <Button onClick={onClose} disabled={saving}>Annuleren</Button>
      <Button variant="primary" onClick={save} disabled={!canWrite || saving}>
        {saving ? <><Loader2 size={14} className="spin" /> Opslaan…</> : <><Check size={14} /> Gesprek opslaan</>}
      </Button>
    </>}
  >
    {!canWrite && <div className="client-empty-line">Je hebt geen schrijfrechten om gesprekken te loggen.</div>}

    {/* Richting — het eerste wat je weet van een gesprek. */}
    <div className="call-direction" role="group" aria-label="Richting">
      <button
        type="button"
        className={`call-direction-btn${direction === 'outbound' ? ' is-active' : ''}`}
        onClick={() => setDirection('outbound')}
        aria-pressed={direction === 'outbound'}
      ><PhoneOutgoing size={15} aria-hidden="true" /> Uitgaand</button>
      <button
        type="button"
        className={`call-direction-btn${direction === 'inbound' ? ' is-active' : ''}`}
        onClick={() => setDirection('inbound')}
        aria-pressed={direction === 'inbound'}
      ><PhoneIncoming size={15} aria-hidden="true" /> Inkomend</button>
    </div>

    {/* Nummer + herkenning */}
    <label className="field">Telefoonnummer
      <div className="call-phone-row">
        <Input
          value={phone}
          onChange={e => { setPhone(e.target.value); autoAppliedRef.current = null; }}
          placeholder="06 12 34 56 78"
          inputMode="tel"
          autoComplete="tel"
          disabled={!canWrite}
        />
        {dialHref && <Button onClick={startDialing} disabled={!canWrite} title="Bellen en de timer starten">
          <Phone size={14} /> Bellen
        </Button>}
      </div>
    </label>

    {phone.trim().length > 2 && <div className={`call-matches${matches.length > 1 ? ' is-choice' : ''}`}>
      <span className="call-matches-head">{describeMatches(matches)}</span>
      {matches.length > 0 && <div className="call-match-list">
        {matches.map(match => {
          const active = (match.contact_id && match.contact_id === contactId)
            || (match.supplier_id && match.supplier_id === supplierId)
            || (match.match_kind === 'client' && match.client_id === clientId && !contactId);
          return <button
            key={matchKey(match)}
            type="button"
            className={`call-match${active ? ' is-active' : ''}`}
            onClick={() => applyMatch(match)}
            disabled={!canWrite}
          >
            <strong>{match.display_name}</strong>
            <span>{[
              match.match_kind === 'supplier' ? 'Leverancier' : match.client_name,
              match.role,
              formatPhone(match.phone),
            ].filter(Boolean).join(' · ')}</span>
          </button>;
        })}
      </div>}
      {normalizePhoneE164(phone) === null && phone.trim().length > 4
        && <span className="call-matches-hint">Dit lijkt geen volledig telefoonnummer. Een buitenlands nummer heeft + of 00 nodig.</span>}
    </div>}

    <label className="field">Met wie sprak je
      <Input value={counterpartName} onChange={e => setCounterpartName(e.target.value)} placeholder="Naam van de persoon" disabled={!canWrite} />
    </label>

    <div className="form-grid">
      <label className="field">Klant
        <Select value={clientId} onChange={e => { setClientId(e.target.value); setContactId(''); setProjectId(''); setTicketId(''); }} disabled={!canWrite} searchable searchPlaceholder="Zoek een klant…">
          <option value="">Geen klant</option>
          {data.clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </label>
      <label className="field">Contactpersoon
        <Select value={contactId} onChange={e => setContactId(e.target.value)} disabled={!canWrite || !clientId}>
          <option value="">{clientId ? 'Geen contactpersoon' : 'Kies eerst een klant'}</option>
          {contactsOfClient.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </label>
    </div>

    {/* Afloop + wanneer + hoe lang */}
    <div className="form-grid">
      <label className="field">Afloop
        <Select value={outcome} onChange={e => setOutcome(e.target.value as CallOutcome)} disabled={!canWrite}>
          {CALL_OUTCOME_ORDER.map(value => <option key={value} value={value}>{callOutcomeLabel(value)}</option>)}
        </Select>
      </label>
      <label className="field">Wanneer
        <Input type="datetime-local" value={startedAt} onChange={e => setStartedAt(e.target.value)} disabled={!canWrite} />
      </label>
    </div>

    {answered && <div className="call-duration">
      <span className="call-duration-label">Gespreksduur</span>
      <div className="call-duration-row">
        <Input
          type="number"
          min={0}
          value={Math.round(seconds / 60)}
          onChange={e => { setSeconds(Math.max(0, Number(e.target.value) || 0) * 60); setDurationIsProposal(false); }}
          disabled={!canWrite}
          aria-label="Gespreksduur in minuten"
        />
        <span className="call-duration-unit">minuten</span>
        <Button
          onClick={() => setTimerOn(on => !on)}
          disabled={!canWrite}
          title={timerOn ? 'Timer stoppen' : 'Timer laten meelopen tijdens het gesprek'}
        >
          {timerOn ? <><Square size={14} /> Stop</> : <><Play size={14} /> Timer</>}
        </Button>
        <span className={`call-duration-clock${timerOn ? ' is-running' : ''}`}>{callDurationLabel(seconds)}</span>
      </div>
      {durationIsProposal && <p className="call-duration-note">
        Voorstel: zo lang was je weg uit de app. Dat is een bovengrens, geen meting — pas hem gerust aan.
      </p>}
    </div>}

    <label className="field">Waar ging het over
      <Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Kort onderwerp — leeg laten mag" disabled={!canWrite} />
    </label>

    <label className="field">Aantekening
      <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Wat is er afgesproken?" disabled={!canWrite} />
    </label>

    {(projectsOfClient.length > 0 || ticketsOfClient.length > 0) && <div className="form-grid">
      <label className="field">Project
        <Select value={projectId} onChange={e => setProjectId(e.target.value)} disabled={!canWrite}>
          <option value="">Geen project</option>
          {projectsOfClient.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </label>
      <label className="field">Ticket
        <Select value={ticketId} onChange={e => setTicketId(e.target.value)} disabled={!canWrite}>
          <option value="">Geen ticket</option>
          {ticketsOfClient.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
        </Select>
      </label>
    </div>}

    {/* Opnemen — precies zoals bij een meeting. */}
    <section className="call-recording">
      <div className="call-recording-head">
        <Mic size={14} aria-hidden="true" />
        <strong>Opnemen en samenvatten</strong>
      </div>
      {showRecorder && callId
        ? <MeetingRecorder
            organizationId={organizationId}
            canWrite={canWrite}
            event={{
              provider: null, sourceId: null, eventRef: null,
              eventTitle: recorderTitle || 'Telefoongesprek',
              clientId: clientId || null,
              projectId: projectId || null,
              callId,
              attendees: recorderAttendees,
            }}
          />
        : <div className="call-recording-start">
            <p>
              Zet het gesprek op de luidspreker en neem op met de microfoon van dit apparaat. Daarna maakt
              ResoFly er een transcript en een samenvatting van — dezelfde keten als bij een meeting.
              Vraag de ander eerst om toestemming; de recorder vraagt je dat te bevestigen.
            </p>
            <Button onClick={enableRecording} disabled={!canWrite || saving}>
              {saving ? <><Loader2 size={14} className="spin" /> Klaarzetten…</> : <><Mic size={14} /> Opname voorbereiden</>}
            </Button>
            {!editing && <span className="call-recording-hint">Het gesprek wordt dan alvast opgeslagen.</span>}
          </div>}
    </section>

    {error && <div className="error">{error}</div>}
  </Modal>;
}

/**
 * Het voorstel na een tik op een telefoonlink: "Gebeld met … — gesprek loggen?"
 * Bewust een smalle balk en geen venster dat over het scherm valt: je komt net
 * terug uit een gesprek en wilt eerst zien waar je was.
 */
export function CallReturnPrompt({ name, phone, awaySeconds, onLog, onDismiss }: {
  name: string | null;
  phone: string;
  awaySeconds: number;
  onLog: () => void;
  onDismiss: () => void;
}) {
  const who = name || formatPhone(phone) || 'onbekend nummer';
  return <div className="call-return-prompt" role="status">
    <Phone size={15} aria-hidden="true" />
    <span className="call-return-text">
      Gebeld met <strong>{who}</strong>
      <span className="call-return-sub">je was {callDurationLabel(awaySeconds)} weg uit de app</span>
    </span>
    <Button variant="primary" onClick={onLog}>Gesprek loggen</Button>
    <button type="button" className="call-return-close" onClick={onDismiss} aria-label="Niet loggen">×</button>
  </div>;
}

/** Kleine hulp voor lijstweergaven: één regel die een gesprek samenvat. */
export function callSummaryLine(call: ClientCall): string {
  return [
    callCounterpart(call),
    callOutcomeLabel(call.outcome),
    call.outcome === 'answered' && call.duration_seconds ? callDurationLabel(call.duration_seconds) : null,
  ].filter(Boolean).join(' · ');
}
