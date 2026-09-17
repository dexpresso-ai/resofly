import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ExternalLink, Inbox, Mail, MailOpen, Reply, RotateCcw, Search, SlidersHorizontal, SquarePen, Ticket as TicketIcon, X } from 'lucide-react';
import type { AppData, Client, ClientEmail, ClientEmailSearchHit, ClientEmailThreadOverview, Ticket } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { DetailTabs } from '../components/DetailTabs';
import { RichTextEditor } from '../components/RichTextEditor';
import { InboundInboxTab } from '../components/InboundInbox';
import { TicketTimeline } from '../components/TicketTimeline';
import { ClientEmailMessageCard, formatEmailDateTime } from '../components/ClientEmailMessage';
import {
  deleteClientEmail, loadClientEmailReadIds, loadClientEmailThreadOverview, loadClientEmailThreadOverviewByIds, loadClientEmailsForThread,
  loadMySenderIdentity, loadSendingDomains, markClientEmailsRead, markTicketRead, searchClientEmails,
} from '../lib/repository';
import { resolveEffectiveSender, sendClientEmail, type EffectiveSender } from '../services/mailService';
import {
  DATE_PERIOD_OPTIONS, NO_CLIENT, countUnread, emailConversation, filterConversations, initials, listTime, matchesWords, periodRange,
  queryWords, replySubject, searchSnippet, sortConversations,
  type CommunicationTab, type Conversation, type ConversationFilter, type ConversationKind, type DatePeriod, type TicketConversation,
} from '../lib/communication';
import { groupNotesByTicket, ticketConversation, ticketPriorityLabel, ticketStatusLabel } from '../lib/tickets';
import { dateNL } from '../lib/format';
import { useNarrowViewport } from '../lib/useNarrowViewport';
import { NotMigratedError } from '../lib/postgrestErrors';

/**
 * Waar de pagina moet openen als iemand er via een melding, de beslislijst of
 * een ander scherm naartoe springt. `key` maakt elke sprong uniek, zodat twee
 * keer dezelfde melding ook twee keer werkt (zelfde patroon als settingsNav).
 */
export interface CommunicationFocus {
  key: number;
  tab?: CommunicationTab;
  threadId?: string | null;
  ticketId?: string | null;
}

/**
 * Berichten: alle klantcommunicatie van de organisatie op één pagina.
 *
 * Links de gesprekken van álle klanten — mailwisselingen én tickets met hun
 * tijdlijn, door elkaar op laatste activiteit — met ongelezen-teller; rechts
 * het gekozen gesprek met een antwoordknop (mail) of de tijdlijn (ticket).
 * Het derde tabblad is de opvangbak: post die binnenkwam maar nog niet aan een
 * klant hangt.
 *
 * Zoeken kijkt lokaal in klant, onderwerp, afzender en preview, en bij een
 * ticket in élke notitie; voor mail vraagt de pagina daarnaast de database om
 * treffers in oudere berichten (rpc search_client_emails), zodat een woord uit
 * een mail van drie weken terug het gesprek ook vindt. Filteren kan op soort,
 * klant en periode.
 *
 * Het tabblad Communicatie per klant blijft precies zoals het was; deze pagina
 * leest dezelfde tabellen en verstuurt via dezelfde mailfunctie.
 *
 * Op een telefoon is het één venster tegelijk (lijst óf gesprek), net als de
 * teamchat: `.is-single` op de shell, React kiest welk deel er staat.
 */
