import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Maximize2, Minimize2, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import type { AppData, CalendarExternalEvent, CalendarSource, ConferenceProvider, MeetingBooking, MeetingBookingLinkListItem, MeetingBookingSlot, UUID, VideoServices } from '../types';
import { Button, Input, Textarea, Select, normalizeColor } from '../components/Ui';
import { listExternalCalendarEvents, loadCalendarIntegrations } from '../lib/calendar-api';
import { addDays, startOfWeek } from '../lib/dates';
import { currentFullscreenElement, enterFullscreen, leaveFullscreen, onFullscreenChange } from '../lib/fullscreen';
import { TimeBlockGrid, slotSelectionToIso, type BookingOverlaySlot } from './CalendarPage';
import { BookingVideoSelect } from '../components/BookingVideoSelect';
import { BookingStateBadge } from '../components/ClientBookingLinks';
import { bookingVideoFields, bookingVideoFromLink, defaultBookingVideo, type BookingVideo } from '../lib/meeting';
import {
  BOOKING_STATUS_LABELS,
  LINK_STATE_LABELS,
  SLOT_STATUS_LABELS,
  expiryLabel,
  fmtDayLong,
  fmtMoment,
  fmtTime,
  linkStateExplanation,
} from '../lib/bookingLinks';
import {
  addBookingSlots,
  cancelBooking,
  createBookingLink,
  deleteBookingLink,
  extendBookingLink,
  getBookingLink,
  listBookingLinks,
  regenerateBookingToken,
  removeBookingSlot,
  sendBookingLinkMail,
  updateBookingLink,
  type BookingLinkDetail,
} from '../lib/meetingBookingApi';

/** datetime-local waarde (lokale wandkloktijd) → ISO string. */
function localToIso(local: string): string {
  return new Date(local).toISOString();
}

