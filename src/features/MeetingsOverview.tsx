import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  AudioLines, Check, ChevronDown, Eye, EyeOff, FileText, Loader2, MoreVertical, Phone, Play, Search,
  SlidersHorizontal, StickyNote, Users, VolumeX, X,
} from 'lucide-react';
import { Button, Skeleton } from '../components/Ui';
import { Modal } from '../components/Modal';
import { TranscriptLines } from '../components/MeetingNoteViews';
import { deleteRecordingAudio, getRecording, listMeetingOverview, listReadableCalendarSourceIds } from '../lib/meeting-api';
import {
  audioLabel, audioTotals, canDeleteAudio, durationShort, filterMeetings, formatBytes, hasAudio, KIND_LABEL,
  meetingCount, meetingDay, meetingKind, meetingTitle, notulenState, shortDay, sortMeetings, visibleInOverview,
  type AudioFilter, type MeetingKind, type MeetingOverviewRow,
} from '../lib/meetingsOverview';
import { getAccessToken, getWorkerBase } from '../lib/r2-api';
import { makeSeekable } from '../lib/audioSeek';
import type { AppData, MeetingRecording, Note, UUID } from '../types';

/** Onder welke module valt het wissen van de audio: dezelfde poort als de server (recordingModule). */
type ModuleKey = 'calendar' | 'clients' | 'content';
const KIND_MODULE: Record<MeetingKind, ModuleKey> = { afspraak: 'calendar', gesprek: 'clients', notitie: 'content' };
const ALL_KINDS: MeetingKind[] = ['afspraak', 'gesprek', 'notitie'];
const KIND_ICON = { afspraak: Users, gesprek: Phone, notitie: StickyNote } as const;
const KIND_PLURAL: Record<MeetingKind, string> = { afspraak: 'Afspraken', gesprek: 'Telefoongesprekken', notitie: 'Notities' };

/**
 * Inhoud → Meetings (sinds 25 november): alle meetings onder elkaar in één
 * tabel, nieuwste bovenaan. Klik een meeting open voor de notulen en het
 * volledige transcript. De audio kun je wissen (per meeting of een selectie):
 * transcript en notulen blijven staan, de opslag komt vrij.
 *
 * Eerst stond een meeting alleen bij zijn afspraak in de agenda, of als
 * notitie in een map Meetings per klant. Om er een terug te vinden moest je
 * weten wanneer en bij wie hij was, en ruimte maken kon alleen door de hele
 * opname met transcript te wissen.
 */
