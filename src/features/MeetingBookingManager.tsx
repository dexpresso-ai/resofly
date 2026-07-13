import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppData, CalendarExternalEvent, CalendarSource, MeetingBooking, MeetingBookingLinkListItem, MeetingBookingSlot, UUID } from '../types';
import { Button, Input, Textarea, Select, normalizeColor } from '../components/Ui';
import { listExternalCalendarEvents, loadCalendarIntegrations } from '../lib/calendar-api';
import { addDays, startOfWeek } from '../lib/dates';
import { TimeBlockGrid, slotSelectionToIso, type BookingOverlaySlot } from './CalendarPage';
import {
  addBookingSlots,
  cancelBooking,
  createBookingLink,
  deleteBookingLink,
  getBookingLink,
  listBookingLinks,
  regenerateBookingToken,
  removeBookingSlot,
  sendBookingLinkMail,
  updateBookingLink,
  type BookingLinkDetail,
} from '../lib/meetingBookingApi';

function fmt(dt: string): string {
  return new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(dt));
}
function fmtDate(dt: string): string {
  return new Intl.DateTimeFormat('nl-NL', { dateStyle: 'full', timeZone: 'Europe/Amsterdam' }).format(new Date(dt));
}
/** datetime-local waarde (lokale wandkloktijd) → ISO string. */
function localToIso(local: string): string {
  return new Date(local).toISOString();
}

const PROVIDER_LABEL: Record<string, string> = { native: 'ResoFly-agenda', google: 'Google', microsoft: 'Microsoft' };

export function MeetingBookingManager({ organizationId, data, canWrite }: { organizationId: UUID; currentUserId: UUID; data: AppData; canWrite: boolean }) {
  const [links, setLinks] = useState<MeetingBookingLinkListItem[]>([]);
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [selectedId, setSelectedId] = useState<UUID | null>(null);
  const [detail, setDetail] = useState<BookingLinkDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Plaintext tokens leven alleen in het geheugen (server bewaart enkel de hash).
  const [tokenByLink, setTokenByLink] = useState<Record<string, { token: string; url: string }>>({});
  const [creating, setCreating] = useState(false);

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
        if (rows.length && !selectedId) setSelectedId(rows[0].id);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Laden mislukt.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

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

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 20, alignItems: 'start' }}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong>Boekingslinks</strong>
          {canWrite && <Button variant="primary" onClick={() => { setCreating(true); setSelectedId(null); }}>Nieuw</Button>}
        </div>
        {loading && <p className="muted">Laden…</p>}
        {!loading && links.length === 0 && <p className="muted">Nog geen boekingslinks. Maak er een aan om een klant zelf een moment te laten kiezen.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {links.map(l => (
            <button
              key={l.id}
              className={`nav-item ${selectedId === l.id && !creating ? 'active' : ''}`}
              style={{ textAlign: 'left', padding: '8px 10px' }}
              onClick={() => { setCreating(false); setSelectedId(l.id); }}
            >
              <div style={{ fontWeight: 600 }}>{l.title}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {l.client_name || 'Geen klant'} · {l.booking_count}/{l.max_total_bookings} geboekt
                {l.status === 'closed' ? ' · gesloten' : ''}
                {l.needs_reconnect ? ' · ⚠ koppeling' : ''}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div>
        {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
        {notice && <div className="alert" style={{ marginBottom: 12 }}>{notice}</div>}

        {creating && (
          <LinkForm
            mode="create"
            sources={writableSources}
            clients={data.clients.map(c => ({ id: c.id, label: c.name }))}
            busy={busy}
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
              });
              setTokenByLink(prev => ({ ...prev, [res.link.id]: { token: res.token, url: res.booking_url } }));
              await reloadLinks();
              setCreating(false);
              setSelectedId(res.link.id);
            }, 'Boekingslink aangemaakt. Kopieer of verstuur de link hieronder.')}
          />
        )}

        {!creating && detail && (
          <LinkDetail
            key={detail.link.id}
            detail={detail}
            organizationId={organizationId}
            sources={writableSources}
            clients={data.clients.map(c => ({ id: c.id, label: c.name }))}
            clientEmail={detail.link.client_id ? (clientsById.get(detail.link.client_id)?.email ?? null) : null}
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
              await reloadDetail(detail.link.id);
            }, 'Nieuwe link gegenereerd.')}
            onSendMail={(recipient) => run(async () => {
              const tok = tokenByLink[detail.link.id];
              if (!tok) throw new Error('Vernieuw eerst de link om hem te kunnen versturen.');
              await sendBookingLinkMail(organizationId, detail.link.id, tok.token, recipient);
            }, 'Boekingsmail verstuurd naar de klant.')}
            onAddSlots={async (slots) => {
              let warn = '';
              await run(async () => {
                const res = await addBookingSlots(organizationId, detail.link.id, slots);
                if (res.warnings.length) warn = `Let op: ${res.warnings.length} blok(ken) overlappen met bestaande afspraken.`;
                await reloadDetail(detail.link.id);
              }, 'Blokken toegevoegd.');
              if (warn) setNotice(warn);
            }}
            onRemoveSlot={(slotId) => run(async () => {
              await removeBookingSlot(organizationId, detail.link.id, slotId);
              await reloadDetail(detail.link.id);
            })}
            onCancelBooking={(bookingId) => run(async () => {
              await cancelBooking(organizationId, bookingId);
              await Promise.all([reloadDetail(detail.link.id), reloadLinks()]);
            }, 'Boeking geannuleerd; het blok staat weer open.')}
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
}