/** Nu als datetime-local-waarde: de ondergrens van het handmatige invoerveld. */
function nowLocalInput(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

const PROVIDER_LABEL: Record<string, string> = { native: 'ResoFly-agenda', google: 'Google', microsoft: 'Microsoft' };

/**
 * Waar de pagina mee opent: een link (vanaf de klantpagina) of meteen een
 * nieuwe link voor een klant. `key` maakt elke sprong uniek, zodat twee keer
 * dezelfde knop ook twee keer werkt.
 */
export type BookingFocus = { key: number; linkId?: string | null; clientId?: string | null; create?: boolean };

export function MeetingBookingManager({ organizationId, data, canWrite, focus, onFocusHandled }: {
  organizationId: UUID;
  currentUserId: UUID;
  data: AppData;
  canWrite: boolean;
  focus?: BookingFocus | null;
  /** De sprong is uitgevoerd: de app wist hem, anders opende hij opnieuw bij de volgende keer via het menu. */
  onFocusHandled?: () => void;
}) {
  const [links, setLinks] = useState<MeetingBookingLinkListItem[]>([]);
  const [sources, setSources] = useState<CalendarSource[]>([]);
  // Kan ik per boeking een losse Meet/Teams laten maken (alleen mijn eigen koppelingen)?
  const [videoServices, setVideoServices] = useState<VideoServices | null>(null);
  const [selectedId, setSelectedId] = useState<UUID | null>(null);
  const [detail, setDetail] = useState<BookingLinkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Plaintext tokens leven alleen in het geheugen (server bewaart enkel de hash).
  const [tokenByLink, setTokenByLink] = useState<Record<string, { token: string; url: string }>>({});
  const [creating, setCreating] = useState(false);
  /** De klant die een nieuwe link al krijgt (vanaf de klantpagina). */
  const [createForClient, setCreateForClient] = useState<UUID | null>(null);
  const handledFocus = useRef<number | null>(null);

  const writableSources = useMemo(
    () => sources.filter(s => s.provider === 'native' ? true : (s.write_enabled && ['owner', 'writer'].includes(String(s.access_role || '').toLowerCase()))),
    [sources],
  );

  const reloadLinks = useCallback(async () => {
    const rows = await listBookingLinks(organizationId);
    setLinks(rows);
    return rows;
  }, [organizationId]);

  const reloadDetail = useCallback(async (id: UUID) => {
    setDetail(await getBookingLink(organizationId, id));
  }, [organizationId]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [rows, integrations] = await Promise.all([listBookingLinks(organizationId), loadCalendarIntegrations(organizationId)]);
        if (!alive) return;
        setLinks(rows);
        setSources(integrations.sources);
        setVideoServices(integrations.videoServices ?? null);
        // Niet de eerste link kiezen als we hier met een sprong binnenkwamen
        // (die zet zelf de keuze, ook als hij al gewist is).
        if (rows.length && !handledFocus.current) setSelectedId(prev => prev ?? rows[0].id);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Laden mislukt.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  // Een sprong vanaf de klantpagina: die link openen, of meteen een nieuwe
  // link voor die klant.
  useEffect(() => {
    if (!focus || handledFocus.current === focus.key) return;
    handledFocus.current = focus.key;
    setError(null); setNotice(null);
    if (focus.create) {
      setCreateForClient(focus.clientId ?? null);
      setCreating(true);
      setSelectedId(null);
    } else if (focus.linkId) {
      setCreating(false);
      setSelectedId(focus.linkId);
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let alive = true;
    (async () => {
      try { const d = await getBookingLink(organizationId, selectedId); if (alive) setDetail(d); }
      catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Laden mislukt.'); }
    })();
    return () => { alive = false; };
  }, [selectedId, organizationId]);

  const run = useCallback(async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); if (ok) setNotice(ok); }
    catch (e) { setError(e instanceof Error ? e.message : 'Actie mislukt.'); }
    finally { setBusy(false); }
  }, []);

  const clientsById = useMemo(() => new Map(data.clients.map(c => [c.id, c])), [data.clients]);
  const clientOptions = useMemo(() => data.clients.map(c => ({ id: c.id, label: c.name })), [data.clients]);

  return (
    <div className="mbk-layout">
      <div className="card mbk-aside">
        <div className="mbk-aside-head">
          <strong>Boekingslinks</strong>
          {canWrite && <Button variant="primary" onClick={() => { setCreateForClient(null); setCreating(true); setSelectedId(null); }}>Nieuw</Button>}
        </div>
        {loading && <p className="muted">Laden…</p>}
        {!loading && links.length === 0 && <p className="muted">Nog geen boekingslinks. Met een boekingslink kiest een klant zelf een moment uit de tijden die jij aanbiedt; de afspraak komt meteen in je agenda.</p>}
        <div className="mbk-linklist">
          {links.map(l => (
            <button
              key={l.id}
              className={`nav-item mbk-link ${selectedId === l.id && !creating ? 'active' : ''}`}
              onClick={() => { setCreating(false); setSelectedId(l.id); }}
            >
              <div className="mbk-link-title">
                <span>{l.title}</span>
                <BookingStateBadge state={l.state} />
              </div>
              <div className="muted mbk-link-meta">
                {l.client_name || 'Geen klant'} · {l.booking_count}/{l.max_total_bookings} geboekt
                {l.state === 'open' ? ` · ${l.open_slot_count} vrij` : ''}
                {l.needs_reconnect ? ' · ⚠ koppeling' : ''}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="mbk-main">
        {error && <div className="alert alert-danger" role="alert" style={{ marginBottom: 12 }}>{error}</div>}
        {notice && <div className="alert" role="status" style={{ marginBottom: 12 }}>{notice}</div>}

        {/* Pas na het laden: de keuzelijst met agenda's vult zijn eerste keuze
            maar één keer, en vanaf de klantpagina opent dit formulier meteen. */}
        {creating && !loading && (
          <LinkForm
            key={`create-${createForClient ?? ''}`}
            mode="create"
            sources={writableSources}
            videoServices={videoServices}
            clients={clientOptions}
            busy={busy}
            initial={createForClient ? { clientId: createForClient, title: `Afspraak met ${clientsById.get(createForClient)?.name ?? 'de klant'}` } : undefined}
            onCancel={() => setCreating(false)}
            onSubmit={(payload) => run(async () => {
              const res = await createBookingLink(organizationId, {
                sourceId: payload.sourceId,
                clientId: payload.clientId,
                title: payload.title,
                introText: payload.introText,
                inviteMessage: payload.inviteMessage,
                meetingUrl: payload.meetingUrl,
                maxTotalBookings: payload.maxTotalBookings,
                maxPerWeek: payload.maxPerWeek,
                autoConference: payload.autoConference,
                conferenceProvider: payload.conferenceProvider,
              });
              setTokenByLink(prev => ({ ...prev, [res.link.id]: { token: res.token, url: res.booking_url } }));
              await reloadLinks();
              setCreating(false);
              setSelectedId(res.link.id);
            }, 'Boekingslink aangemaakt. Zet er momenten op en stuur hem daarna naar de klant.')}
          />
        )}

        {!creating && detail && (
          <LinkDetail
            key={detail.link.id}
            detail={detail}
            organizationId={organizationId}
            sources={writableSources}
            videoServices={videoServices}
            clients={clientOptions}
            client={detail.link.client_id ? (clientsById.get(detail.link.client_id) ?? null) : null}
            token={tokenByLink[detail.link.id] ?? null}
            busy={busy}
            canWrite={canWrite}
            onSavedPatch={(patch) => run(async () => {
              await updateBookingLink(organizationId, detail.link.id, patch);
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            }, 'Opgeslagen.')}
            onRegenerate={() => run(async () => {
              const res = await regenerateBookingToken(organizationId, detail.link.id);
              setTokenByLink(prev => ({ ...prev, [res.link.id]: { token: res.token, url: res.booking_url } }));
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            }, 'Nieuwe link gemaakt. De vorige link werkt niet meer.')}
            onExtend={() => run(async () => {
              await extendBookingLink(organizationId, detail.link.id);
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            }, 'Verlengd. De link die de klant al heeft, werkt weer (of langer).')}
            onSendMail={(recipient, opts) => run(async () => {
              let tok = tokenByLink[detail.link.id];
              // De link zelf staat nergens leesbaar opgeslagen. Zonder link in het
              // geheugen maken we een nieuwe; daar is al om bevestiging gevraagd.
              if (!tok && opts.regenerate) {
                const res = await regenerateBookingToken(organizationId, detail.link.id);
                tok = { token: res.token, url: res.booking_url };
                setTokenByLink(prev => ({ ...prev, [res.link.id]: tok! }));
              }
              if (!tok) throw new Error('Maak eerst een nieuwe link om hem te kunnen versturen.');
              await sendBookingLinkMail(organizationId, detail.link.id, tok.token, recipient);
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            }, `Boekingslink verstuurd naar ${recipient.email}.`)}
            onAddSlots={async (slots) => {
              let extra = '';
              await run(async () => {
                const res = await addBookingSlots(organizationId, detail.link.id, slots);
                const parts: string[] = [];
                if (res.warnings.length) parts.push(`${res.warnings.length} ${res.warnings.length === 1 ? 'moment botst' : 'momenten botsen'} met een afspraak in je agenda`);
                if (res.skipped) parts.push(`${res.skipped} ${res.skipped === 1 ? 'moment stond' : 'momenten stonden'} er al op`);
                if (parts.length) extra = `Let op: ${parts.join(', ')}.`;
                await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
              }, slots.length === 1 ? 'Moment toegevoegd.' : 'Momenten toegevoegd.');
              if (extra) setNotice(extra);
            }}
            onRemoveSlot={(slotId) => run(async () => {
              await removeBookingSlot(organizationId, detail.link.id, slotId);
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            })}
            onCancelBooking={(bookingId) => run(async () => {
              await cancelBooking(organizationId, bookingId);
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            }, 'Afspraak geannuleerd en uit de agenda gehaald; het moment is weer vrij. Laat de klant zelf weten dat de afspraak niet doorgaat.')}
            onDelete={() => run(async () => {
              const removedId = detail.link.id;
              await deleteBookingLink(organizationId, removedId);
              setTokenByLink(prev => { const next = { ...prev }; delete next[removedId]; return next; });
              setSelectedId(null);
              setDetail(null);
              await reloadLinks();
            }, 'Boekingslink verwijderd.')}
          />
        )}

        {!creating && !detail && !loading && <p className="muted">Kies links een boekingslink of maak een nieuwe aan.</p>}
      </div>
    </div>
  );
}

interface LinkFormPayload {
  sourceId: UUID;
  clientId: UUID | null;
  title: string;
  introText: string | null;
  inviteMessage: string | null;
  meetingUrl: string | null;
  maxTotalBookings: number;
  maxPerWeek: number;
  autoConference: boolean;
  conferenceProvider: ConferenceProvider;
}

function LinkForm({ mode, sources, videoServices, clients, busy, onSubmit, onCancel, initial }: {
  mode: 'create' | 'edit';
  sources: CalendarSource[];
  videoServices?: VideoServices | null;
  clients: Array<{ id: UUID; label: string }>;
  busy: boolean;
  onSubmit: (p: LinkFormPayload) => void;
  onCancel: () => void;
  initial?: Partial<LinkFormPayload>;
}) {
  const [title, setTitle] = useState(initial?.title ?? 'Afspraak inplannen');
  const [sourceId, setSourceId] = useState<string>(initial?.sourceId ?? (sources[0]?.id ?? ''));
  const [clientId, setClientId] = useState<string>(initial?.clientId ?? '');
  const [introText, setIntroText] = useState(initial?.introText ?? '');
  const [inviteMessage, setInviteMessage] = useState(initial?.inviteMessage ?? '');
  const [meetingUrl, setMeetingUrl] = useState(initial?.meetingUrl ?? '');
  const [maxTotal, setMaxTotal] = useState(String(initial?.maxTotalBookings ?? 1));
  const [maxWeek, setMaxWeek] = useState(String(initial?.maxPerWeek ?? 1));
  const initialProvider = sources.find(s => s.id === (initial?.sourceId ?? sources[0]?.id))?.provider ?? null;
  // Bestaande link: wat hij nu doet. Nieuwe link: wat de agenda zelf kan, anders Jitsi.
  const [video, setVideo] = useState<BookingVideo>(() => mode === 'edit'
    ? bookingVideoFromLink(initial?.autoConference, initial?.conferenceProvider, initialProvider)
    : defaultBookingVideo(initialProvider));

  const selectedProvider = sources.find(s => s.id === sourceId)?.provider ?? null;

  const submit = () => {
    if (!sourceId) return;
    onSubmit({
      sourceId,
      clientId: clientId || null,
      title: title.trim() || 'Afspraak inplannen',
      introText: introText.trim() || null,
      inviteMessage: inviteMessage.trim() || null,
      meetingUrl: meetingUrl.trim() || null,
      maxTotalBookings: Math.max(1, parseInt(maxTotal, 10) || 1),
      maxPerWeek: Math.max(1, parseInt(maxWeek, 10) || 1),
      ...bookingVideoFields(video, selectedProvider),
    });
  };

  return (
    <div className="card mbk-form">
      <strong>{mode === 'create' ? 'Nieuwe boekingslink' : 'Instellingen'}</strong>
      <label>Titel (ziet de klant boven de pagina)<Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Afspraak inplannen" maxLength={160} /></label>
      <div className="mbk-form-grid">
        <label>Agenda waarin de afspraak komt
          <Select value={sourceId} onChange={e => setSourceId(e.target.value)} placeholder="Kies een agenda">
            {sources.map(s => <option key={s.id} value={s.id}>{s.name} ({PROVIDER_LABEL[s.provider] ?? s.provider})</option>)}
          </Select>
        </label>
        <label>Klant (optioneel)
          <Select value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Geen klant">
            <option value="">Geen klant</option>
            {clients.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </label>
      </div>
      <div className="mbk-form-grid">
        <label>Hoeveel afspraken in totaal<Input type="number" min={1} max={999} value={maxTotal} onChange={e => setMaxTotal(e.target.value)} /></label>
        <label>Hoeveel per week<Input type="number" min={1} max={99} value={maxWeek} onChange={e => setMaxWeek(e.target.value)} /></label>
      </div>
      <label>Tekst op de boekingspagina<Textarea value={introText} onChange={e => setIntroText(e.target.value)} rows={2} placeholder="Kies hieronder een moment dat jou uitkomt." /></label>
      <label>Tekst bij de bevestiging en de agenda-uitnodiging<Textarea value={inviteMessage} onChange={e => setInviteMessage(e.target.value)} rows={2} placeholder="Fijn dat we een moment inplannen. Tot dan!" /></label>
      <BookingVideoSelect value={video} sourceProvider={selectedProvider} videoServices={videoServices} onChange={setVideo} />
      <label>Vaste videocall-link (optioneel)<Input value={meetingUrl} onChange={e => setMeetingUrl(e.target.value)} placeholder="https://… — gaat vóór de keuze hierboven" /></label>
      {sources.length === 0 && <p className="muted">Er is nog geen agenda waarin ResoFly mag schrijven. Koppel of maak eerst een agenda (Instellingen → Agenda).</p>}
      <div className="mbk-form-actions">
        <Button variant="primary" onClick={submit} disabled={busy || !sourceId}>{mode === 'create' ? 'Aanmaken' : 'Opslaan'}</Button>
        <Button onClick={onCancel} disabled={busy}>Annuleren</Button>
      </div>
    </div>
  );
}

function LinkDetail({ detail, organizationId, sources, videoServices, clients, client, token, busy, canWrite, onSavedPatch, onRegenerate, onExtend, onSendMail, onAddSlots, onRemoveSlot, onCancelBooking, onDelete }: {
  detail: BookingLinkDetail;
  organizationId: UUID;
  sources: CalendarSource[];
  videoServices?: VideoServices | null;
  clients: Array<{ id: UUID; label: string }>;
  client: { name: string; contact_name?: string | null; email?: string | null } | null;
  token: { token: string; url: string } | null;
  busy: boolean;
  canWrite: boolean;
  onSavedPatch: (patch: Record<string, unknown>) => void;
  onRegenerate: () => void;
  onExtend: () => void;
  onSendMail: (recipient: { email: string; name?: string }, opts: { regenerate: boolean }) => void;
  onAddSlots: (slots: Array<{ startsAt: string; endsAt: string }>) => void;
  onRemoveSlot: (slotId: UUID) => void;
  onCancelBooking: (bookingId: UUID) => void;
  onDelete: () => void;
}) {
  const link = detail.link;
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [copied, setCopied] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState(client?.email ?? '');
  const [recipientName, setRecipientName] = useState(client?.contact_name || client?.name || '');
  const [showPast, setShowPast] = useState(false);

  const slots = detail.slots as MeetingBookingSlot[];
  const bookings = detail.bookings as MeetingBooking[];
  const now = Date.now();
  const upcomingSlots = slots.filter(s => Date.parse(s.ends_at) > now && s.status !== 'cancelled');
  const pastSlots = slots.filter(s => Date.parse(s.ends_at) <= now || s.status === 'cancelled');
  const openCount = detail.open_slot_count ?? upcomingSlots.filter(s => s.status === 'open').length;
  // "Niet geboekt" = geen lopende of bevestigde boekingen; alleen dan mag de hele link weg.
  const activeBookingCount = bookings.filter(b => b.status === 'pending' || b.status === 'confirmed').length;
  const slotById = useMemo(() => new Map(slots.map(s => [s.id, s])), [slots]);
  const visibleBookings = bookings.filter(b => b.status !== 'failed');
  const upcomingBookings = visibleBookings.filter(b => { const s = slotById.get(b.slot_id); return !s || Date.parse(s.ends_at) > now; });
  const pastBookings = visibleBookings.filter(b => { const s = slotById.get(b.slot_id); return s && Date.parse(s.ends_at) <= now; });

  const state = detail.state ?? (link.status === 'closed' ? 'closed' : 'open');
  const expiry = expiryLabel(link.public_token_expires_at, now);
  // Waarom mailen nu niet kan, kort: de volledige uitleg staat al bovenaan.
  const MAIL_BLOCKED: Record<string, string> = {
    expired: 'Verleng de link eerst; daarna kun je hem mailen.',
    closed: 'Heropen de link eerst; daarna kun je hem mailen.',
    full: 'Via deze link zijn alle afspraken gemaakt die kunnen.',
    unavailable: 'Deze link boekt niets meer. Maak een nieuwe link.',
  };
  const mailBlocked = state !== 'open' ? (MAIL_BLOCKED[state] ?? linkStateExplanation(state, openCount))
    : openCount === 0 ? 'Zet eerst een paar momenten op de link: anders ziet de klant een lege pagina.'
    : null;

  // ── Visueel week-rooster (hergebruik TimeBlockGrid) ──────────────────────────
  //
  // Tekenen gebeurt schermvullend. In de kaart paste het rooster op 460px hoog:
  // dat is een derde van een werkdag, dus je scrolde blind op zoek naar het uur
  // waar het blok moest komen — precies de handeling waarbij je juist overzicht
  // wilt. Nu opent het rooster over de hele pagina en klapt het na "Klaar"
  // (of Escape) weer terug naar de gewone weergave.
  const [drawing, setDrawing] = useState(false);
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => startOfWeek(new Date()));
  const [weekEvents, setWeekEvents] = useState<CalendarExternalEvent[]>([]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i)), [weekAnchor]);
  const sourceColors = useMemo(() => new Map(sources.map(s => [s.id, normalizeColor(s.color)])), [sources]);
  const gridOverlay = useMemo<BookingOverlaySlot[]>(
    () => slots.filter(s => s.status !== 'cancelled').map(s => ({ id: s.id, starts_at: s.starts_at, ends_at: s.ends_at, status: s.status, removable: s.status === 'open' })),
    [slots],
  );
  // Echte afspraken van de bron als context tonen (zodat je niet dubbel plant).
  useEffect(() => {
    if (!link.source_id) { setWeekEvents([]); return; }
    let alive = true;
    const startIso = weekDays[0].toISOString();
    const endIso = addDays(weekDays[6], 1).toISOString();
    listExternalCalendarEvents(organizationId, startIso, endIso)
      .then(evs => { if (alive) setWeekEvents(evs.filter(e => e.source_id === link.source_id)); })
      .catch(() => { if (alive) setWeekEvents([]); });
    return () => { alive = false; };
  }, [organizationId, link.source_id, weekDays]);

  const weekLabel = `${new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(weekDays[0])} – ${new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(weekDays[6])}`;

  // De CSS-stand is leidend, niet de Fullscreen API: op de iPhone bestaat
  // element-fullscreen niet, en dan hoort het rooster nog steeds paginavullend
  // te openen — alleen met de browserbalk er nog omheen.
  const openDrawing = useCallback(() => {
    void enterFullscreen(document.documentElement);
    setDrawing(true);
  }, []);
  const closeDrawing = useCallback(() => {
    void leaveFullscreen();
    setDrawing(false);
  }, []);

  // Escape sluit het rooster. Bewust in de capture-fase: de agenda-component
  // die dit rooster levert luistert zelf op window en zou de toets anders eerst
  // opeten.
  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      e.preventDefault();
      e.stopPropagation();
      closeDrawing();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [drawing, closeDrawing]);

  // De browser kan volledig scherm buiten ons om verlaten (F11, de eigen knop
  // van de browser). Zonder deze synchronisatie blijft het rooster paginavullend
  // staan terwijl het scherm er niet meer naar is. En bij unmount (ander
  // tabblad, link verwijderd) mag de browser niet schermvullend blijven hangen.
  useEffect(() => {
    if (!drawing) return;
    const off = onFullscreenChange(() => {
      if (!currentFullscreenElement()) setDrawing(false);
    });
    return () => {
      off();
      void leaveFullscreen();
    };
  }, [drawing]);

  const addSlot = () => {
    if (!start || !end) return;
    const startsAt = localToIso(start);
    const endsAt = localToIso(end);
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return;
    onAddSlots([{ startsAt, endsAt }]);
    setStart(''); setEnd('');
  };

  const copyLink = () => {
    if (!token) return;
    void navigator.clipboard?.writeText(token.url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }).catch(() => setCopied(false));
  };

  const confirmRegenerate = () => {
    if (confirm('Een nieuwe link maken?\n\nDe link die de klant al heeft (ook die in een eerder verstuurde mail) werkt daarna niet meer. Afspraken die al gemaakt zijn, blijven staan.\n\nIs de link alleen verlopen? Kies dan liever "Verlengen": dan blijft dezelfde link werken.')) onRegenerate();
  };

  const sendMail = () => {
    const email = recipientEmail.trim();
    if (!email) return;
    if (!token) {
      if (!confirm(`De link zelf bewaren we niet (alleen een versleutelde verwijzing), dus er wordt een nieuwe link gemaakt en naar ${email} gestuurd.\n\nDe link die eerder is gedeeld, werkt daarna niet meer. Doorgaan?`)) return;
      onSendMail({ email, name: recipientName.trim() || undefined }, { regenerate: true });
      return;
    }
    onSendMail({ email, name: recipientName.trim() || undefined }, { regenerate: false });
  };

  if (editing) {
    return (
      <LinkForm
        mode="edit"
        sources={sources}
        videoServices={videoServices}
        clients={clients}
        busy={busy}
        initial={{
          title: link.title, sourceId: link.source_id ?? '', clientId: link.client_id ?? '',
          introText: link.intro_text, inviteMessage: link.invite_message, meetingUrl: link.meeting_url,
          maxTotalBookings: link.max_total_bookings, maxPerWeek: link.max_per_week, autoConference: link.auto_conference,
          conferenceProvider: link.conference_provider ?? 'calendar',
        }}
        onCancel={() => setEditing(false)}
        onSubmit={(p) => { onSavedPatch({ title: p.title, sourceId: p.sourceId, clientId: p.clientId, introText: p.introText, inviteMessage: p.inviteMessage, meetingUrl: p.meetingUrl, maxTotalBookings: p.maxTotalBookings, maxPerWeek: p.maxPerWeek, autoConference: p.autoConference, conferenceProvider: p.conferenceProvider }); setEditing(false); }}
      />
    );
  }

  return (
    <div className="mbk-detail">
      <div className="card mbk-detail-head-card">
        <div className="mbk-detail-head">
          <div className="mbk-detail-title">
            <div className="mbk-detail-title-row">
              <h3>{link.title}</h3>
              <BookingStateBadge state={state} />
            </div>
            <div className="muted mbk-detail-meta">
              {client ? `${client.name} · ` : ''}Agenda: {detail.source_name ?? '— (verwijderd)'}{detail.source_provider ? ` · ${PROVIDER_LABEL[detail.source_provider] ?? detail.source_provider}` : ''}
              {' · '}hooguit {link.max_total_bookings} {link.max_total_bookings === 1 ? 'afspraak' : 'afspraken'}, {link.max_per_week} per week
            </div>
            <p className={`mbk-state-line tone-${LINK_STATE_LABELS[state]?.tone ?? 'muted'}`}>{linkStateExplanation(state, openCount)}</p>
            {detail.needs_reconnect && <div className="alert alert-danger" style={{ marginTop: 8 }}>De gekoppelde agenda-verbinding is niet meer actief. Koppel het account opnieuw (Instellingen → Agenda), anders mislukken de boekingen.</div>}
          </div>
          {canWrite && (
            <div className="mbk-detail-actions">
              <Button onClick={() => setEditing(true)} disabled={busy}>Instellingen</Button>
              <Button variant={link.status === 'active' ? 'ghost' : 'primary'} disabled={busy}
                onClick={() => onSavedPatch({ status: link.status === 'active' ? 'closed' : 'active' })}>
                {link.status === 'active' ? 'Sluiten' : 'Heropenen'}
              </Button>
              <Button
                variant="danger"
                disabled={busy || activeBookingCount > 0}
                title={activeBookingCount > 0
                  ? 'Via deze link zijn afspraken gemaakt. Sluit de link liever: dan kan er niets meer geboekt worden en blijven de afspraken bewaard.'
                  : 'Deze boekingslink volledig verwijderen'}
                onClick={() => {
                  if (confirm(`Boekingslink "${link.title}" volledig verwijderen? De momenten gaan ook weg en de link werkt niet meer. Dit kan niet ongedaan worden gemaakt.`)) onDelete();
                }}
              >
                Verwijderen
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Link delen */}
      <div className="card mbk-share">
        <div className="mbk-share-head">
          <strong>Link delen</strong>
          <span className={`mbk-expiry tone-${expiry.tone}`}>{expiry.text}</span>
          {canWrite && link.has_token && (expiry.tone === 'expired' || expiry.tone === 'soon') && (
            <Button onClick={onExtend} disabled={busy} title="Dezelfde link werkt daarna weer 120 dagen">
              <RefreshCw size={14} /> Verlengen
            </Button>
          )}
        </div>
        {token ? (
          <>
            <div className="mbk-share-row">
              <Input readOnly value={token.url} onFocus={e => e.currentTarget.select()} aria-label="Boekingslink" />
              <Button onClick={copyLink} aria-live="polite">{copied ? <><Check size={14} /> Gekopieerd</> : <><Copy size={14} /> Kopieer</>}</Button>
              <Button onClick={() => window.open(token.url, '_blank', 'noopener,noreferrer')} title="Bekijk de pagina zoals de klant hem ziet">
                <ExternalLink size={14} /> Bekijk als klant
              </Button>
            </div>
            <p className="muted mbk-share-note"><ShieldCheck size={13} /> Kopieer of verstuur de link nu. Om veiligheidsredenen bewaren we hem niet leesbaar; na verversen zie je hem hier niet meer.</p>
          </>
        ) : (
          <p className="muted mbk-share-note">
            <ShieldCheck size={13} /> {!link.has_token
              ? 'Deze link heeft nog geen URL. Maak er een om hem te kunnen delen.'
              : state === 'expired'
                ? 'Met Verlengen werkt dezelfde link weer, ook die in de mail die de klant al heeft.'
                : 'We bewaren de link niet leesbaar, dus hij staat hier niet meer. Wil je hem opnieuw sturen? Dan maken we een nieuwe link, en werkt de oude niet meer.'}
          </p>
        )}
        {canWrite && (
          <div className="mbk-mail">
            <div className="mbk-mail-fields">
              <label>Naar
                <Input type="email" value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)} placeholder="klant@voorbeeld.nl" autoComplete="off" />
              </label>
              <label>Naam in de aanhef
                <Input value={recipientName} onChange={e => setRecipientName(e.target.value)} placeholder="Naam van de klant" autoComplete="off" />
              </label>
            </div>
            <div className="mbk-mail-actions">
              <Button variant="primary" disabled={busy || !recipientEmail.trim() || Boolean(mailBlocked)} onClick={sendMail} title={mailBlocked ?? undefined}>
                <Send size={14} /> {token ? 'Link mailen' : 'Nieuwe link mailen'}
              </Button>
              <Button onClick={confirmRegenerate} disabled={busy}>Nieuwe link maken</Button>
            </div>
            {mailBlocked && <p className="muted mbk-share-note">{mailBlocked}</p>}
          </div>
        )}
      </div>

      {/* Visueel week-rooster: sleep om blokken te maken — schermvullend */}
      {canWrite && link.source_id && (
        <div className="card mbk-drawcard">
          <div className="mbk-drawcard-text">
            <strong>Momenten tekenen</strong>
            <p className="muted">
              Het weekrooster opent schermvullend. Sleep de momenten waarop de klant mag kiezen;
              je eigen afspraken staan als context in beeld. Met <em>Klaar</em> (of Escape) kom je hier terug.
            </p>
          </div>
          <div className="mbk-drawcard-side">
            <span className="mbk-drawcard-count"><strong>{openCount}</strong> vrij{openCount === 1 ? ' moment' : 'e momenten'}</span>
            <Button variant="primary" onClick={openDrawing} disabled={busy}>
              <Maximize2 size={15} /> Rooster openen
            </Button>
          </div>
        </div>
      )}

      {canWrite && link.source_id && drawing && (
        <div className="mbk-draw" role="dialog" aria-modal="true" aria-label="Momenten tekenen">
          <header className="mbk-draw-bar">
            <div className="mbk-draw-title">
              <strong>Momenten tekenen</strong>
              <span className="muted">{link.title}</span>
            </div>
            <div className="mbk-draw-week">
              <Button onClick={() => setWeekAnchor(addDays(weekAnchor, -7))} disabled={busy}>← Vorige</Button>
              <span className="mbk-draw-weeklabel">{weekLabel}</span>
              <Button onClick={() => setWeekAnchor(addDays(weekAnchor, 7))} disabled={busy}>Volgende →</Button>
              <Button onClick={() => setWeekAnchor(startOfWeek(new Date()))} disabled={busy}>Deze week</Button>
            </div>
            <div className="mbk-draw-done">
              <span className="mbk-draw-count"><strong>{openCount}</strong> vrij</span>
              <Button variant="primary" onClick={closeDrawing}><Minimize2 size={15} /> Klaar</Button>
            </div>
          </header>
          <p className="mbk-draw-hint">
            Sleep over het rooster om een moment toe te voegen · klik een groen moment om het weg te halen (🔒 = al geboekt) · een moment in het verleden kan niemand boeken.
          </p>
          {/* .calendar-agenda-page-scope zodat de gedeelde .tb-scroll-hoogte de vaste
              agenda-opmaak meekrijgt; de overlay zelf zet hem daarna op vullend. */}
          <div className="calendar-agenda-page mbk-draw-grid">
            <TimeBlockGrid
              days={weekDays}
              events={weekEvents}
              tasks={[]}
              sourceColors={sourceColors}
              trackedMinutesFor={() => null}
              canWrite={canWrite}
              writeableSources={sources}
              onSelectSlot={(day, s, e) => { const iso = slotSelectionToIso(day, s, e); onAddSlots([{ startsAt: iso.startsAt, endsAt: iso.endsAt }]); }}
              onEditTask={() => {}}
              onOpenEvent={() => {}}
              onMoveEvent={() => {}}
              bookingMode
              bookingSlots={gridOverlay}
              onRemoveBookingSlot={(id) => onRemoveSlot(id)}
              readOnlyEvents
            />
          </div>
        </div>
      )}

      {/* Momenten (lijst + handmatige invoer als alternatief) */}
      <div className="card mbk-section">
        <strong>Momenten ({openCount} vrij)</strong>
        {canWrite && (
          <div className="mbk-slotform">
            <label>Van<Input type="datetime-local" min={nowLocalInput()} value={start} onChange={e => setStart(e.target.value)} /></label>
            <label>Tot<Input type="datetime-local" min={start || nowLocalInput()} value={end} onChange={e => setEnd(e.target.value)} /></label>
            <Button variant="primary" onClick={addSlot} disabled={busy || !start || !end}>Moment toevoegen</Button>
          </div>
        )}
        {upcomingSlots.length === 0 && <p className="muted">Nog geen momenten die nog moeten komen. Open hierboven het rooster en teken ze, of voeg ze hier handmatig toe.</p>}
        <div className="mbk-rows">
          {upcomingSlots.map(s => (
            <div key={s.id} className="mbk-row">
              <span>{fmtMoment(s.starts_at, s.ends_at)}</span>
              <span className="mbk-row-side">
                <span className={`mbk-badge tone-${SLOT_STATUS_LABELS[s.status]?.tone ?? 'muted'}`}>{SLOT_STATUS_LABELS[s.status]?.label ?? s.status}</span>
                {canWrite && s.status === 'open' && <Button variant="danger" onClick={() => onRemoveSlot(s.id)} disabled={busy}>Weghalen</Button>}
              </span>
            </div>
          ))}
        </div>
        {pastSlots.length > 0 && (
          <button type="button" className="mbk-toggle" onClick={() => setShowPast(v => !v)} aria-expanded={showPast}>
            {showPast ? 'Verberg' : 'Toon'} {pastSlots.length} voorbije of vervallen {pastSlots.length === 1 ? 'moment' : 'momenten'}
          </button>
        )}
        {showPast && <div className="mbk-rows is-past">
          {pastSlots.map(s => (
            <div key={s.id} className="mbk-row">
              <span>{fmtMoment(s.starts_at, s.ends_at)}</span>
              <span className="mbk-row-side">
                <span className={`mbk-badge tone-${SLOT_STATUS_LABELS[s.status]?.tone ?? 'muted'}`}>{Date.parse(s.ends_at) <= now && s.status === 'open' ? 'Voorbij' : (SLOT_STATUS_LABELS[s.status]?.label ?? s.status)}</span>
                {canWrite && (s.status === 'open' || s.status === 'cancelled') && <Button variant="danger" onClick={() => onRemoveSlot(s.id)} disabled={busy}>Weghalen</Button>}
              </span>
            </div>
          ))}
        </div>}
      </div>

      {/* Afspraken */}
      <div className="card mbk-section">
        <strong>Afspraken</strong>
        {visibleBookings.length === 0 && <p className="muted">Nog geen afspraken via deze link.</p>}
        {upcomingBookings.length > 0 && <BookingRows bookings={upcomingBookings} slotById={slotById} canWrite={canWrite} busy={busy} onCancel={onCancelBooking} />}
        {pastBookings.length > 0 && <>
          <div className="mbk-subhead muted">Geweest</div>
          <BookingRows bookings={pastBookings} slotById={slotById} canWrite={false} busy={busy} onCancel={onCancelBooking} />
        </>}
      </div>
    </div>
  );
}

