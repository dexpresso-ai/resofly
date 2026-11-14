import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, Ban, Check, CircleCheck, CircleDashed, CircleX, CornerDownLeft, Lock, MessageSquareText, MessagesSquare,
  RotateCw, Search, Sparkles, SquarePen, Trash2, UserRound, X,
} from 'lucide-react';
import {
  dayHeading, groupConversations, listTimeLabel, messageTime, normalizeQuery, onGerrieConversation, signalGerrieConversation,
  splitOnQuery, startedLabel, conversationTitle, MIN_QUERY, PROPOSAL_STATUS_LABEL,
  type ConversationMessage, type ConversationSummary, type PastProposal, type PastProposalStatus,
} from '../lib/gerrieConversations';
import { listGerrieConversations, loadGerrieConversation, searchGerrieConversations } from '../lib/gerrieConversations-api';
import { deleteGerrieConversation } from '../lib/gerrie-api';
import { useBackStep } from '../lib/useBackStep';
import type { UUID } from '../types';

/**
 * Gerrie → Gesprekken: je eerdere gesprekken met Gerrie, terug te lezen als
 * chat. Links de lijst (met zoeken), rechts het gesprek; op de telefoon het een
 * na het ander, met een terugknop.
 *
 * Verder praten gebeurt in de chat rechtsonder, niet hier. Die chat kent de
 * voorstelkaarten, het inspreken en het tegoed; een tweede invoerveld hier zou
 * dat allemaal dubbel moeten bijhouden, en dan liep er één uit de pas.
 *
 * Een oud voorstel voer je hier niet meer uit. Je ziet wat Gerrie voorstelde en
 * wat ermee gebeurde. Een factuur die vorige week verstuurd moest worden, kan
 * inmiddels betaald zijn; vraag het dan opnieuw, met de gegevens van nu.
 */

const WIDE_QUERY = '(min-width: 900px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return wide;
}