export function CommunicationPage({
  data,
  organizationId,
  canWrite,
  inboxCount,
  activity = 0,
  focus = null,
  ticketUnreadIds,
  currentUserId,
  canReadTickets,
  canWriteTickets,
  onUnreadChanged,
  onInboxChanged,
  onTicketUnreadChanged,
  onOpenClient,
  onOpenTicket,
  onChanged,
}: {
  data: AppData;
  organizationId: string;
  canWrite: boolean;
  /** Aantal niet-gekoppelde (persoonlijke) berichten in de opvangbak — bijgehouden door de app-shell. */
  inboxCount: number;
  /** Loopt op bij elk live-event (nieuwe mail, opvangbak gewijzigd); de lijst laadt dan opnieuw. */
  activity?: number;
  focus?: CommunicationFocus | null;
  /** Tickets met klant-activiteit die deze gebruiker nog niet gezien heeft (view ticket_unread). */
  ticketUnreadIds: Set<string>;
  currentUserId: string | null;
  /** Module Tickets staat open voor dit teamlid: tickets staan dan tussen de gesprekken. */
  canReadTickets: boolean;
  /** Mag er op de tijdlijn van een ticket geschreven worden? */
  canWriteTickets: boolean;
  /** Ongelezen-tellers (badge in het menu, klantenlijst) opnieuw laten tellen. */
  onUnreadChanged: () => void;
  /** Teller van de opvangbak opnieuw laten tellen. */
  onInboxChanged: () => void;
  /** De ticket-badge opnieuw laten tellen (een ticket is zojuist geopend = gelezen). */
  onTicketUnreadChanged: () => void;
  onOpenClient: (clientId: string) => void;
  /** Het bewerkvenster van een ticket openen (status, prioriteit, bijlagen). */
  onOpenTicket: (ticket: Ticket) => void;
  /** Werkruimte-data verversen (koppelen kan een contactpersoon aanmaken; een notitie hoort in AppData). */
  onChanged: () => void;
}) {
  const narrow = useNarrowViewport();
  const [tab, setTab] = useState<CommunicationTab>('all');
  const [threads, setThreads] = useState<ClientEmailThreadOverview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // De view bestaat in deze omgeving nog niet: de frontend staat er, de
  // migratie is nog niet gedraaid. Geen fout om rood van te kleuren.
  const [notMigrated, setNotMigrated] = useState(false);
  const [query, setQuery] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'' | ConversationKind>('');
  const [period, setPeriod] = useState<DatePeriod>('');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  /** Op een smal scherm staan de filters achter een knop; op een breed scherm staan ze er altijd (CSS). */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  /** Op een smal scherm: staat het gesprek (of het nieuwe bericht) in beeld, of de lijst? */
  const [detailOpen, setDetailOpen] = useState(false);
  /** Springt na een verzonden nieuw bericht naar dat gesprek zodra de lijst opnieuw geladen is. */
  const pendingSelectRef = useRef<string | null>(null);
  /** Treffers van de server (zoeken door alle mail), per gesprek het nieuwste bericht dat raak was. */
  const [deepHits, setDeepHits] = useState<Map<string, ClientEmailSearchHit>>(new Map());
  /** Gesprekken die de server vond maar die niet in de eerste 400 van de lijst zitten. */
  const [deepThreads, setDeepThreads] = useState<ClientEmailThreadOverview[]>([]);
  const [deepBusy, setDeepBusy] = useState(false);
  const threadsRef = useRef(threads); threadsRef.current = threads;

  const reload = useCallback(async () => {
    const rows = await loadClientEmailThreadOverview(organizationId);
    setThreads(rows);
    setLoaded(true);
    setLoadError(null);
    setNotMigrated(false);
    if (pendingSelectRef.current && rows.some(t => `email:${t.id}` === pendingSelectRef.current)) {
      setSelectedKey(pendingSelectRef.current);
      pendingSelectRef.current = null;
    }
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setSelectedKey(null);
    setComposing(false);
    setDetailOpen(false);
    setNotMigrated(false);
    setDeepHits(new Map());
    setDeepThreads([]);
    loadClientEmailThreadOverview(organizationId)
      .then(rows => { if (!cancelled) { setThreads(rows); setLoaded(true); } })
      .catch(err => {
        if (cancelled) return;
        setLoaded(true);
        if (err instanceof NotMigratedError) { setNotMigrated(true); setThreads([]); return; }
        setLoadError(err instanceof Error ? err.message : 'Berichten laden mislukt.');
      });
    return () => { cancelled = true; };
  }, [organizationId]);

  // Live: een nieuw inkomend bericht of een gewijzigde opvangbak → lijst
  // opnieuw laden. Stil bij een fout; de gebruiker kan altijd verversen.
  const activityRef = useRef(activity);
  useEffect(() => {
    if (activity === activityRef.current) return;
    activityRef.current = activity;
    reload().catch(() => { /* best effort */ });
  }, [activity, reload]);

  // Sprong van buitenaf: melding "nieuw bericht" opent het gesprek, de
  // beslislijst opent de opvangbak, een ticketmelding het ticket.
  const focusKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focus.key === focusKeyRef.current) return;
    focusKeyRef.current = focus.key;
    if (focus.tab) setTab(focus.tab);
    const key = focus.threadId ? `email:${focus.threadId}` : focus.ticketId ? `ticket:${focus.ticketId}` : null;
    if (key) {
      setComposing(false);
      setSelectedKey(key);
      setDetailOpen(true);
      if (!focus.tab) setTab('all');
      // Het gesprek kan net zijn ontstaan (eerste bericht van een klant): dan
      // staat het nog niet in de lijst. Eén keer opnieuw laden lost dat op.
      if (focus.threadId && !threads.some(t => t.id === focus.threadId)) reload().catch(() => { /* best effort */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  // Zoeken door álle mail: de lijst kent per gesprek alleen het laatste
  // bericht, de database kent ze allemaal. Even wachten tot het typen stopt,
  // dan de treffers ophalen — en de gesprekken die daardoor nieuw in beeld
  // komen (buiten de eerste 400) erbij laden. Mislukt het, dan blijft het
  // lokale zoeken gewoon werken.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || kindFilter === 'ticket' || notMigrated || !loaded) {
      setDeepHits(new Map()); setDeepThreads([]); setDeepBusy(false);
      return;
    }
    let cancelled = false;
    setDeepBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const hits = await searchClientEmails(organizationId, q);
        if (cancelled) return;
        const byThread = new Map<string, ClientEmailSearchHit>();
        for (const hit of hits) if (!byThread.has(hit.thread_id)) byThread.set(hit.thread_id, hit);
        const known = new Set(threadsRef.current.map(t => t.id));
        const missing = [...byThread.keys()].filter(id => !known.has(id));
        const extra = missing.length > 0 ? await loadClientEmailThreadOverviewByIds(organizationId, missing) : [];
        if (cancelled) return;
        setDeepHits(byThread);
        setDeepThreads(extra);
      } catch {
        if (!cancelled) { setDeepHits(new Map()); setDeepThreads([]); }
      } finally {
        if (!cancelled) setDeepBusy(false);
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, kindFilter, organizationId, notMigrated, loaded]);

  const clientById = useMemo(() => new Map(data.clients.map(c => [c.id, c])), [data.clients]);
  const notesByTicket = useMemo(() => groupNotesByTicket(data.ticketNotes), [data.ticketNotes]);

  // Mail én tickets als één lijst, nieuwste activiteit bovenaan.
  const conversations = useMemo(() => {
    const seen = new Set<string>();
    const list: Conversation[] = [];
    for (const thread of [...threads, ...deepThreads]) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      list.push(emailConversation(thread));
    }
    if (canReadTickets) {
      for (const ticket of data.tickets) {
        list.push(ticketConversation(ticket, notesByTicket.get(ticket.id) ?? [], {
          clientName: ticket.client_id ? (clientById.get(ticket.client_id)?.name ?? 'Onbekende klant') : null,
          unread: ticketUnreadIds.has(ticket.id),
          currentUserId,
        }));
      }
    }
    return sortConversations(list);
  }, [threads, deepThreads, data.tickets, notesByTicket, clientById, ticketUnreadIds, currentUserId, canReadTickets]);

  const range = useMemo(
    () => (period === 'custom' ? { from: customFrom || null, to: customTo || null } : periodRange(period)),
    [period, customFrom, customTo],
  );
  const matchKeys = useMemo(() => new Set([...deepHits.keys()].map(id => `email:${id}`)), [deepHits]);
  const words = useMemo(() => queryWords(query), [query]);

  const visible = useMemo(() => {
    const filter: ConversationFilter = { tab, query, clientId: clientFilter, kind: kindFilter, from: range.from, to: range.to, matchKeys };
    const list = filterConversations(conversations, filter);
    // Het geopende gesprek blijft op het tabblad Ongelezen staan nadat het
    // (door het openen) gelezen is — anders verdwijnt het onder je muis vandaan.
    if (tab === 'unread' && selectedKey && !list.some(c => c.key === selectedKey)) {
      const kept = filterConversations(conversations.filter(c => c.key === selectedKey), { ...filter, tab: 'all' });
      if (kept.length > 0) return conversations.filter(c => c.key === selectedKey || list.some(l => l.key === c.key));
    }
    return list;
  }, [conversations, tab, query, clientFilter, kindFilter, range, matchKeys, selectedKey]);

  const unreadTotal = useMemo(() => countUnread(conversations), [conversations]);
  const ticketCount = canReadTickets ? data.tickets.length : 0;
  const selected = selectedKey ? conversations.find(c => c.key === selectedKey) ?? null : null;

  // Alleen klanten die daadwerkelijk een gesprek of ticket hebben — een filter
  // met tweehonderd klanten waarvan er acht mailen, is geen filter.
  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of conversations) if (item.clientId && !seen.has(item.clientId)) seen.set(item.clientId, item.clientName);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'nl'));
  }, [conversations]);
  const hasNoClient = useMemo(() => conversations.some(item => item.clientId === null), [conversations]);

  /**
   * De regel "Gevonden: …" onder een gesprek: alleen als de treffer niet al
   * zichtbaar is in klant, onderwerp of preview. Bij mail komt het fragment
   * uit het bericht dat de server vond, bij een ticket uit de notities.
   */
  function foundLine(item: Conversation): string | null {
    if (words.length === 0) return null;
    if (matchesWords(`${item.clientName}\n${item.subject}\n${item.preview}`, words)) return null;
    if (item.kind === 'email') {
      const hit = deepHits.get(item.id);
      if (hit) return searchSnippet(hit.excerpt || hit.subject, words) ?? `Gevonden in een bericht van ${dateNL(hit.created_at)}`;
    }
    return searchSnippet(item.searchText, words);
  }

  function selectConversation(key: string) {
    setComposing(false);
    setSelectedKey(key);
    setDetailOpen(true);
  }

  function startCompose() {
    setSelectedKey(null);
    setComposing(true);
    setDetailOpen(true);
    if (tab === 'inbox') setTab('all');
  }

  function closeDetail() {
    setComposing(false);
    setDetailOpen(false);
  }

  /** Het gesprek is geopend en dus gelezen: teller in de lijst meteen op nul. */
  function markThreadReadLocally(threadId: string) {
    setThreads(prev => prev.map(t => (t.id === threadId ? { ...t, unread_count: 0 } : t)));
    setDeepThreads(prev => prev.map(t => (t.id === threadId ? { ...t, unread_count: 0 } : t)));
  }

  async function afterSent(threadId: string) {
    pendingSelectRef.current = `email:${threadId}`;
    setComposing(false);
    await reload();
  }

  function resetFilters() {
    setQuery(''); setClientFilter(''); setKindFilter(''); setPeriod(''); setCustomFrom(''); setCustomTo('');
  }

  const singlePane = narrow;
  const showList = !singlePane || !detailOpen;
  const showDetail = !singlePane || detailOpen;
  const filterCount = (kindFilter ? 1 : 0) + (clientFilter ? 1 : 0) + (period ? 1 : 0);
  const filtersActive = query.trim().length > 0 || filterCount > 0;
  // Op de telefoon krijgt een geopend gesprek het hele scherm: kop en
  // tabbladen gaan weg (CSS), de terugpijl in de gesprekskop brengt je terug.
  const detailFillsScreen = singlePane && detailOpen && tab !== 'inbox';
  const ready = loaded && !loadError && !notMigrated;
  const headSub = ready
    ? [
        `${threads.length} gesprek${threads.length === 1 ? '' : 'ken'}`,
        canReadTickets ? `${ticketCount} ticket${ticketCount === 1 ? '' : 's'}` : null,
        `${unreadTotal} ongelezen`,
        `${inboxCount} niet gekoppeld`,
      ].filter(Boolean).join(' · ')
    : (canReadTickets ? 'Alle klantmail en tickets op één plek' : 'Alle klantmail op één plek');

  return <div className={`comm-page${detailFillsScreen ? ' is-detail' : ''}`}>
    <div className="comm-head">
      <div className="comm-head-text">
        <p className="eyebrow">Communicatie</p>
        <h2>Berichten</h2>
        <span className="comm-head-sub">{headSub}</span>
      </div>
      <Button variant="primary" onClick={startCompose} disabled={!canWrite} title="Nieuw bericht aan een klant">
        <SquarePen size={15} /> <span className="btn-label">Nieuw bericht</span>
      </Button>
    </div>

    <DetailTabs
      tabs={[
        { id: 'all', label: 'Alle gesprekken', icon: Mail, count: conversations.length },
        { id: 'unread', label: 'Ongelezen', icon: MailOpen, count: unreadTotal, unread: true },
        { id: 'inbox', label: 'Niet gekoppeld', icon: Inbox, count: inboxCount, unread: true },
      ]}
      active={tab}
      onSelect={next => { setTab(next); if (next === 'inbox') { setComposing(false); setDetailOpen(false); } }}
      label="Berichten"
      className="comm-tabs"
    />

    {tab === 'inbox'
      ? <div className="comm-shell comm-shell-inbox">
          <div className="comm-inbox-pane">
            <InboundInboxTab
              organizationId={organizationId}
              clients={data.clients}
              canWrite={canWrite}
              heading={false}
              onChanged={() => {
                onInboxChanged();
                onUnreadChanged();
                onChanged();
                reload().catch(() => { /* best effort */ });
              }}
            />
          </div>
        </div>
      : <div className={`comm-shell${singlePane ? ' is-single' : ''}`}>
          {showList && <div className="comm-list">
            <div className="comm-list-tools">
              <div className="comm-search-row">
                <label className="comm-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="search"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={canReadTickets ? 'Zoek in berichten en tickets…' : 'Zoek op klant, onderwerp of afzender…'}
                    aria-label={canReadTickets ? 'Zoek in berichten en tickets' : 'Zoek in berichten'}
                  />
                  {query && <button type="button" className="comm-search-clear" onClick={() => setQuery('')} aria-label="Zoekterm wissen"><X size={13} /></button>}
                </label>
                <button
                  type="button"
                  className={`comm-filter-toggle${filtersOpen ? ' is-open' : ''}${filterCount > 0 ? ' has-active' : ''}`}
                  onClick={() => setFiltersOpen(open => !open)}
                  aria-expanded={filtersOpen}
                  aria-label={filterCount > 0 ? `Filters (${filterCount} actief)` : 'Filters'}
                  title="Filteren op soort, klant en periode"
                >
                  <SlidersHorizontal size={15} aria-hidden="true" />
                  {filterCount > 0 && <span className="comm-filter-count">{filterCount}</span>}
                </button>
              </div>
              <div className={`comm-filters${filtersOpen ? ' is-open' : ''}`}>
                {canReadTickets && <Select className="comm-filter" value={kindFilter} onChange={e => setKindFilter(e.target.value as '' | ConversationKind)} aria-label="Soort">
                  <option value="">Mail en tickets</option>
                  <option value="email">Alleen e-mail</option>
                  <option value="ticket">Alleen tickets</option>
                </Select>}
                <Select className="comm-filter" value={clientFilter} onChange={e => setClientFilter(e.target.value)} aria-label="Filter op klant" searchPlaceholder="Zoek een klant…">
                  <option value="">Alle klanten</option>
                  {hasNoClient && <option value={NO_CLIENT}>Zonder klant</option>}
                  {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </Select>
                <Select className="comm-filter" value={period} onChange={e => setPeriod(e.target.value as DatePeriod)} aria-label="Periode">
                  {DATE_PERIOD_OPTIONS.map(opt => <option key={opt.value || 'all'} value={opt.value}>{opt.label}</option>)}
                </Select>
                {period === 'custom' && <div className="comm-date-range">
                  <Input type="date" value={customFrom} max={customTo || undefined} onChange={e => setCustomFrom(e.target.value)} aria-label="Vanaf" />
                  <span>tot</span>
                  <Input type="date" value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)} aria-label="Tot en met" />
                </div>}
              </div>
              {deepBusy && <div className="comm-search-status" role="status">Zoeken in alle berichten…</div>}
            </div>

            <div className="comm-list-scroll">
              {!loaded && <div className="client-empty-line">Gesprekken laden…</div>}
              {loaded && loadError && <div className="error">{loadError}</div>}

              {loaded && notMigrated && <div className="client-empty-state comm-empty-state">
                <strong>Klantmail nog niet beschikbaar in deze omgeving</strong>
                <span>
                  De database is hier nog niet bijgewerkt. Mailgesprekken verschijnen hier zodra de migratie gedraaid is;
                  je klantmail staat intussen gewoon in het klantdossier, tabblad Communicatie.
                  {canReadTickets && ticketCount > 0 ? ' Tickets staan hieronder wel.' : ''}
                </span>
              </div>}

              {loaded && !loadError && conversations.length === 0 && (ready || (notMigrated && ticketCount === 0)) && <div className="client-empty-state comm-empty-state">
                <strong>{canReadTickets ? 'Nog geen klantmail of tickets' : 'Nog geen klantmail'}</strong>
                <span>
                  Stuur een eerste bericht via <em>Nieuw bericht</em>, of vanuit het klantdossier. Antwoorden van klanten
                  {canReadTickets ? ' en tickets uit het portaal' : ''} komen hier vanzelf terug. Wil je ook mail opvangen die een klant
                  rechtstreeks naar je eigen adres stuurt? Stel dan een doorstuuradres in onder Instellingen → E-mail &amp; domeinen.
                </span>
              </div>}

              {loaded && !loadError && conversations.length > 0 && visible.length === 0 && <div className="client-empty-state comm-empty-state">
                <strong>{tab === 'unread' && !filtersActive ? 'Alles gelezen' : 'Geen gesprekken gevonden'}</strong>
                <span>{tab === 'unread' && !filtersActive
                  ? 'Er staat geen ongelezen post meer in je gesprekken.'
                  : deepBusy ? 'Nog even: de database zoekt in alle berichten.' : 'Geen enkel gesprek komt overeen met je zoekterm of filters.'}</span>
                {filtersActive && <Button onClick={resetFilters}><RotateCcw size={14} /> Filters wissen</Button>}
              </div>}

              {visible.map(item => (
                <ConversationRow
                  key={item.key}
                  item={item}
                  client={item.clientId ? clientById.get(item.clientId) ?? null : null}
                  active={item.key === selectedKey && !composing}
                  found={foundLine(item)}
                  onSelect={() => selectConversation(item.key)}
                />
              ))}
            </div>
          </div>}

          {showDetail && <div className="comm-detail">
            {composing && <ComposePane
              key="compose"
              organizationId={organizationId}
              clients={data.clients}
              canWrite={canWrite}
              singlePane={singlePane}
              onBack={closeDetail}
              onSent={afterSent}
            />}
            {!composing && selected?.kind === 'email' && <ThreadPane
              key={selected.key}
              thread={selected.thread}
              client={clientById.get(selected.clientId) ?? null}
              organizationId={organizationId}
              canWrite={canWrite}
              activity={activity}
              singlePane={singlePane}
              onBack={closeDetail}
              onOpenClient={() => onOpenClient(selected.clientId)}
              onRead={() => { markThreadReadLocally(selected.id); onUnreadChanged(); }}
              onChanged={() => { reload().catch(() => { /* best effort */ }); onUnreadChanged(); }}
            />}
            {!composing && selected?.kind === 'ticket' && <TicketPane
              key={selected.key}
              item={selected}
              client={selected.clientId ? clientById.get(selected.clientId) ?? null : null}
              organizationId={organizationId}
              currentUserId={currentUserId}
              canWrite={canWriteTickets}
              singlePane={singlePane}
              onBack={closeDetail}
              onOpenClient={selected.clientId ? () => onOpenClient(selected.clientId as string) : null}
              onOpenTicket={() => onOpenTicket(selected.ticket)}
              onRead={onTicketUnreadChanged}
              onChanged={onChanged}
            />}
            {!composing && !selected && <div className="comm-empty">
              <Mail size={28} aria-hidden="true" />
              <strong>Kies een gesprek</strong>
              <span>{canReadTickets ? 'Klik links op een mailgesprek of ticket om het te lezen en te beantwoorden.' : 'Klik links op een gesprek om het te lezen en te beantwoorden.'}</span>
            </div>}
          </div>}
        </div>}
  </div>;
}

