import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, PenLine, Trash2 } from 'lucide-react';
import { Button } from './Ui';
import { InkCanvas, useInkTheme } from './InkCanvas';
import { loadNoteHandwriting, saveNoteHandwriting } from '../lib/repository';
import { createInkDocument, inkPageCount, inkSizeIssue, inkThumbnailDataUrl, isInkEmpty, parseInkDocument, type InkDocument } from '../lib/ink';
import type { AppData, Note, NoteHandwritingSummary, UUID } from '../types';

/**
 * Handschrift bij notities — de laag tussen de canvas-editor en de rest van de
 * app: laden en (automatisch) opslaan bij een bestaande notitie, meesturen bij
 * een nieuwe, miniaturen op kaartjes, en de schermvullende schrijfoverlay die
 * de agenda opent.
 */

// ── Kleine cache van geladen inkt, zodat kaartjes en editor niet steeds opnieuw ophalen ──

const inkCache = new Map<string, InkDocument | null>();
const inflight = new Map<string, Promise<InkDocument | null>>();

function cacheKey(noteId: UUID, version: string | null): string {
  return `${noteId}@${version ?? ''}`;
}

/** Laadt het inktdocument van een notitie; `version` (updated_at) maakt de cache vanzelf oud na een wijziging. */
export function fetchInkDocument(organizationId: UUID, noteId: UUID, version: string | null, force = false): Promise<InkDocument | null> {
  const key = cacheKey(noteId, version);
  if (!force && inkCache.has(key)) return Promise.resolve(inkCache.get(key) ?? null);
  const running = inflight.get(key);
  if (running) return running;
  const promise = loadNoteHandwriting(organizationId, noteId)
    .then(row => {
      const doc = row ? parseInkDocument(row.pages, row.paper) : null;
      inkCache.set(key, doc);
      return doc;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function primeInkCache(noteId: UUID, version: string | null, doc: InkDocument | null): void {
  inkCache.set(cacheKey(noteId, version), doc);
}

export function noteHandwritingSummary(data: Pick<AppData, 'noteHandwriting'>, noteId: UUID): NoteHandwritingSummary | null {
  return data.noteHandwriting.find(row => row.note_id === noteId) ?? null;
}

export function handwritingLabel(summary: NoteHandwritingSummary): string {
  const pages = Math.max(1, summary.page_count);
  return pages === 1 ? 'Handschrift' : `Handschrift · ${pages} pagina's`;
}

function clockLabel(date: Date): string {
  return date.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

// ── Miniatuur op kaartjes ───────────────────────────────────────────────────

/**
 * Kleine afbeelding van de eerste beschreven pagina. Laadt de inkt pas als het
 * kaartje er is, en tekent hem in het thema van het scherm.
 */
export function InkThumbnail({ note, summary, width = 220, className = '' }: { note: Pick<Note, 'id' | 'organization_id'>; summary: NoteHandwritingSummary; width?: number; className?: string }) {
  const theme = useInkTheme();
  const [doc, setDoc] = useState<InkDocument | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setDoc(undefined);
    fetchInkDocument(note.organization_id, note.id, summary.updated_at)
      .then(loaded => { if (active) setDoc(loaded); })
      .catch(() => { if (active) setDoc(null); });
    return () => { active = false; };
  }, [note.organization_id, note.id, summary.updated_at]);

  const url = useMemo(() => (doc ? inkThumbnailDataUrl(doc, theme, width * 2) : null), [doc, theme, width]);

  return (
    <div className={`ink-thumb ${className}`.trim()} style={{ width }} aria-label={handwritingLabel(summary)}>
      {url
        ? <img src={url} alt="" width={width} />
        : <span className={`ink-thumb-placeholder${doc === undefined ? ' is-loading' : ''}`}><PenLine size={14} /></span>}
    </div>
  );
}

// ── Sectie in het notitieformulier ──────────────────────────────────────────

type SaveState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'error'; message: string };

const AUTOSAVE_DELAY_MS = 900;

/**
 * "Handschrift" onder de getypte inhoud van een notitie.
 *
 * - Bestaande notitie: laadt de inkt, en slaat elke wijziging vanzelf op
 *   (kort na de laatste streek) — schrijven op een tablet moet voelen als
 *   papier, zonder aan Opslaan te denken. De knop Opslaan van het formulier
 *   neemt de laatste stand ook mee, dus er gaat nooit iets verloren.
 * - Nieuwe notitie: de inkt reist mee in het formulier en wordt na het
 *   aanmaken van de notitie in één keer weggeschreven.
 *
 * `value` is de formulierwaarde `_ink`: undefined = niets gedaan, null =
 * handschrift weggehaald, document = opslaan.
 */
export function NoteInkSection({ organizationId, noteId, noteTitle, summary, value, onChange, disabled, onSaved }: {
  organizationId: UUID;
  noteId: UUID | null;
  noteTitle: string;
  summary: NoteHandwritingSummary | null;
  value: InkDocument | null | undefined;
  onChange: (doc: InkDocument | null) => void;
  disabled: boolean;
  /** Na elke automatische opslag: de samenvatting (of null als alles gewist is), voor de badges elders in de app. */
  onSaved?: (summary: NoteHandwritingSummary | null) => void;
}) {
  const hasStoredInk = Boolean(noteId && summary);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [started, setStarted] = useState(false);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef<InkDocument | null>(null);
  const dirtyRef = useRef(false);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  // Bestaande inkt ophalen zodra het formulier opent.
  useEffect(() => {
    if (!noteId || !summary || value !== undefined) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    fetchInkDocument(organizationId, noteId, summary.updated_at, true)
      .then(doc => {
        if (!active) return;
        onChange(doc ?? createInkDocument(summary.paper));
      })
      .catch(err => { if (active) setLoadError(err instanceof Error ? err.message : 'Handschrift laden mislukt.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // `onChange` verandert per render van het formulier; alleen opnieuw laden bij een andere notitie.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, noteId, summary?.updated_at, value === undefined]);

  const persist = useCallback(async (doc: InkDocument) => {
    if (!noteId) return;
    const issue = inkSizeIssue(doc);
    if (issue) { setSaveState({ kind: 'error', message: issue }); return; }
    setSaveState({ kind: 'saving' });
    try {
      const saved = await saveNoteHandwriting(organizationId, noteId, doc);
      primeInkCache(noteId, saved?.updated_at ?? null, isInkEmpty(doc) ? null : doc);
      dirtyRef.current = false;
      setSaveState({ kind: 'saved', at: new Date() });
      onSavedRef.current?.(saved);
    } catch (err) {
      setSaveState({ kind: 'error', message: err instanceof Error ? err.message : 'Opslaan mislukt.' });
    }
  }, [organizationId, noteId]);

  const scheduleSave = useCallback((doc: InkDocument) => {
    latestRef.current = doc;
    if (!noteId) return;
    dirtyRef.current = true;
    setSaveState({ kind: 'pending' });
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (latestRef.current) void persist(latestRef.current);
    }, AUTOSAVE_DELAY_MS);
  }, [noteId, persist]);

  // Formulier dicht terwijl er nog een opslag klaarstaat: meteen wegschrijven.
  useEffect(() => () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
      if (dirtyRef.current && latestRef.current) void persist(latestRef.current);
    }
  }, [persist]);

  const handleCanvasChange = useCallback((doc: InkDocument) => {
    onChange(doc);
    scheduleSave(doc);
  }, [onChange, scheduleSave]);

  function start() {
    const doc = createInkDocument('lined');
    setStarted(true);
    onChange(doc);
  }

  function remove() {
    if (!window.confirm('Het handschrift bij deze notitie verwijderen? De getypte inhoud blijft staan.')) return;
    setStarted(false);
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    onChange(null);
    if (noteId && summary) void persist(createInkDocument('lined'));
  }

  const expanded = Boolean(value) || started || hasStoredInk;

  let status: ReactNode = null;
  if (!noteId) status = <span className="ink-status-muted">Wordt bewaard bij Opslaan</span>;
  else if (saveState.kind === 'saving' || saveState.kind === 'pending') status = <span className="ink-status-muted"><Loader2 size={12} className="ink-spin" /> Opslaan…</span>;
  else if (saveState.kind === 'saved') status = <span className="ink-status-ok"><Check size={12} /> Opgeslagen {clockLabel(saveState.at)}</span>;
  else if (saveState.kind === 'error') status = <span className="ink-status-error">{saveState.message}</span>;

  return (
    <section className="note-ink-section" aria-label="Handschrift">
      <div className="note-ink-head">
        <div>
          <span className="note-ink-kicker">Handschrift</span>
          <h4>Schrijven met pen</h4>
          <p>{expanded && value ? `${inkPageCount(value) || 1} pagina${inkPageCount(value) > 1 ? "'s" : ''} · pen tekent, vinger scrolt` : 'Aantekeningen met een pen op je tablet, alsof je op papier schrijft. Ook met muis of vinger.'}</p>
        </div>
        {!expanded && !disabled && (
          <Button type="button" variant="primary" className="note-ink-start" onClick={start}><PenLine size={15} /> Schrijven met pen</Button>
        )}
        {expanded && value && !disabled && (
          <button type="button" className="note-ink-remove" onClick={remove}><Trash2 size={13} /> Handschrift verwijderen</button>
        )}
      </div>
      {loadError && <div className="note-ink-error">{loadError}</div>}
      {expanded && (loading || (!value && !loadError)) && (
        <div className="note-ink-loading"><Loader2 size={16} className="ink-spin" /> Handschrift laden…</div>
      )}
      {expanded && value && (
        <InkCanvas
          value={value}
          onChange={handleCanvasChange}
          readOnly={disabled}
          title={noteTitle}
          exportName={noteTitle}
          status={status}
        />
      )}
    </section>
  );
}

// ── Schermvullend schrijven vanuit de agenda ────────────────────────────────

/**
 * Overlay die meteen een leeg vel opent — vanuit een agenda-item, zonder eerst
 * een formulier. Opslaan maakt de notitie (mét koppeling aan de afspraak) en
 * bewaart het handschrift; dat doet de aanroeper in `onSave`.
 */
export function InkComposer({ defaultTitle, subtitle, onCancel, onSave }: {
  defaultTitle: string;
  subtitle?: string;
  onCancel: () => void;
  onSave: (doc: InkDocument, title: string) => Promise<void>;
}) {
  const [doc, setDoc] = useState<InkDocument>(() => createInkDocument('lined'));
  const [title, setTitle] = useState(defaultTitle);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const empty = isInkEmpty(doc);

  const cancel = useCallback(() => {
    if (!isInkEmpty(docRef.current) && !window.confirm('Dit handschrift is nog niet opgeslagen. Toch sluiten?')) return;
    onCancel();
  }, [onCancel]);

  async function save() {
    if (saving) return;
    if (isInkEmpty(docRef.current)) { setError('Schrijf eerst iets op het vel.'); return; }
    const issue = inkSizeIssue(docRef.current);
    if (issue) { setError(issue); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave(docRef.current, title.trim() || defaultTitle);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Opslaan mislukt.');
      setSaving(false);
    }
  }

  useEffect(() => {
    document.body.classList.add('ink-sheet-open');
    // In de capture-fase én met stopPropagation: de agenda eronder sluit op
    // Escape haar paneel, en daarmee zou deze overlay — met het handschrift —
    // ongevraagd verdwijnen.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('ink-sheet-open');
    };
  }, [cancel]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="ink-sheet-backdrop ink-composer-backdrop" role="dialog" aria-modal="true" aria-label="Handgeschreven notitie">
      <div className="ink-composer">
        <header className="ink-composer-head">
          <div className="ink-composer-title">
            <span className="ink-sheet-kicker">Handgeschreven notitie{subtitle ? ` · ${subtitle}` : ''}</span>
            <input className="form-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Titel van de notitie" aria-label="Titel van de notitie" />
          </div>
          <div className="ink-composer-actions">
            {error && <span className="ink-composer-error" role="alert">{error}</span>}
            <Button type="button" variant="ghost" onClick={cancel} disabled={saving}>Annuleren</Button>
            <Button type="button" variant="primary" onClick={() => void save()} disabled={saving || empty}>{saving ? 'Opslaan…' : 'Opslaan bij afspraak'}</Button>
          </div>
        </header>
        <InkCanvas value={doc} onChange={setDoc} title={title} exportName={title} fit="contain" allowSheet={false} />
      </div>
    </div>,
    document.body,
  );
}