function BookingRows({ bookings, slotById, canWrite, busy, onCancel }: {
  bookings: MeetingBooking[];
  slotById: Map<string, MeetingBookingSlot>;
  canWrite: boolean;
  busy: boolean;
  onCancel: (bookingId: UUID) => void;
}) {
  return <div className="mbk-rows">
    {bookings.map(b => {
      const slot = slotById.get(b.slot_id);
      return (
        <div key={b.id} className="mbk-row">
          <div className="mbk-row-main">
            <div className="mbk-row-title">{b.booked_name || b.booked_email}</div>
            <div className="muted mbk-row-sub">
              {slot ? `${fmtDayLong(slot.starts_at)} · ${fmtTime(slot.starts_at)}–${fmtTime(slot.ends_at)}` : '—'} · {b.booked_email}
            </div>
          </div>
          <span className="mbk-row-side">
            <span className={`mbk-badge tone-${b.status === 'confirmed' ? 'success' : b.status === 'pending' ? 'warning' : 'muted'}`}>{BOOKING_STATUS_LABELS[b.status] ?? b.status}</span>
            {canWrite && b.status === 'confirmed' && <Button variant="danger" disabled={busy} onClick={() => {
              if (confirm(`De afspraak met ${b.booked_name || b.booked_email} annuleren?\n\nHij wordt uit de agenda gehaald en het moment komt weer vrij. Laat de klant zelf weten dat de afspraak niet doorgaat.`)) onCancel(b.id);
            }}>Annuleren</Button>}
          </span>
        </div>
      );
    })}
  </div>;
}