export function MeetingsOverview({ organizationId, data, currentUserId, canWriteModule, onOpenNote }: {
  organizationId: UUID;
  data: Pick<AppData, 'clients' | 'notes'>;
  currentUserId: UUID | null;
  /** Mag deze gebruiker in die module schrijven (rol, organisatie actief, modulerecht)? */
  canWriteModule: (module: ModuleKey) => boolean;
  onOpenNote: (note: Note) => void;
}) {
  const [rows, setRows] = useState<MeetingOverviewRow[] | null>(null);
  const [sources, setSources] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [audio, setAudio] = useState<AudioFilter>('all');
  const [kinds, setKinds] = useState<Set<MeetingKind>>(() => new Set(ALL_KINDS));
  const [filterOpen, setFilterOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ id: string; up: boolean } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    // Lukt het lezen van de agenda's niet, dan geen: dan toont het overzicht
    // alleen wat zeker gedeeld is (Inhoud, gesprekken, eigen opnames).
    Promise.all([listMeetingOverview(organizationId), listReadableCalendarSourceIds(organizationId).catch(() => new Set<string>())])
      .then(([page, ids]) => { if (cancelled) return; setRows(page.rows); setMore(page.more); setSources(ids); })
      .catch((e) => { if (!cancelled) { setRows([]); setError(e instanceof Error ? e.message : 'De meetings konden niet worden geladen.'); } });
    return () => { cancelled = true; };
  }, [organizationId]);

  // Een open ⋮-menu sluit bij een klik ernaast of Escape (zoals in Inhoud).
  useEffect(() => {
    if (!menu && !filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest('.drive-pop, .drive-pop-trigger')) return;
      setMenu(null); setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); setFilterOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [menu, filterOpen]);

  const clientNames = useMemo(() => new Map(data.clients.map((c) => [c.id, c.name])), [data.clients]);
  const clientName = (id: UUID | null) => (id ? clientNames.get(id) ?? null : null);
  const notesById = useMemo(() => new Map(data.notes.map((n) => [n.id, n])), [data.notes]);

  const visible = useMemo(() => sortMeetings((rows ?? []).filter((rec) => visibleInOverview(rec, { userId: currentUserId, readableSourceIds: sources }))),
    [rows, currentUserId, sources]);
  const shown = useMemo(() => filterMeetings(visible, { query, audio, kinds }, clientName),
    // clientName leest alleen clientNames
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, query, audio, kinds, clientNames]);
  const presentKinds = useMemo(() => new Set(visible.map((rec) => meetingKind(rec))), [visible]);
  const totals = useMemo(() => audioTotals(visible), [visible]);

  const mayDelete = (rec: MeetingOverviewRow) => canDeleteAudio(rec) && canWriteModule(KIND_MODULE[meetingKind(rec)]);
  const pickable = shown.filter(mayDelete);
  const pickedRows = visible.filter((rec) => picked.has(rec.id) && mayDelete(rec));
  const pickedBytes = audioTotals(pickedRows).bytes;
  const allPicked = pickable.length > 0 && pickable.every((rec) => picked.has(rec.id));

  function togglePick(id: string) {
    setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleAll() {
    setPicked(allPicked ? new Set() : new Set(pickable.map((rec) => rec.id)));
  }
  function toggleKind(kind: MeetingKind) {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next.size ? next : new Set(ALL_KINDS);
    });
  }

  async function loadMore() {
    const last = rows?.[rows.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listMeetingOverview(organizationId, last.created_at);
      setRows((prev) => [...(prev ?? []), ...page.rows]);
      setMore(page.more);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Meer meetings laden lukte niet.');
    } finally {
      setLoadingMore(false);
    }
  }

  function patchRow(id: string, patch: Partial<MeetingOverviewRow>) {
    setRows((prev) => prev?.map((rec) => (rec.id === id ? { ...rec, ...patch } : rec)) ?? prev);
  }

  /** De audio van één of meer meetings wissen; transcript en notulen blijven staan. */
  async function deleteAudio(ids: string[]) {
    setDeleting(true);
    setError(null);
    setNotice(null);
    let freed = 0;
    let done = 0;
    const failed: string[] = [];
    // Eén voor één: het zijn er hooguit een paar honderd, en zo kan de worker
    // het bijhouden. Wat lukt, staat meteen goed in de tabel.
    for (const id of ids) {
      const rec = rows?.find((r) => r.id === id);
      try {
        const result = await deleteRecordingAudio(organizationId, id);
        freed += result.freedBytes || Number(rec?.size_bytes) || 0;
        done += 1;
        patchRow(id, { storage_key: null, size_bytes: null, audio_deleted_at: result.audioDeletedAt ?? new Date().toISOString() });
      } catch (e) {
        failed.push(`${rec ? meetingTitle(rec) : 'Meeting'}: ${e instanceof Error ? e.message : 'mislukt'}`);
      }
    }
    setPicked((prev) => { const next = new Set(prev); ids.forEach((id) => next.delete(id)); return next; });
    setDeleting(false);
    setConfirmIds(null);
    if (done) setNotice(`Audio van ${meetingCount(done)} verwijderd${freed ? `: ${formatBytes(freed)} vrij` : ''}. Transcript en notulen staan er nog.`);
    if (failed.length) setError(`Niet gelukt bij ${meetingCount(failed.length)}. ${failed.slice(0, 3).join(' · ')}`);
  }

  function openMenu(e: ReactMouseEvent<HTMLButtonElement>, id: string) {
    e.stopPropagation();
    if (menu?.id === id) { setMenu(null); return; }
    // De lijst scrolt intern: open het menu omhoog voor rijen onderin beeld.
    const scroller = e.currentTarget.closest('.odrv-scroll');
    let up = false;
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      const br = e.currentTarget.getBoundingClientRect();
      up = br.bottom > sr.top + sr.height * 0.55;
    }
    setMenu({ id, up });
    setFilterOpen(false);
  }

  const contentNoteOf = (rec: Pick<MeetingRecording, 'content_note_id' | 'note_id'>): Note | null => {
    const id = rec.content_note_id ?? rec.note_id ?? null;
    return id ? notesById.get(id) ?? null : null;
  };

  const open = openId ? visible.find((rec) => rec.id === openId) ?? null : null;
  const confirmRows = confirmIds ? visible.filter((rec) => confirmIds.includes(rec.id)) : [];
  const kindFilterOff = ALL_KINDS.some((k) => presentKinds.has(k) && !kinds.has(k));

  const emptyState = () => {
    if (visible.length === 0) {
      return <div className="drive-empty odrv-empty">
        <span className="drive-empty-ic"><AudioLines size={24} /></span>
        <strong>Nog geen meetings</strong>
        <span>Neem een meeting op bij een afspraak in de agenda. Na het uitschrijven staat hij hier, met de notulen en het volledige transcript.</span>
      </div>;
    }
    return <div className="drive-empty odrv-empty">
      <span className="drive-empty-ic"><Search size={24} /></span>
      <strong>Geen meetings gevonden</strong>
      <span>{query.trim() ? <>Niets gevonden voor “{query.trim()}”.</> : 'Geen meetings die bij dit filter passen.'}</span>
    </div>;
  };

  return <div className="odrv mtg">
    <main className="odrv-main">
      <div className="odrv-head">
        <nav className="odrv-crumbs" aria-label="Locatie"><span className="odrv-crumb-current">Meetings</span></nav>
        <label className="drive-search odrv-search">
          <Search size={14} aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Zoek op titel, klant of notulen…" autoComplete="off" aria-label="Zoeken in meetings" />
          {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
        </label>
      </div>

      <div className="odrv-cmdbar">
        <div className="bk-seg bk-seg-sm mtg-seg" role="group" aria-label="Welke meetings">
          <button type="button" className={audio === 'all' ? 'is-active' : ''} aria-pressed={audio === 'all'} onClick={() => setAudio('all')}>Alle</button>
          <button type="button" className={audio === 'with-audio' ? 'is-active' : ''} aria-pressed={audio === 'with-audio'} onClick={() => setAudio('with-audio')}>
            Met audio{totals.count ? <span className="mtg-seg-count">{totals.count}</span> : null}
          </button>
        </div>
        {presentKinds.size > 1 && <div className="drive-new-wrap">
          <button type="button" className={`odrv-tool drive-pop-trigger${kindFilterOff ? ' is-active' : ''}`} onClick={() => { setFilterOpen((o) => !o); setMenu(null); }} aria-haspopup="menu" aria-expanded={filterOpen}>
            <SlidersHorizontal size={14} /> <span className="odrv-tool-label">Soort</span> <ChevronDown size={13} />
          </button>
          {filterOpen && <div className="drive-pop" role="menu">
            <div className="drive-pop-head">Tonen in de lijst</div>
            {ALL_KINDS.filter((k) => presentKinds.has(k)).map((k) => {
              const on = kinds.has(k);
              return <button key={k} type="button" className="drive-pop-item" role="menuitemcheckbox" aria-checked={on} onClick={() => toggleKind(k)}>
                {on ? <Eye size={16} style={{ color: 'var(--accent)' }} /> : <EyeOff size={16} />} {KIND_PLURAL[k]}
              </button>;
            })}
          </div>}
        </div>}
        <div className="odrv-cmdbar-right">
          <span className="mtg-storage" title="Audio die nu in je opslag staat">
            <AudioLines size={14} aria-hidden="true" />
            {totals.count ? <>{formatBytes(totals.bytes)} <span className="mtg-storage-sub">audio</span></> : 'Geen audio'}
          </span>
        </div>
      </div>

      {(error || notice || pickedRows.length > 0) && <div className="odrv-embed-band mtg-band">
        {error && <div className="error" role="alert">{error}</div>}
        {notice && !error && <div className="mtg-notice" role="status"><Check size={14} /> {notice}<button type="button" className="mtg-notice-close" onClick={() => setNotice(null)} aria-label="Sluiten"><X size={13} /></button></div>}
        {pickedRows.length > 0 && <div className="mtg-selbar" role="region" aria-label="Selectie">
          <span className="mtg-selbar-text"><strong>{meetingCount(pickedRows.length)}</strong> gekozen · {formatBytes(pickedBytes)} audio</span>
          <Button variant="danger" disabled={deleting} onClick={() => setConfirmIds(pickedRows.map((rec) => rec.id))}><VolumeX size={14} /> Audio verwijderen</Button>
          <button type="button" className="mtg-selbar-clear" onClick={() => setPicked(new Set())} aria-label="Selectie wissen"><X size={15} /></button>
        </div>}
      </div>}

      <div className="odrv-scroll">
        {rows === null
          ? <div className="mtg-loading"><Skeleton lines={6} /></div>
          : shown.length === 0
            ? emptyState()
            : <div className="mtg-table" role="table" aria-label="Meetings" aria-rowcount={shown.length + 1}>
                <div className="mtg-tr mtg-thead" role="row">
                  <span className="mtg-td-check" role="columnheader">
                    {pickable.length > 0 && <input type="checkbox" className="mtg-check is-always" checked={allPicked} onChange={toggleAll}
                      aria-label={allPicked ? 'Niets selecteren' : 'Alle meetings met audio selecteren'} />}
                  </span>
                  <span className="mtg-th" role="columnheader">Meeting</span>
                  <span className="mtg-th mtg-td-day" role="columnheader">Datum</span>
                  <span className="mtg-th mtg-td-client" role="columnheader">Klant</span>
                  <span className="mtg-th mtg-td-dur" role="columnheader">Duur</span>
                  <span className="mtg-th mtg-td-notulen" role="columnheader">Notulen</span>
                  <span className="mtg-th mtg-td-audio" role="columnheader">Audio</span>
                  <span className="mtg-td-act" role="columnheader"><span className="mtg-sr">Acties</span></span>
                </div>
                {shown.map((rec) => {
                  const kind = meetingKind(rec);
                  const Icon = KIND_ICON[kind];
                  const title = meetingTitle(rec);
                  const day = shortDay(meetingDay(rec));
                  const client = clientName(rec.client_id);
                  const duration = durationShort(rec.duration_seconds);
                  const state = notulenState(rec);
                  const deletable = mayDelete(rec);
                  const isPicked = picked.has(rec.id) && deletable;
                  const note = contentNoteOf(rec);
                  const preview = rec.summary_text?.replace(/\s+/g, ' ').trim() ?? '';
                  return <div
                    key={rec.id}
                    className={`mtg-tr mtg-row${isPicked ? ' is-picked' : ''}`}
                    role="row"
                    tabIndex={0}
                    data-meeting-id={rec.id}
                    onClick={() => setOpenId(rec.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(rec.id); } }}
                  >
                    <span className="mtg-td-check" role="cell" onClick={(e) => e.stopPropagation()}>
                      {deletable
                        ? <input type="checkbox" className="mtg-check" checked={isPicked} onChange={() => togglePick(rec.id)} aria-label={`${title} selecteren`} />
                        : null}
                      <Icon size={17} className="mtg-kind-ic" aria-hidden="true" />
                    </span>
                    <span className="mtg-td-title" role="cell">
                      <span className="mtg-title" title={title}>{title}</span>
                      <span className="mtg-sub">
                        <span className="mtg-sub-mobile">{[day, client, duration].filter(Boolean).join(' · ')}</span>
                        <span className="mtg-sub-desktop">{KIND_LABEL[kind]}{preview ? ` · ${preview}` : ''}</span>
                      </span>
                    </span>
                    <span className="mtg-td mtg-td-day" role="cell">{day}</span>
                    <span className="mtg-td mtg-td-client" role="cell" title={client ?? undefined}>{client ?? '—'}</span>
                    <span className="mtg-td mtg-td-dur" role="cell">{duration || '—'}</span>
                    <span className="mtg-td mtg-td-notulen" role="cell"><span className={`mtg-pill is-${state.tone}`}>{state.label}</span></span>
                    <span className={`mtg-td mtg-td-audio${hasAudio(rec) ? '' : ' is-gone'}`} role="cell">{audioLabel(rec)}</span>
                    <span className="mtg-td-act" role="cell" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      <div className="drive-kebab-wrap">
                        <button type="button" className={`drive-kebab drive-pop-trigger${menu?.id === rec.id ? ' is-open' : ''}`} aria-label={`Acties voor ${title}`} disabled={deleting} onClick={(e) => openMenu(e, rec.id)}>
                          <MoreVertical size={16} />
                        </button>
                        {menu?.id === rec.id && <div className={`drive-pop is-right${menu.up ? ' is-up' : ''}`} role="menu">
                          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); setOpenId(rec.id); }}><FileText size={16} /> Notulen en transcript</button>
                          {note && <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenu(null); onOpenNote(note); }}><StickyNote size={16} /> Openen in Inhoud</button>}
                          {deletable && <>
                            <div className="drive-pop-sep" />
                            <button type="button" className="drive-pop-item danger" role="menuitem" onClick={() => { setMenu(null); setConfirmIds([rec.id]); }}><VolumeX size={16} /> Audio verwijderen</button>
                          </>}
                        </div>}
                      </div>
                    </span>
                  </div>;
                })}
              </div>}
        {rows !== null && more && <div className="mtg-more">
          <Button variant="ghost" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <><Loader2 size={14} className="spin" /> Laden…</> : 'Oudere meetings laden'}
          </Button>
        </div>}
      </div>
    </main>

    {open && <MeetingDetail
      key={open.id}
      organizationId={organizationId}
      row={open}
      clientName={clientName(open.client_id)}
      note={contentNoteOf(open)}
      canDelete={mayDelete(open)}
      onClose={() => setOpenId(null)}
      onOpenNote={(note) => { setOpenId(null); onOpenNote(note); }}
      onDeleteAudio={() => setConfirmIds([open.id])}
    />}

    {confirmIds && confirmRows.length > 0 && <Modal
      title="Audio verwijderen?"
      className="mtg-confirm-modal"
      onClose={() => { if (!deleting) setConfirmIds(null); }}
      footer={<>
        <Button variant="ghost" disabled={deleting} onClick={() => setConfirmIds(null)}>Annuleren</Button>
        <Button variant="danger" disabled={deleting} onClick={() => void deleteAudio(confirmRows.map((rec) => rec.id))}>
          {deleting ? <><Loader2 size={14} className="spin" /> Bezig…</> : <><VolumeX size={14} /> Audio verwijderen</>}
        </Button>
      </>}
    >
      <p className="mtg-confirm-text">
        {confirmRows.length === 1
          ? <>De audio van <strong>{meetingTitle(confirmRows[0])}</strong> gaat weg{confirmRows[0].size_bytes ? ` (${formatBytes(confirmRows[0].size_bytes)})` : ''}.</>
          : <>De audio van <strong>{meetingCount(confirmRows.length)}</strong> gaat weg ({formatBytes(audioTotals(confirmRows).bytes)}).</>}
      </p>
      <p className="mtg-confirm-text">Het transcript en de notulen blijven staan. Terugluisteren kan daarna niet meer, en dit kun je niet ongedaan maken.</p>
    </Modal>}
  </div>;
}