function LinkForm({ mode, sources, clients, busy, onSubmit, onCancel, initial }: {
  mode: 'create' | 'edit';
  sources: CalendarSource[];
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
  const [autoConference, setAutoConference] = useState(initial?.autoConference ?? true);

  const selectedProvider = sources.find(s => s.id === sourceId)?.provider ?? null;
  const isExternal = selectedProvider === 'google' || selectedProvider === 'microsoft';
  const conferenceLabel = selectedProvider === 'microsoft' ? 'Teams-vergadering' : 'Google Meet';

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
      autoConference,
    });
  };

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <strong>{mode === 'create' ? 'Nieuwe boekingslink' : 'Instellingen'}</strong>
      <label>Titel<Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Afspraak inplannen" /></label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label>Agenda
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label>Max. aantal boekingen totaal<Input type="number" min={1} value={maxTotal} onChange={e => setMaxTotal(e.target.value)} /></label>
        <label>Max. aantal per week<Input type="number" min={1} value={maxWeek} onChange={e => setMaxWeek(e.target.value)} /></label>
      </div>
      <label>Intro-tekst op de boekingspagina<Textarea value={introText} onChange={e => setIntroText(e.target.value)} rows={2} placeholder="Kies hieronder een moment dat jou uitkomt." /></label>
      <label>Begeleidende tekst bij de uitnodiging<Textarea value={inviteMessage} onChange={e => setInviteMessage(e.target.value)} rows={2} placeholder="Fijn dat we een moment inplannen. Tot dan!" /></label>
      {isExternal && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={autoConference} onChange={e => setAutoConference(e.target.checked)} style={{ marginTop: 3 }} />
          <span>Automatisch een {conferenceLabel} aanmaken bij het boeken.<br />
            <span className="muted" style={{ fontSize: 12 }}>De klant krijgt de deelnamelink in de agenda-uitnodiging. Vul je hieronder een eigen vaste link in, dan wordt die gebruikt in plaats hiervan.</span>
          </span>
        </label>
      )}
      <label>Vaste videocall-link (optioneel)<Input value={meetingUrl} onChange={e => setMeetingUrl(e.target.value)} placeholder="https://meet.google.com/… of Teams/Zoom" /></label>
      {sources.length === 0 && <p className="muted">Er is nog geen schrijfbare agenda beschikbaar. Koppel of maak eerst een agenda.</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="primary" onClick={submit} disabled={busy || !sourceId}>{mode === 'create' ? 'Aanmaken' : 'Opslaan'}</Button>
        <Button onClick={onCancel} disabled={busy}>Annuleren</Button>
      </div>
    </div>
  );
}