function ConversationRow({ item, client, active, found, onSelect }: {
  item: Conversation;
  client: Client | null;
  active: boolean;
  /** Fragment rond de zoektreffer, als die niet al in onderwerp of preview te zien is. */
  found: string | null;
  onSelect: () => void;
}) {
  const unread = item.unread > 0;
  const isTicket = item.kind === 'ticket';
  return <button
    type="button"
    className={`comm-row${active ? ' active' : ''}${unread ? ' unread' : ''}${isTicket ? ' is-ticket' : ''}`}
    onClick={onSelect}
    aria-current={active ? 'true' : undefined}
  >
    {item.clientId
      ? <span className="comm-row-avatar" style={{ background: client?.color || 'var(--bg4)' }} aria-hidden="true">{initials(item.clientName)}</span>
      : <span className="comm-row-avatar is-plain" aria-hidden="true"><TicketIcon size={16} /></span>}
    <span className="comm-row-body">
      <span className="comm-row-top">
        <span className="comm-row-client">{item.clientName}</span>
        {isTicket && <span className="comm-row-kind" title="Ticket"><TicketIcon size={11} aria-hidden="true" />Ticket</span>}
        <time className="comm-row-time" dateTime={item.lastAt} title={formatEmailDateTime(item.lastAt)}>{listTime(item.lastAt)}</time>
      </span>
      <span className="comm-row-subject">{item.subject}</span>
      {found
        ? <span className="comm-row-found" title="Gevonden in dit gesprek"><Search size={11} aria-hidden="true" />{found}</span>
        : <span className="comm-row-preview">{item.preview}</span>}
    </span>
    <span className="comm-row-side">
      {/* Bij een ticket geen getal (er is geen teller) en geen woord: "Nieuw" naast
          de status "Nieuw" zou twee dingen betekenen. Een stip, zoals op het tabblad. */}
      {unread && (isTicket
        ? <span className="comm-row-badge is-dot" role="img" aria-label="Nieuwe klant-activiteit op dit ticket" title="Nieuwe klant-activiteit op dit ticket" />
        : <span className="comm-row-badge" title={`${item.unread} ongelezen`}>{item.unread}</span>)}
      {item.hasProblem && <span className="comm-row-problem" title="Een bericht in dit gesprek is niet afgeleverd"><AlertTriangle size={13} /></span>}
      {isTicket && <span className={`comm-row-status tk-status ${item.status}`}>{ticketStatusLabel(item.status)}</span>}
    </span>
  </button>;
}