/** Tekst met het zoekwoord gemarkeerd. */
function Highlight({ text, query }: { text: string; query: string }) {
  const parts = splitOnQuery(text, query);
  return <>{parts.map((p, i) => (p.hit ? <mark key={i} className="gsp-mark">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

const STATUS_ICON: Record<PastProposalStatus, ReactNode> = {
  open: <CircleDashed size={14} />,
  approved: <Check size={14} />,
  done: <CircleCheck size={14} />,
  rejected: <Ban size={14} />,
  failed: <CircleX size={14} />,
};

export function GerrieConversations({ organizationId, currentUserId, focusConversationId = null, onFocusConsumed }: {
  organizationId: UUID;
  currentUserId: string | null;
  /** Vanuit de chat ("Alle gesprekken"): dit gesprek meteen openen. */
  focusConversationId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const wide = useWide();

  // ── De lijst ──
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── Zoeken ──
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSummary[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const activeQuery = normalizeQuery(query);
  const isSearch = activeQuery.length >= MIN_QUERY;

  // ── Het geopende gesprek ──
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ conversation: ConversationSummary; messages: ConversationMessage[] } | null>(null);
  const [threadState, setThreadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [threadError, setThreadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Een antwoord dat binnenkomt nadat je al een ander gesprek koos, mag dat
  // andere gesprek niet overschrijven.
  const threadRequest = useRef(0);
  const listRequest = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLElement>(null);
  // Voor welk gesprek (en hoeveel berichten) de beginstand al is gezet.
  const scrolledFor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Op een breed scherm opent het nieuwste gesprek vanzelf, maar alleen de
  // eerste keer: wie daarna terug naar "geen gesprek" gaat (verwijderen), wil
  // niet dat er ongevraagd een ander opengaat.
  const autoOpened = useRef(false);

  const loadList = useCallback(async (quiet = false) => {
    if (!currentUserId) return;
    const req = ++listRequest.current;
    if (!quiet) { setListState('loading'); setListError(null); }
    try {
      const page = await listGerrieConversations(organizationId, currentUserId);
      if (req !== listRequest.current) return;
      setItems(page.items);
      setHasMore(page.hasMore);
      setListState('ready');
    } catch (e) {
      if (req !== listRequest.current) return;
      if (!quiet) { setListError(e instanceof Error ? e.message : 'Je gesprekken laden lukte niet.'); setListState('error'); }
    }
  }, [organizationId, currentUserId]);

  async function loadMore() {
    if (!currentUserId || loadingMore || !hasMore) return;
    const last = items[items.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await listGerrieConversations(organizationId, currentUserId, { before: last.updatedAt });
      setItems((prev) => {
        const known = new Set(prev.map((i) => i.id));
        return [...prev, ...page.items.filter((i) => !known.has(i.id))];
      });
      setHasMore(page.hasMore);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Oudere gesprekken laden lukte niet.');
    } finally {
      setLoadingMore(false);
    }
  }

  const openThread = useCallback(async (id: string, quiet = false) => {
    if (!currentUserId) return;
    const req = ++threadRequest.current;
    setSelectedId(id);
    setConfirmDelete(false);
    setDeleteError(null);
    if (!quiet) { setThreadState('loading'); setThreadError(null); setThread(null); }
    try {
      const loaded = await loadGerrieConversation(organizationId, currentUserId, id);
      if (req !== threadRequest.current) return;
      setThread(loaded);
      setThreadState('ready');
    } catch (e) {
      if (req !== threadRequest.current) return;
      if (!quiet) { setThreadError(e instanceof Error ? e.message : 'Dit gesprek laden lukte niet.'); setThreadState('error'); }
    }
  }, [organizationId, currentUserId]);

  function closeThread() {
    threadRequest.current += 1;
    scrolledFor.current = null;
    setSelectedId(null);
    setThread(null);
    setThreadState('idle');
    setConfirmDelete(false);
  }
  // Op telefoon en tablet staat een gesprek in plaats van de lijst, met een
  // terugpijl. De terugknop van de telefoon doet hetzelfde.
  useBackStep(!wide && threadState !== 'idle', closeThread);

  // Andere organisatie of gebruiker: alles opnieuw.
  useEffect(() => {
    autoOpened.current = false;
    closeThread();
    setQuery('');
    setResults(null);
    void loadList();
  }, [loadList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vanuit de chat: dit gesprek openen.
  useEffect(() => {
    if (!focusConversationId) return;
    autoOpened.current = true;
    void openThread(focusConversationId);
    onFocusConsumed?.();
  }, [focusConversationId, openThread, onFocusConsumed]);

  // Breed scherm: het nieuwste gesprek staat meteen open, zodat de rechterkant
  // niet leeg begint.
  useEffect(() => {
    if (!wide || autoOpened.current || selectedId || listState !== 'ready' || isSearch) return;
    autoOpened.current = true;
    if (items[0]) void openThread(items[0].id);
  }, [wide, listState, items, selectedId, isSearch, openThread]);

  // Zoeken: even wachten tot je klaar bent met typen.
  useEffect(() => {
    if (!isSearch || !currentUserId) { setResults(null); setSearching(false); setSearchError(null); return; }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      searchGerrieConversations(organizationId, currentUserId, activeQuery)
        .then((found) => { if (!cancelled) setResults(found); })
        .catch((e) => { if (!cancelled) { setSearchError(e instanceof Error ? e.message : 'Zoeken lukte niet.'); setResults([]); } })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 280);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeQuery, isSearch, organizationId, currentUserId]);

  // De chat meldt een nieuw antwoord of een verwijderd gesprek.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  useEffect(() => onGerrieConversation((signal) => {
    if (signal.type === 'updated') {
      void loadList(true);
      if (selectedRef.current === signal.id) void openThread(signal.id, true);
    }
    if (signal.type === 'deleted') {
      setItems((prev) => prev.filter((i) => i.id !== signal.id));
      setResults((prev) => (prev ? prev.filter((i) => i.id !== signal.id) : prev));
      if (selectedRef.current === signal.id) closeThread();
    }
  }), [loadList, openThread]); // eslint-disable-line react-hooks/exhaustive-deps

  // Waar een geopend gesprek begint. Breed: onderaan, bij het laatste wat er
  // gezegd is, zoals in elke chat. Op de telefoon staat het gesprek in de
  // pagina zelf; daar begint het bovenaan, anders bleef je halverwege staan op
  // de plek waar je in de lijst was. Kom je via zoeken, dan bij de eerste
  // treffer: daar zocht je naar. Alleen bij een ander gesprek of een nieuw
  // bericht, niet bij elke verversing.
  useEffect(() => {
    if (threadState !== 'ready' || !thread) return;
    const key = `${thread.conversation.id}:${thread.messages.length}`;
    if (scrolledFor.current === key) return;
    const first = !scrolledFor.current?.startsWith(`${thread.conversation.id}:`);
    scrolledFor.current = key;
    const el = scrollRef.current;
    if (!el) return;
    const hit = first && isSearch ? el.querySelector('mark.gsp-mark') : null;
    if (wide) {
      if (hit instanceof HTMLElement) el.scrollTop += hit.getBoundingClientRect().top - el.getBoundingClientRect().top - 80;
      else el.scrollTop = el.scrollHeight;
    } else if (first) {
      if (hit instanceof HTMLElement) hit.scrollIntoView({ block: 'center' });
      else threadRef.current?.scrollIntoView({ block: 'start' });
    }
  }, [threadState, thread, isSearch, wide]);

  // Een melding verdwijnt vanzelf.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  async function removeConversation() {
    if (!thread || deleting) return;
    const id = thread.conversation.id;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteGerrieConversation(organizationId, id);
      const remaining = items.filter((i) => i.id !== id);
      setItems(remaining);
      setResults((prev) => (prev ? prev.filter((i) => i.id !== id) : prev));
      signalGerrieConversation({ type: 'deleted', id });
      closeThread();
      setNotice('Gesprek verwijderd.');
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Verwijderen lukte niet.');
    } finally {
      setDeleting(false);
    }
  }

  const shown = isSearch ? (results ?? []) : items;
  const groups = useMemo(() => (isSearch ? [] : groupConversations(items)), [isSearch, items]);
  const showThreadOnly = !wide && selectedId !== null;

  if (!currentUserId) {
    return (
      <div className="ag-page gsp-page">
        <div className="cc-empty"><span className="cc-empty-icon" aria-hidden="true"><Lock size={24} /></span><h2>Even geduld</h2><p>We weten nog niet wie er is ingelogd.</p></div>
      </div>
    );
  }

  const listPane = (
    <section className="gsp-list" aria-label="Je gesprekken">
      <div className="gsp-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } }}
          placeholder="Zoek in je gesprekken"
          aria-label="Zoek in je gesprekken"
          enterKeyHint="search"
          autoComplete="off"
        />
        {query && (
          <button type="button" className="gsp-search-clear" onClick={() => { setQuery(''); searchRef.current?.focus(); }} aria-label="Zoekveld leegmaken">
            <X size={14} />
          </button>
        )}
      </div>

      {isSearch && (
        <p className="gsp-search-status" role="status">
          {searching ? 'Zoeken…'
            : searchError ? searchError
            : shown.length === 0 ? `Niets gevonden voor “${activeQuery}”.`
            : `${shown.length} gesprek${shown.length === 1 ? '' : 'ken'} met “${activeQuery}”`}
        </p>
      )}

      <div className="gsp-list-scroll">
        {listState === 'loading' && !isSearch && (
          <ul className="gsp-items" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => <li key={i} className="gsp-skeleton"><span /><span /></li>)}
          </ul>
        )}

        {listState === 'error' && !isSearch && (
          <div className="gsp-state">
            <p>{listError}</p>
            <button type="button" className="cc-btn ghost tiny" onClick={() => void loadList()}><RotateCw size={13} /> Opnieuw proberen</button>
          </div>
        )}

        {listState === 'ready' && !isSearch && items.length === 0 && (
          <div className="gsp-empty">
            <span className="cc-empty-icon" aria-hidden="true"><MessagesSquare size={24} /></span>
            <h3>Nog geen gesprekken</h3>
            <p>Alles wat je Gerrie vraagt, komt hier vanzelf te staan. Zo vind je een antwoord later makkelijk terug.</p>
            <button type="button" className="cc-btn primary tiny" onClick={() => signalGerrieConversation({ type: 'new' })}>
              <Sparkles size={13} /> Stel Gerrie een vraag
            </button>
          </div>
        )}

        {isSearch ? (
          shown.length > 0 && (
            <ul className="gsp-items">
              {shown.map((c) => (
                <ConversationItem key={c.id} item={c} query={activeQuery} selected={c.id === selectedId} onOpen={() => void openThread(c.id)} />
              ))}
            </ul>
          )
        ) : listState === 'ready' && groups.map((g) => (
          <div key={g.key} className="gsp-group">
            <h3 className="gsp-group-label">{g.label}</h3>
            <ul className="gsp-items">
              {g.items.map((c) => (
                <ConversationItem key={c.id} item={c} query="" selected={c.id === selectedId} onOpen={() => void openThread(c.id)} />
              ))}
            </ul>
          </div>
        ))}

        {!isSearch && hasMore && listState === 'ready' && (
          <button type="button" className="gsp-more" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Laden…' : 'Oudere gesprekken laden'}
          </button>
        )}
      </div>

      <p className="gsp-privacy"><Lock size={12} aria-hidden="true" /> Alleen jij ziet je gesprekken met Gerrie.</p>
    </section>
  );

  const threadPane = (
    <section className="gsp-thread" ref={threadRef} aria-label={thread ? `Gesprek: ${conversationTitle(thread.conversation.title)}` : 'Gesprek'}>
      {threadState === 'idle' && (
        <div className="gsp-placeholder">
          <span className="cc-empty-icon" aria-hidden="true"><MessagesSquare size={24} /></span>
          <h3>Kies een gesprek</h3>
          <p>Lees terug wat Gerrie zei, of praat verder waar je gebleven was.</p>
        </div>
      )}

      {threadState !== 'idle' && (
        <header className="gsp-thread-head">
          {!wide && (
            <button type="button" className="gsp-icon-btn" onClick={closeThread} aria-label="Terug naar je gesprekken">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="gsp-thread-id">
            <h3 className="gsp-thread-title">{thread ? conversationTitle(thread.conversation.title) : 'Gesprek laden…'}</h3>
            {thread && (
              <p className="gsp-thread-meta">
                {startedLabel(thread.conversation.createdAt)} · {thread.messages.length} bericht{thread.messages.length === 1 ? '' : 'en'}
              </p>
            )}
          </div>
          {thread && !wide && (
            <button type="button" className="cc-btn primary tiny gsp-head-continue" onClick={() => signalGerrieConversation({ type: 'open', id: thread.conversation.id })}>
              <CornerDownLeft size={13} /> Verder
            </button>
          )}
          {thread && (
            <button type="button" className="gsp-icon-btn danger" onClick={() => { setConfirmDelete(true); setDeleteError(null); }}
              aria-label="Gesprek verwijderen" title="Gesprek verwijderen" disabled={deleting}>
              <Trash2 size={16} />
            </button>
          )}
        </header>
      )}

      {confirmDelete && thread && (
        <div className="gsp-confirm" role="alertdialog" aria-labelledby="gsp-confirm-title" aria-describedby="gsp-confirm-text"
          onKeyDown={(e) => { if (e.key === 'Escape' && !deleting) { e.stopPropagation(); setConfirmDelete(false); } }}>
          <div>
            <p id="gsp-confirm-title" className="gsp-confirm-title">Dit gesprek verwijderen?</p>
            <p id="gsp-confirm-text" className="gsp-confirm-text">
              De berichten zijn daarna weg, ook voor jou. Wat Gerrie voorstelde en wat daarmee gebeurde, blijft in het logboek staan.
            </p>
            {deleteError && <p className="gsp-confirm-error" role="alert">{deleteError}</p>}
          </div>
          <div className="gsp-confirm-actions">
            <button type="button" className="cc-btn ghost tiny" onClick={() => setConfirmDelete(false)} disabled={deleting} autoFocus>Annuleren</button>
            <button type="button" className="cc-btn tiny gsp-danger" onClick={() => void removeConversation()} disabled={deleting}>
              <Trash2 size={13} /> {deleting ? 'Verwijderen…' : 'Verwijderen'}
            </button>
          </div>
        </div>
      )}

      {threadState === 'loading' && (
        <div className="gsp-thread-scroll" aria-busy="true">
          <div className="gsp-skeleton-msgs" aria-hidden="true"><span /><span /><span /></div>
        </div>
      )}

      {threadState === 'error' && (
        <div className="gsp-state">
          <p>{threadError}</p>
          {selectedId && <button type="button" className="cc-btn ghost tiny" onClick={() => void openThread(selectedId)}><RotateCw size={13} /> Opnieuw proberen</button>}
        </div>
      )}

      {threadState === 'ready' && thread && (
        <>
          <div className="gsp-thread-scroll" ref={scrollRef} tabIndex={0} aria-label="Berichten">
            {thread.messages.length === 0 && <p className="gsp-thread-empty">Dit gesprek heeft nog geen berichten.</p>}
            {thread.messages.map((m, i) => {
              const day = dayHeading(m.createdAt);
              const prevDay = i > 0 ? dayHeading(thread.messages[i - 1].createdAt) : null;
              return (
                <Fragment key={m.id}>
                  {day !== prevDay && <div className="gsp-day" role="separator"><span>{day}</span></div>}
                  <MessageRow message={m} query={isSearch ? activeQuery : ''} />
                </Fragment>
              );
            })}
          </div>
          <footer className="gsp-thread-foot">
            <button type="button" className="gsp-continue" onClick={() => signalGerrieConversation({ type: 'open', id: thread.conversation.id })}>
              <span className="gsp-continue-text">Verder praten met Gerrie…</span>
              <span className="gsp-continue-key" aria-hidden="true"><CornerDownLeft size={15} /></span>
            </button>
          </footer>
        </>
      )}
    </section>
  );

  return (
    <div className="ag-page gsp-page">
      <header className="ag-page-head gsp-head">
        <div>
          <h2>Gesprekken</h2>
          <p>Alles wat je Gerrie vroeg, om terug te lezen of op door te gaan. <b>Alleen jij ziet je gesprekken.</b></p>
        </div>
        <button type="button" className="cc-btn primary gsp-new" onClick={() => signalGerrieConversation({ type: 'new' })}>
          <SquarePen size={14} /> Nieuw gesprek
        </button>
      </header>

      {notice && <p className="gsp-notice" role="status">{notice}</p>}

      <div className={`gsp${showThreadOnly ? ' is-thread' : ''}`}>
        {!showThreadOnly && listPane}
        {(wide || showThreadOnly) && threadPane}
      </div>
    </div>
  );
}

function ConversationItem({ item, query, selected, onOpen }: { item: ConversationSummary; query: string; selected: boolean; onOpen: () => void }) {
  const title = conversationTitle(item.title);
  return (
    <li>
      <button type="button" className={`gsp-item${selected ? ' on' : ''}`} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
        <span className="gsp-item-icon" aria-hidden="true"><MessageSquareText size={15} /></span>
        <span className="gsp-item-main">
          <span className="gsp-item-row">
            <span className="gsp-item-title"><Highlight text={title} query={query} /></span>
            <time className="gsp-item-time" dateTime={item.updatedAt}>{listTimeLabel(item.updatedAt)}</time>
          </span>
          {item.snippet && <span className="gsp-item-snippet"><Highlight text={item.snippet} query={query} /></span>}
        </span>
      </button>
    </li>
  );
}

function MessageRow({ message, query }: { message: ConversationMessage; query: string }) {
  const mine = message.role === 'user';
  return (
    <div className={`gsp-msg ${mine ? 'user' : 'assistant'}`}>
      <span className="gsp-avatar" aria-hidden="true">{mine ? <UserRound size={15} /> : <Sparkles size={15} />}</span>
      <div className="gsp-msg-body">
        <span className="gsp-sr">{mine ? 'Jij' : 'Gerrie'}:</span>
        {message.text && <div className="gsp-bubble"><Highlight text={message.text} query={query} /></div>}
        {message.proposals.map((p) => <ProposalLine key={p.auditId} proposal={p} />)}
        <time className="gsp-time" dateTime={message.createdAt}>{messageTime(message.createdAt)}</time>
      </div>
    </div>
  );
}

function ProposalLine({ proposal }: { proposal: PastProposal }) {
  return (
    <div className="gsp-proposal" data-status={proposal.status}>
      <div className="gsp-proposal-main">
        <span className="gsp-proposal-kicker">Voorstel</span>
        <span className="gsp-proposal-title">{proposal.title}</span>
        {proposal.sub && <span className="gsp-proposal-sub">{proposal.sub}</span>}
        {proposal.status === 'open' && (
          <span className="gsp-proposal-hint">Nooit beslist. Wil je het nog? Vraag het Gerrie opnieuw, dan rekent hij met de gegevens van nu.</span>
        )}
      </div>
      <span className="gsp-pill" data-status={proposal.status}>{STATUS_ICON[proposal.status]} {PROPOSAL_STATUS_LABEL[proposal.status]}</span>
    </div>
  );
}