function LinkDetail({ detail, organizationId, sources, clients, clientEmail, token, busy, canWrite, onSavedPatch, onRegenerate, onSendMail, onAddSlots, onRemoveSlot, onCancelBooking, onDelete }: {
  detail: BookingLinkDetail;
  organizationId: UUID;
  sources: CalendarSource[];
  clients: Array<{ id: UUID; label: string }>;
  clientEmail: string | null;
  token: { token: string; url: string } | null;
  busy: boolean;
  canWrite: boolean;
  onSavedPatch: (patch: Record<string, unknown>) => void;
  onRegenerate: () => void;
  onSendMail: (recipient?: { email?: string; name?: string }) => void;
  onAddSlots: (slots: Array<{ startsAt: string; endsAt: string }>) => void;
  onRemoveSlot: (slotId: UUID) => void;
  onCancelBooking: (bookingId: UUID) => void;
  onDelete: () => void;
}) {
  const link = detail.link;
  const [editing, setEditing] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');

  const slots = detail.slots as MeetingBookingSlot[];
  const bookings = detail.bookings as MeetingBooking[];
  const openCount = slots.filter(s => s.status === 'open').length;
  // "Niet geboekt" = geen lopende of bevestigde boekingen; alleen dan mag de hele link weg.
  const activeBookingCount = bookings.filter(b => b.status === 'pending' || b.status === 'confirmed').length;

  // ── Visueel week-rooster (hergebruik TimeBlockGrid) ──────────────────────────
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

  const expired = link.public_token_expires_at ? new Date(link.public_token_expires_at).getTime() < Date.now() : true;

  const addSlot = () => {
    if (!start || !end) return;
    const startsAt = localToIso(start);
    const endsAt = localToIso(end);
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) return;
    onAddSlots([{ startsAt, endsAt }]);
    setStart(''); setEnd('');
  };

  if (editing) {
    return (
      <LinkForm
        mode="edit"
        sources={sources}
        clients={clients}
        busy={busy}
        initial={{
          title: link.title, sourceId: link.source_id ?? '', clientId: link.client_id ?? '',
          introText: link.intro_text, inviteMessage: link.invite_message, meetingUrl: link.meeting_url,
          maxTotalBookings: link.max_total_bookings, maxPerWeek: link.max_per_week, autoConference: link.auto_conference,
        }}
        onCancel={() => setEditing(false)}
        onSubmit={(p) => { onSavedPatch({ title: p.title, sourceId: p.sourceId, clientId: p.clientId, introText: p.introText, inviteMessage: p.inviteMessage, meetingUrl: p.meetingUrl, maxTotalBookings: p.maxTotalBookings, maxPerWeek: p.maxPerWeek, autoConference: p.autoConference }); setEditing(false); }}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <h3 style={{ margin: '0 0 4px' }}>{link.title}</h3>
            <div className="muted" style={{ fontSize: 13 }}>
              Agenda: {detail.source_name ?? '— (verwijderd)'}{detail.source_provider ? ` · ${PROVIDER_LABEL[detail.source_provider] ?? detail.source_provider}` : ''}
              {' · '}Max {link.max_total_bookings} totaal, {link.max_per_week}/week
              {link.status === 'closed' ? ' · gesloten' : ''}
            </div>
            {detail.needs_reconnect && <div className="alert alert-danger" style={{ marginTop: 8 }}>De gekoppelde agenda-verbinding is niet meer actief. Koppel het account opnieuw voordat je boekingen laat plaatsvinden.</div>}
          </div>
          {canWrite && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Button onClick={() => setEditing(true)} disabled={busy}>Instellingen</Button>
              <Button variant={link.status === 'active' ? 'ghost' : 'primary'} disabled={busy}
                onClick={() => onSavedPatch({ status: link.status === 'active' ? 'closed' : 'active' })}>
                {link.status === 'active' ? 'Sluiten' : 'Heropenen'}
              </Button>
              <Button
                variant="danger"
                disabled={busy || activeBookingCount > 0}
                title={activeBookingCount > 0
                  ? 'Er staan nog boekingen op deze link. Annuleer die eerst om de link te kunnen verwijderen.'
                  : 'Deze boekingslink volledig verwijderen'}
                onClick={() => {
                  if (confirm(`Boekingslink "${link.title}" volledig verwijderen? De beschikbare blokken worden ook verwijderd. Dit kan niet ongedaan worden gemaakt.`)) onDelete();
                }}
              >
                Verwijderen
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Link delen */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <strong>Boekingslink delen</strong>
        {token ? (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Input readOnly value={token.url} onFocus={e => e.currentTarget.select()} style={{ flex: 1 }} />
              <Button onClick={() => navigator.clipboard?.writeText(token.url)}>Kopieer</Button>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>Bewaar of verstuur de link nu — om veiligheidsredenen tonen we hem hierna niet meer (alleen een versleutelde verwijzing wordt opgeslagen).</p>
            {canWrite && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Button variant="primary" disabled={busy} onClick={() => onSendMail(clientEmail ? { email: clientEmail } : undefined)}>
                  {clientEmail ? `Mailen naar ${clientEmail}` : 'Mailen naar klant'}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {expired ? 'Er is nog geen geldige link. ' : 'De link is aangemaakt maar wordt niet meer getoond. '}
              Genereer een (nieuwe) link om hem te kunnen kopiëren of mailen.
            </p>
            {canWrite && <div><Button variant="primary" onClick={onRegenerate} disabled={busy}>Link (opnieuw) genereren</Button></div>}
          </>
        )}
      </div>

      {/* Visueel week-rooster: sleep om blokken te maken */}
      {canWrite && link.source_id && (
        <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <strong>Blokken tekenen</strong>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button onClick={() => setWeekAnchor(addDays(weekAnchor, -7))} disabled={busy}>← Vorige</Button>
              <span className="muted" style={{ fontSize: 13 }}>{weekLabel}</span>
              <Button onClick={() => setWeekAnchor(addDays(weekAnchor, 7))} disabled={busy}>Volgende →</Button>
            </div>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>Sleep over het rooster om een blok toe te voegen · klik een groen blok om het te verwijderen (🔒 = al geboekt). Je eigen afspraken staan als context in beeld.</p>
          {/* .calendar-agenda-page-scope zodat de gedeelde .tb-scroll-hoogte netjes binnen dit vak scrollt. */}
          <div className="calendar-agenda-page" style={{ height: 460, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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

      {/* Beschikbare blokken (lijst + handmatige invoer als alternatief) */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <strong>Beschikbare blokken ({openCount} open)</strong>
        {canWrite && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label>Van<Input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></label>
            <label>Tot<Input type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} /></label>
            <Button variant="primary" onClick={addSlot} disabled={busy || !start || !end}>Blok toevoegen</Button>
          </div>
        )}
        {slots.length === 0 && <p className="muted">Nog geen blokken. Teken hierboven op het rooster of voeg handmatig tijden toe waaruit de klant kan kiezen.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {slots.map(s => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
              <span>{fmt(s.starts_at)} – {new Intl.DateTimeFormat('nl-NL', { timeStyle: 'short', timeZone: 'Europe/Amsterdam' }).format(new Date(s.ends_at))}</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <SlotBadge status={s.status} />
                {canWrite && (s.status === 'open' || s.status === 'cancelled') && <Button variant="danger" onClick={() => onRemoveSlot(s.id)} disabled={busy}>Verwijder</Button>}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Boekingen */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <strong>Boekingen</strong>
        {bookings.filter(b => b.status !== 'failed').length === 0 && <p className="muted">Nog geen boekingen.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bookings.filter(b => b.status !== 'failed').map(b => {
            const slot = slots.find(s => s.id === b.slot_id);
            return (
              <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{b.booked_name || b.booked_email}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {slot ? fmtDate(slot.starts_at) + ' · ' + fmt(slot.starts_at).split(' ').slice(-1) : '—'} · {b.booked_email} · {b.status}
                  </div>
                </div>
                {canWrite && b.status === 'confirmed' && <Button variant="danger" disabled={busy} onClick={() => onCancelBooking(b.id)}>Annuleren</Button>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SlotBadge({ status }: { status: MeetingBookingSlot['status'] }) {
  const map: Record<string, { label: string; color: string }> = {
    open: { label: 'Open', color: '#3ba55d' },
    pending: { label: 'Bezig…', color: '#d9a441' },
    booked: { label: 'Geboekt', color: '#5865f2' },
    cancelled: { label: 'Geannuleerd', color: '#888' },
  };
  const s = map[status] ?? map.open;
  return <span style={{ fontSize: 12, color: s.color, fontWeight: 600 }}>{s.label}</span>;
}
