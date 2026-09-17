import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, ExternalLink, Inbox, Mail, MailOpen, Reply, RotateCcw, Search, SquarePen, X } from 'lucide-react';
import type { AppData, Client, ClientEmail, ClientEmailThreadOverview } from '../types';
import { Button, Input, Select } from '../components/Ui';
import { DetailTabs } from '../components/DetailTabs';
import { RichTextEditor } from '../components/RichTextEditor';
import { InboundInboxTab } from '../components/InboundInbox';
import { ClientEmailMessageCard, formatEmailDateTime } from '../components/ClientEmailMessage';
import { deleteClientEmail, loadClientEmailReadIds, loadClientEmailThreadOverview, loadClientEmailsForThread, loadMySenderIdentity, loadSendingDomains, markClientEmailsRead } from '../lib/repository';
import { resolveEffectiveSender, sendClientEmail, type EffectiveSender } from '../services/mailService';
import { countUnread, filterThreads, initials, listTime, previewLine, replySubject, type CommunicationTab } from '../lib/communication';
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
}

/**
 * Berichten: alle klantcommunicatie van de organisatie op één pagina.
 *
 * Links de gesprekken van álle klanten (nieuwste eerst, met ongelezen-teller),
 * rechts het gekozen gesprek met een antwoordknop. Het derde tabblad is de
 * opvangbak: post die binnenkwam maar nog niet aan een klant hangt. Die zat
 * eerst alleen als tabblad op de klantenlijst; hier hoort hij bij de rest van
 * de post, want de vraag "is er nieuwe post?" is één vraag.
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
  onUnreadChanged,
  onInboxChanged,
  onOpenClient,
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
  /** Ongelezen-tellers (badge in het menu, klantenlijst) opnieuw laten tellen. */
  onUnreadChanged: () => void;
  /** Teller van de opvangbak opnieuw laten tellen. */
  onInboxChanged: () => void;
  onOpenClient: (clientId: string) => void;
  /** Werkruimte-data verversen (koppelen kan een contactpersoon aanmaken). */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  /** Op een smal scherm: staat het gesprek (of het nieuwe bericht) in beeld, of de lijst? */
  const [detailOpen, setDetailOpen] = useState(false);
  /** Springt na een verzonden nieuw bericht naar dat gesprek zodra de lijst opnieuw geladen is. */
  const pendingSelectRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const rows = await loadClientEmailThreadOverview(organizationId);
    setThreads(rows);
    setLoaded(true);
    setLoadError(null);
    setNotMigrated(false);
    if (pendingSelectRef.current && rows.some(t => t.id === pendingSelectRef.current)) {
      setSelectedId(pendingSelectRef.current);
      pendingSelectRef.current = null;
    }
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setSelectedId(null);
    setComposing(false);
    setDetailOpen(false);
    setNotMigrated(false);
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
  // beslislijst opent de opvangbak.
  const focusKeyRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focus.key === focusKeyRef.current) return;
    focusKeyRef.current = focus.key;
    if (focus.tab) setTab(focus.tab);
    if (focus.threadId) {
      setComposing(false);
      setSelectedId(focus.threadId);
      setDetailOpen(true);
      if (!focus.tab) setTab('all');
      // Het gesprek kan net zijn ontstaan (eerste bericht van een klant): dan
      // staat het nog niet in de lijst. Eén keer opnieuw laden lost dat op.
      if (!threads.some(t => t.id === focus.threadId)) reload().catch(() => { /* best effort */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key]);

  const visible = useMemo(() => {
    const list = filterThreads(threads, { tab, query, clientId: clientFilter });
    // Het geopende gesprek blijft op het tabblad Ongelezen staan nadat het
    // (door het openen) gelezen is — anders verdwijnt het onder je muis vandaan.
    if (tab === 'unread' && selectedId && !list.some(t => t.id === selectedId)) {
      const kept = filterThreads(threads.filter(t => t.id === selectedId), { tab: 'all', query, clientId: clientFilter });
      if (kept.length > 0) return threads.filter(t => t.id === selectedId || list.some(l => l.id === t.id));
    }
    return list;
  }, [threads, tab, query, clientFilter, selectedId]);
  const unreadTotal = useMemo(() => countUnread(threads), [threads]);
  const selected = selectedId ? threads.find(t => t.id === selectedId) ?? null : null;

  // Alleen klanten die daadwerkelijk een gesprek hebben — een filter met
  // tweehonderd klanten waarvan er acht mailen, is geen filter.
  const clientOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const thread of threads) if (!seen.has(thread.client_id)) seen.set(thread.client_id, thread.client_name);
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'nl'));
  }, [threads]);

  const clientById = useMemo(() => new Map(data.clients.map(c => [c.id, c])), [data.clients]);

  function selectThread(id: string) {
    setComposing(false);
    setSelectedId(id);
    setDetailOpen(true);
  }

  function startCompose() {
    setSelectedId(null);
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
  }

  async function afterSent(threadId: string) {
    pendingSelectRef.current = threadId;
    setComposing(false);
    await reload();
  }

  const singlePane = narrow;
  const showList = !singlePane || !detailOpen;
  const showDetail = !singlePane || detailOpen;
  const filtersActive = query.trim().length > 0 || clientFilter !== '';
  // Op de telefoon krijgt een geopend gesprek het hele scherm: kop en
  // tabbladen gaan weg (CSS), de terugpijl in de gesprekskop brengt je terug.
  const detailFillsScreen = singlePane && detailOpen && tab !== 'inbox';

  return <div className={`comm-page${detailFillsScreen ? ' is-detail' : ''}`}>
    <div className="comm-head">
      <div className="comm-head-text">
        <p className="eyebrow">Communicatie</p>
        <h2>Berichten</h2>
        <span className="comm-head-sub">
          {loaded && !loadError && !notMigrated
            ? `${threads.length} gesprek${threads.length === 1 ? '' : 'ken'} · ${unreadTotal} ongelezen · ${inboxCount} niet gekoppeld`
            : 'Alle klantmail op één plek'}
        </span>
      </div>
      <Button variant="primary" onClick={startCompose} disabled={!canWrite} title="Nieuw bericht aan een klant">
        <SquarePen size={15} /> <span className="btn-label">Nieuw bericht</span>
      </Button>
    </div>

    <DetailTabs
      tabs={[
        { id: 'all', label: 'Alle gesprekken', icon: Mail, count: threads.length },
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
              <label className="comm-search">
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Zoek op klant, onderwerp of afzender…"
                  aria-label="Zoek in berichten"
                />
                {query && <button type="button" className="comm-search-clear" onClick={() => setQuery('')} aria-label="Zoekterm wissen"><X size={13} /></button>}
              </label>
              {clientOptions.length > 1 && <Select className="comm-client-filter" value={clientFilter} onChange={e => setClientFilter(e.target.value)} aria-label="Filter op klant">
                <option value="">Alle klanten</option>
                {clientOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </Select>}
            </div>

            <div className="comm-list-scroll">
              {!loaded && <div className="client-empty-line">Gesprekken laden…</div>}
              {loaded && loadError && <div className="error">{loadError}</div>}

              {loaded && notMigrated && <div className="client-empty-state comm-empty-state">
                <strong>Nog niet beschikbaar in deze omgeving</strong>
                <span>
                  De database is hier nog niet bijgewerkt. Deze pagina werkt zodra de migratie gedraaid is;
                  je klantmail staat intussen gewoon in het klantdossier, tabblad Communicatie.
                </span>
              </div>}

              {loaded && !loadError && !notMigrated && threads.length === 0 && <div className="client-empty-state comm-empty-state">
                <strong>Nog geen klantmail</strong>
                <span>
                  Stuur een eerste bericht via <em>Nieuw bericht</em>, of vanuit het klantdossier. Antwoorden van klanten
                  komen hier vanzelf terug. Wil je ook mail opvangen die een klant rechtstreeks naar je eigen adres
                  stuurt? Stel dan een doorstuuradres in onder Instellingen → E-mail &amp; domeinen.
                </span>
              </div>}

              {loaded && !loadError && !notMigrated && threads.length > 0 && visible.length === 0 && <div className="client-empty-state comm-empty-state">
                <strong>{tab === 'unread' && !filtersActive ? 'Alles gelezen' : 'Geen gesprekken gevonden'}</strong>
                <span>{tab === 'unread' && !filtersActive
                  ? 'Er staat geen ongelezen post meer in je gesprekken.'
                  : 'Geen enkel gesprek komt overeen met je zoekterm of klantfilter.'}</span>
                {filtersActive && <Button onClick={() => { setQuery(''); setClientFilter(''); }}><RotateCcw size={14} /> Filters wissen</Button>}
              </div>}

              {visible.map(thread => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  client={clientById.get(thread.client_id) ?? null}
                  active={thread.id === selectedId && !composing}
                  onSelect={() => selectThread(thread.id)}
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
            {!composing && selected && <ThreadPane
              key={selected.id}
              thread={selected}
              client={clientById.get(selected.client_id) ?? null}
              organizationId={organizationId}
              canWrite={canWrite}
              activity={activity}
              singlePane={singlePane}
              onBack={closeDetail}
              onOpenClient={() => onOpenClient(selected.client_id)}
              onRead={() => { markThreadReadLocally(selected.id); onUnreadChanged(); }}
              onChanged={() => { reload().catch(() => { /* best effort */ }); onUnreadChanged(); }}
            />}
            {!composing && !selected && <div className="comm-empty">
              <Mail size={28} aria-hidden="true" />
              <strong>Kies een gesprek</strong>
              <span>Klik links op een gesprek om het te lezen en te beantwoorden.</span>
            </div>}
          </div>}
        </div>}
  </div>;
}

function ThreadRow({ thread, client, active, onSelect }: {
  thread: ClientEmailThreadOverview;
  client: Client | null;
  active: boolean;
  onSelect: () => void;
}) {
  const unread = thread.unread_count > 0;
  return <button
    type="button"
    className={`comm-row${active ? ' active' : ''}${unread ? ' unread' : ''}`}
    onClick={onSelect}
    aria-current={active ? 'true' : undefined}
  >
    <span className="comm-row-avatar" style={{ background: client?.color || 'var(--bg4)' }} aria-hidden="true">{initials(thread.client_name)}</span>
    <span className="comm-row-body">
      <span className="comm-row-top">
        <span className="comm-row-client">{thread.client_name}</span>
        <time className="comm-row-time" dateTime={thread.last_message_at} title={formatEmailDateTime(thread.last_message_at)}>{listTime(thread.last_message_at)}</time>
      </span>
      <span className="comm-row-subject">{thread.subject || '(geen onderwerp)'}</span>
      <span className="comm-row-preview">{previewLine(thread)}</span>
    </span>
    <span className="comm-row-side">
      {unread && <span className="comm-row-badge" title={`${thread.unread_count} ongelezen`}>{thread.unread_count}</span>}
      {thread.has_delivery_problem && <span className="comm-row-problem" title="Een bericht in dit gesprek is niet afgeleverd"><AlertTriangle size={13} /></span>}
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