/** Wie er straks als afzender komt te staan — zelfde regels als in het klantdossier. */
function useEffectiveSender(organizationId: string): EffectiveSender | null {
  const [sender, setSender] = useState<EffectiveSender | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadSendingDomains(organizationId), loadMySenderIdentity(organizationId)])
      .then(([domains, identity]) => { if (!cancelled) setSender(resolveEffectiveSender(domains, identity)); })
      .catch(() => { if (!cancelled) setSender(null); });
    return () => { cancelled = true; };
  }, [organizationId]);
  return sender;
}

function SenderNote({ sender }: { sender: EffectiveSender | null }) {
  if (!sender) return null;
  return sender.fallback
    ? <p className="client-comm-from is-fallback">
        Afzender: het algemene ResoFly-adres. Wil je dat de klant <em>jouw</em> naam en adres ziet?
        Voeg je eigen domein toe onder <strong>Instellingen → E-mail &amp; domeinen</strong> en zet de
        DNS-records klaar; daarna vertrekt deze mail vanaf je eigen adres.
      </p>
    : <p className="client-comm-from">
        Van: <strong>{sender.name ? `${sender.name} <${sender.email}>` : sender.email}</strong>
      </p>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

/** Eén gesprek: kop, antwoordknop en de berichten (nieuwste eerst, zoals in het klantdossier). */
function ThreadPane({ thread, client, organizationId, canWrite, activity, singlePane, onBack, onOpenClient, onRead, onChanged }: {
  thread: ClientEmailThreadOverview;
  client: Client | null;
  organizationId: string;
  canWrite: boolean;
  /** Loopt op bij een live-event: een antwoord dat binnenkomt terwijl het gesprek openstaat, verschijnt meteen. */
  activity: number;
  singlePane: boolean;
  onBack: () => void;
  onOpenClient: () => void;
  /** De ongelezen berichten van dit gesprek zijn zojuist als gelezen gemarkeerd. */
  onRead: () => void;
  /** Er is iets verstuurd of verwijderd: de lijst hoort opnieuw te laden. */
  onChanged: () => void;
}) {
  const [emails, setEmails] = useState<ClientEmail[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const [subject, setSubject] = useState(() => replySubject(thread.subject));
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const sender = useEffectiveSender(organizationId);

  const recipient = (client?.email ?? thread.client_email ?? '').trim();
  const hasRecipient = EMAIL_RE.test(recipient);
  const canSend = canWrite && hasRecipient && subject.trim().length > 0 && stripHtml(body).length > 0 && !sending;

  const load = useCallback(async () => {
    const [loadedEmails, loadedReadIds] = await Promise.all([
      loadClientEmailsForThread(organizationId, thread.id),
      loadClientEmailReadIds(organizationId, thread.client_id),
    ]);
    setEmails(loadedEmails);
    setReadIds(loadedReadIds);
    return { loadedEmails, loadedReadIds };
  }, [organizationId, thread.id, thread.client_id]);

  // Openen = lezen: alle ongelezen inkomende berichten van dit gesprek worden
  // voor de huidige gebruiker als gelezen gemarkeerd — precies wat het
  // klantdossier doet als je een gesprek openklapt. De markering in beeld
  // blijft staan tot je het gesprek verlaat, zodat je nog ziet wát er nieuw was.
  // Bij een live-event (`activity`) laadt het gesprek opnieuw: een antwoord dat
  // binnenkomt terwijl je kijkt, staat er dan meteen — en telt als gelezen.
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    load()
      .then(async ({ loadedEmails, loadedReadIds }) => {
        if (cancelled) return;
        setLoaded(true);
        const unreadIds = loadedEmails.filter(m => m.direction === 'inbound' && !loadedReadIds.has(m.id)).map(m => m.id);
        if (unreadIds.length === 0) return;
        try {
          await markClientEmailsRead(organizationId, thread.client_id, unreadIds);
          if (!cancelled) onRead();
        } catch {
          // Stil: de badge telt bij de volgende navigatie gewoon opnieuw.
        }
      })
      .catch(err => { if (!cancelled) { setLoadError(err instanceof Error ? err.message : 'Gesprek laden mislukt.'); setLoaded(true); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, activity]);

  async function removeMessage(clientEmailId: string) {
    if (!window.confirm('Dit bericht uit het klantdossier halen? Het verdwijnt uit het gesprek.')) return;
    try {
      await deleteClientEmail(organizationId, clientEmailId);
      await load();
      onChanged();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Verwijderen mislukt.');
    }
  }

  async function send() {
    if (!canSend) return;
    setSending(true); setSendError(null); setSendMessage(null);
    try {
      const result = await sendClientEmail(organizationId, { clientId: thread.client_id, threadId: thread.id, subject: subject.trim(), bodyHtml: body });
      setBody('');
      setReplying(false);
      setSendMessage(`E-mail verzonden naar ${result.recipientEmail}.`);
      await load();
      onChanged();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'E-mail versturen mislukt.');
    } finally {
      setSending(false);
    }
  }

  return <>
    <div className="comm-detail-head">
      {singlePane && <button type="button" className="chat-icon-btn comm-back" onClick={onBack} aria-label="Terug naar de gesprekken"><ArrowLeft size={18} /></button>}
      <div className="comm-detail-title">
        <h3>{thread.subject || '(geen onderwerp)'}</h3>
        <div className="comm-detail-meta">
          <button type="button" className="comm-client-link" onClick={onOpenClient} title="Open het klantdossier">
            <span className="comm-row-avatar is-small" style={{ background: client?.color || 'var(--bg4)' }} aria-hidden="true">{initials(thread.client_name)}</span>
            {thread.client_name}
            <ExternalLink size={12} aria-hidden="true" />
          </button>
          <span>{recipient || 'geen e-mailadres'}</span>
          <span>{emails.length} bericht{emails.length === 1 ? '' : 'en'}</span>
        </div>
      </div>
      <div className="comm-detail-actions">
        <Button variant="primary" onClick={() => { setReplying(r => !r); setSendMessage(null); }} disabled={!canWrite || !hasRecipient} title={hasRecipient ? 'Antwoord in dit gesprek' : 'Deze klant heeft geen e-mailadres'}>
          <Reply size={14} /> <span className="btn-label">{replying ? 'Sluiten' : 'Beantwoorden'}</span>
        </Button>
      </div>
    </div>

    <div className="comm-detail-scroll">
      {replying && <article className="client-panel client-comm-compose comm-reply">
        <div className="client-panel-head"><h3>Antwoord</h3></div>
        <p className="client-comm-to">Aan: <strong>{recipient}</strong></p>
        <SenderNote sender={sender} />
        <label className="client-comm-field">Onderwerp
          <Input value={subject} onChange={e => { setSubject(e.target.value); setSendError(null); }} placeholder="Onderwerp van je e-mail" disabled={!canWrite || sending} />
        </label>
        <div className="client-comm-field">Bericht
          <RichTextEditor value={body} onChange={setBody} placeholder="Schrijf je antwoord…" disabled={!canWrite || sending} />
        </div>
        {sendError && <div className="error">{sendError}</div>}
        <div className="client-comm-actions">
          <Button onClick={() => { setReplying(false); setSendError(null); }} disabled={sending}>Annuleren</Button>
          <Button variant="primary" onClick={send} disabled={!canSend}>{sending ? 'Versturen…' : 'Verstuur antwoord'}</Button>
        </div>
      </article>}
      {sendMessage && <div className="success comm-sent-note">{sendMessage}</div>}
      {!hasRecipient && <div className="client-empty-line">Deze klant heeft geen e-mailadres. Vul er een in bij de klantgegevens om te kunnen antwoorden.</div>}

      {!loaded && <div className="client-empty-line">Gesprek laden…</div>}
      {loaded && loadError && <div className="error">{loadError}</div>}
      {loaded && !loadError && emails.length === 0 && <div className="client-empty-line">Dit gesprek bevat geen berichten meer.</div>}
      <div className="client-comm-messages comm-messages">
        {emails.map(msg => (
          <ClientEmailMessageCard
            key={msg.id}
            message={msg}
            isUnread={msg.direction === 'inbound' && !readIds.has(msg.id)}
            canWrite={canWrite}
            onRemove={(id) => void removeMessage(id)}
          />
        ))}
      </div>
    </div>
  </>;
}

/**
 * Eén ticket als gesprek: kop met status en prioriteit, de omschrijving en
 * de tijdlijn waarop team en klant elkaar antwoorden — dezelfde component als
 * in het bewerkvenster. Openen = lezen: de "Nieuw"-markering gaat weg zodra
 * het ticket hier openstaat, net als bij een mailgesprek.
 */
function TicketPane({ item, client, organizationId, currentUserId, canWrite, singlePane, onBack, onOpenClient, onOpenTicket, onRead, onChanged }: {
  item: TicketConversation;
  client: Client | null;
  organizationId: string;
  currentUserId: string | null;
  canWrite: boolean;
  singlePane: boolean;
  onBack: () => void;
  onOpenClient: (() => void) | null;
  onOpenTicket: () => void;
  /** Het ticket is zojuist als gelezen gemarkeerd: de badge mag opnieuw tellen. */
  onRead: () => void;
  /** Er is een notitie geplaatst, verborgen of verwijderd: de werkruimte-data hoort opnieuw te laden. */
  onChanged: () => void;
}) {
  const { ticket, notes } = item;
  const readRef = useRef<string | null>(null);
  useEffect(() => {
    if (!item.unread || readRef.current === ticket.id) return;
    readRef.current = ticket.id;
    markTicketRead(ticket.id).then(onRead).catch(() => { /* stil: de badge telt bij de volgende navigatie opnieuw */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id, item.unread]);

  const clientCount = notes.filter(n => n.author_type === 'client').length;

  return <>
    <div className="comm-detail-head">
      {singlePane && <button type="button" className="chat-icon-btn comm-back" onClick={onBack} aria-label="Terug naar de gesprekken"><ArrowLeft size={18} /></button>}
      <div className="comm-detail-title">
        <h3>{item.subject}</h3>
        <div className="comm-detail-meta">
          {onOpenClient
            ? <button type="button" className="comm-client-link" onClick={onOpenClient} title="Open het klantdossier">
                <span className="comm-row-avatar is-small" style={{ background: client?.color || 'var(--bg4)' }} aria-hidden="true">{initials(item.clientName)}</span>
                {item.clientName}
                <ExternalLink size={12} aria-hidden="true" />
              </button>
            : <span className="comm-client-link is-static"><TicketIcon size={12} aria-hidden="true" /> Geen klant</span>}
          <span className={`tk-status ${item.status}`}>{ticketStatusLabel(item.status)}</span>
          <span className={`tk-pri-label ${item.priority}`}>{ticketPriorityLabel(item.priority)}</span>
          <span>Aangemaakt {dateNL(ticket.created_at)}</span>
          <span>{notes.length} notitie{notes.length === 1 ? '' : 's'}{clientCount > 0 ? ` · ${clientCount} van klant` : ''}</span>
          {ticket.converted_to_project_id && <span>Omgezet naar een project</span>}
        </div>
      </div>
      <div className="comm-detail-actions">
        <Button variant="primary" onClick={onOpenTicket} title="Open het ticket: status, prioriteit, bijlagen">
          <SquarePen size={14} /> <span className="btn-label">Ticket openen</span>
        </Button>
      </div>
    </div>

    <div className="comm-detail-scroll">
      {ticket.description && <article className="client-panel comm-ticket-panel">
        <div className="client-panel-head"><h3>Omschrijving</h3></div>
        <p className="comm-ticket-text">{ticket.description}</p>
      </article>}
      {ticket.notes && <article className="client-panel comm-ticket-panel is-internal">
        <div className="client-panel-head"><h3>Interne notitie</h3><span>alleen voor het team</span></div>
        <p className="comm-ticket-text">{ticket.notes}</p>
      </article>}
      <article className="client-panel comm-ticket-panel comm-ticket-timeline">
        <TicketTimeline
          ticketId={ticket.id}
          organizationId={organizationId}
          currentUserId={currentUserId}
          notes={notes}
          canWrite={canWrite}
          onChanged={onChanged}
        />
        {!canWrite && <p className="client-empty-line">Je hebt geen schrijfrechten voor tickets; je kunt de tijdlijn wel lezen.</p>}
      </article>
    </div>
  </>;
}

/** Nieuw bericht aan een klant naar keuze — hetzelfde formulier als in het klantdossier, met de klant als extra veld. */
function ComposePane({ organizationId, clients, canWrite, singlePane, onBack, onSent }: {
  organizationId: string;
  clients: Client[];
  canWrite: boolean;
  singlePane: boolean;
  onBack: () => void;
  onSent: (threadId: string) => Promise<void>;
}) {
  const [clientId, setClientId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const sender = useEffectiveSender(organizationId);

  const sorted = useMemo(() => [...clients].sort((a, b) => a.name.localeCompare(b.name, 'nl')), [clients]);
  const client = clients.find(c => c.id === clientId) ?? null;
  const recipient = (client?.email ?? '').trim();
  const hasRecipient = EMAIL_RE.test(recipient);
  const canSend = canWrite && Boolean(client) && hasRecipient && subject.trim().length > 0 && stripHtml(body).length > 0 && !sending;

  async function send() {
    if (!canSend || !client) return;
    setSending(true); setSendError(null);
    try {
      const result = await sendClientEmail(organizationId, { clientId: client.id, subject: subject.trim(), bodyHtml: body });
      await onSent(result.threadId);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'E-mail versturen mislukt.');
      setSending(false);
    }
  }

  return <>
    <div className="comm-detail-head">
      {singlePane && <button type="button" className="chat-icon-btn comm-back" onClick={onBack} aria-label="Terug naar de gesprekken"><ArrowLeft size={18} /></button>}
      <div className="comm-detail-title">
        <h3>Nieuw bericht</h3>
        <div className="comm-detail-meta"><span>Begint een nieuw gesprek met de klant</span></div>
      </div>
      {!singlePane && <div className="comm-detail-actions">
        <button type="button" className="chat-icon-btn" onClick={onBack} aria-label="Sluiten"><X size={18} /></button>
      </div>}
    </div>
    <div className="comm-detail-scroll">
      <article className="client-panel client-comm-compose">
        <label className="client-comm-field">Aan
          <Select value={clientId} onChange={e => { setClientId(e.target.value); setSendError(null); }} disabled={!canWrite || sending} searchable searchPlaceholder="Zoek een klant…">
            <option value="">Kies een klant…</option>
            {sorted.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` — ${c.email}` : ' (geen e-mailadres)'}</option>)}
          </Select>
        </label>
        {client && !hasRecipient && <div className="client-empty-line">Deze klant heeft geen e-mailadres. Vul er een in bij de klantgegevens om te kunnen mailen.</div>}
        {client && hasRecipient && <p className="client-comm-to">Aan: <strong>{recipient}</strong></p>}
        <SenderNote sender={sender} />
        <label className="client-comm-field">Onderwerp
          <Input value={subject} onChange={e => { setSubject(e.target.value); setSendError(null); }} placeholder="Onderwerp van je e-mail" disabled={!canWrite || sending} />
        </label>
        <div className="client-comm-field">Bericht
          <RichTextEditor value={body} onChange={setBody} placeholder="Schrijf je bericht…" disabled={!canWrite || sending} />
        </div>
        {sendError && <div className="error">{sendError}</div>}
        <div className="client-comm-actions">
          <Button onClick={onBack} disabled={sending}>Annuleren</Button>
          <Button variant="primary" onClick={send} disabled={!canSend}>{sending ? 'Versturen…' : 'Verstuur e-mail'}</Button>
        </div>
        {!canWrite && <p className="client-empty-line">Je hebt geen schrijfrechten om e-mails te versturen.</p>}
      </article>
    </div>
  </>;
}