/**
 * Eén meeting: de notulen, het volledige transcript en de audio. Het
 * transcript laadt pas hier; de tabel haalt het niet op.
 */
function MeetingDetail({ organizationId, row, clientName, note, canDelete, onClose, onOpenNote, onDeleteAudio }: {
  organizationId: UUID;
  row: MeetingOverviewRow;
  clientName: string | null;
  note: Note | null;
  canDelete: boolean;
  onClose: () => void;
  onOpenNote: (note: Note) => void;
  onDeleteAudio: () => void;
}) {
  const [full, setFull] = useState<MeetingRecording | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<'notulen' | 'transcript'>('notulen');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRecording(row.id)
      .then((rec) => { if (!cancelled) { setFull(rec); if (rec && !rec.summary_json && !rec.summary_text?.trim() && rec.transcript_text?.trim()) setView('transcript'); } })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof Error ? e.message : 'De meeting kon niet worden geladen.'); });
    return () => { cancelled = true; };
  }, [row.id]);

  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  // De audio is net gewist (in de bevestiging hieronder): de speler weg.
  useEffect(() => {
    if (row.storage_key || !urlRef.current) return;
    URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setAudioUrl(null);
  }, [row.storage_key]);

  async function loadAudio() {
    if (!row.storage_key || audioUrl) return;
    setAudioState('loading');
    try {
      const base = getWorkerBase();
      const token = await getAccessToken();
      const res = await fetch(`${base}/file/${encodeURIComponent(row.storage_key)}`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      urlRef.current = url;
      setAudioUrl(url);
      setAudioState('idle');
    } catch {
      setAudioState('failed');
    }
  }

  const kind = meetingKind(row);
  const title = meetingTitle(row);
  const transcript = full?.transcript_text?.trim() ?? '';
  const summary = full?.summary_json ?? null;
  const summaryText = full?.summary_text?.trim() ?? row.summary_text?.trim() ?? '';
  const deletedOn = row.audio_deleted_at ? new Date(row.audio_deleted_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const facts: [string, string][] = [
    ['Datum', shortDay(meetingDay(row))],
    ['Soort', KIND_LABEL[kind]],
    ...(clientName ? [['Klant', clientName] as [string, string]] : []),
    ...(row.duration_seconds ? [['Duur', durationShort(row.duration_seconds)] as [string, string]] : []),
    ['Audio', row.storage_key ? (row.size_bytes ? formatBytes(row.size_bytes) : 'Bewaard') : deletedOn ? `Verwijderd op ${deletedOn}` : 'Geen'],
  ];

  return <Modal
    title={title}
    className="mtg-detail-modal"
    onClose={onClose}
    footer={<>
      {note && <Button variant="ghost" onClick={() => onOpenNote(note)}><StickyNote size={14} /> Openen in Inhoud</Button>}
      {canDelete && <Button variant="danger" onClick={onDeleteAudio}><VolumeX size={14} /> Audio verwijderen</Button>}
      <Button onClick={onClose}>Sluiten</Button>
    </>}
  >
    <dl className="mtg-facts">
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>

    {row.storage_key && <div className="mtg-audio">
      {audioUrl
        // Zonder makeSeekable blijft de tijdlijn dood: een opname uit de browser
        // heeft geen duur (zie MeetingRecorder).
        ? <audio controls preload="metadata" src={audioUrl} onLoadedMetadata={(e) => { void makeSeekable(e.currentTarget); }} />
        : <Button variant="ghost" disabled={audioState === 'loading'} onClick={() => void loadAudio()}>
            {audioState === 'loading' ? <><Loader2 size={14} className="spin" /> Audio laden…</> : <><Play size={14} /> Beluister opname</>}
          </Button>}
      {audioState === 'failed' && <span className="mtg-audio-error">De audio kon niet worden geladen.</span>}
    </div>}

    {loadError
      ? <div className="error" role="alert">{loadError}</div>
      : !full
        ? <Skeleton lines={5} />
        : <>
            <div className="bk-seg bk-seg-sm mtg-view-switch" role="tablist" aria-label="Wat je van de meeting ziet">
              <button type="button" role="tab" id="mtg-tab-notulen" aria-controls="mtg-panel-notulen" aria-selected={view === 'notulen'} className={view === 'notulen' ? 'is-active' : ''} onClick={() => setView('notulen')}>
                <FileText size={14} /><span>Notulen</span>
              </button>
              <button type="button" role="tab" id="mtg-tab-transcript" aria-controls="mtg-panel-transcript" aria-selected={view === 'transcript'} className={view === 'transcript' ? 'is-active' : ''} onClick={() => setView('transcript')}>
                <Users size={14} /><span>Volledig transcript</span>
              </button>
            </div>
            {view === 'notulen'
              ? <div id="mtg-panel-notulen" role="tabpanel" aria-labelledby="mtg-tab-notulen" className="mtg-panel">
                  {summary
                    ? <Notulen summary={summary} />
                    : summaryText
                      ? <p className="mtg-notulen-text">{summaryText}</p>
                      : <p className="mtg-empty-line">{notulenState(full).tone === 'busy' ? 'De notulen worden nog gemaakt.' : 'Er zijn geen notulen van deze meeting.'}</p>}
                </div>
              : <div id="mtg-panel-transcript" role="tabpanel" aria-labelledby="mtg-tab-transcript" className="mtg-panel meeting-note-transcript">
                  {transcript ? <TranscriptLines text={transcript} /> : <p className="mtg-empty-line">Er is (nog) geen transcript van deze meeting.</p>}
                </div>}
          </>}
  </Modal>;
}

/** De notulen zoals Claude ze maakte: samenvatting en de vier lijsten. Tekst, nooit opmaak. */
function Notulen({ summary }: { summary: NonNullable<MeetingRecording['summary_json']> }) {
  const blocks: [string, string[] | undefined][] = [
    ['Besproken', summary.besproken], ['Besluiten', summary.besluiten],
    ['Actiepunten', summary.actiepunten], ['Vervolgafspraken', summary.vervolgafspraken],
  ];
  return <div className="mtg-notulen">
    {summary.samenvatting && <p className="mtg-notulen-text">{summary.samenvatting}</p>}
    {blocks.filter(([, items]) => items?.length).map(([label, items]) => <section key={label}>
      <h4>{label}</h4>
      <ul>{items!.map((item, i) => <li key={i}>{item}</li>)}</ul>
    </section>)}
  </div>;
}
