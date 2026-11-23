import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Cloud, ExternalLink, FileText, Folder, Info, Loader2, RotateCcw, Search, X } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Ui';
import { fmtBytes } from './DriveGlyphs';
import { cloudProviderLabel, deletionStatusText, rememberCloudDrivePending, type CloudDeletion } from '../lib/cloudDrive';
import {
  browseOneDrive, disconnectCloudDrive, dismissCloudDeletion, getCloudDriveAuthUrl, getGooglePickerToken,
  linkCloudFiles, loadCloudDriveStatus, retryCloudDeletion,
  type CloudDriveConnection, type CloudDriveStatus, type GooglePickerToken, type LinkResult, type OneDriveItem,
} from '../lib/cloudDrive-api';
import type { CloudDriveProvider, UUID } from '../types';

/**
 * "+ Nieuw → Uit Google Drive / Uit OneDrive" in een dossiermap.
 *
 * - Nog niet gekoppeld: uitleg en de knop koppelen. Daarna kom je terug in
 *   deze map, met dit venster open (rememberCloudDrivePending).
 * - Google: de kiezer van Google zelf, in een eigen kader (/drive-kiezer.html).
 *   Met het recht drive.file ziet ResoFly alleen wat je daar aanwijst.
 * - OneDrive: een lijst van je OneDrive die ResoFly zelf toont; het token blijft
 *   op de server.
 * - Onderaan wat er nog niet uit Drive of OneDrive weg is, met opnieuw proberen.
 *
 * Wat je kiest, wordt een verwijzing in de map. Verwijder je hem in ResoFly,
 * dan gaat het bestand in Drive of OneDrive naar de prullenbak. Dat staat er
 * bij het koppelen en bij het kiezen bij, want het is de afspraak.
 */

type TargetFolder = { id: UUID; name: string; clientId: UUID; projectId: UUID | null };

const MAX_PICK = 50;

export function CloudDriveDialog({
  organizationId, provider, folder, onClose, onLinked,
}: {
  organizationId: UUID;
  provider: CloudDriveProvider;
  folder: TargetFolder;
  onClose: () => void;
  /** Er staan nieuwe bestanden in de map: ververs de lijst. */
  onLinked: () => void;
}) {
  const label = cloudProviderLabel(provider);
  const [status, setStatus] = useState<CloudDriveStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [picker, setPicker] = useState<GooglePickerToken | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try { setStatus(await loadCloudDriveStatus(organizationId)); }
    catch (e) { setLoadError(e instanceof Error ? e.message : 'Laden mislukt.'); }
  }, [organizationId]);

  useEffect(() => { void reload(); }, [reload]);

  const connections = (status?.connections ?? []).filter(c => c.provider === provider);
  const active = connections.find(c => c.status === 'active') ?? null;
  const stale = active ? null : connections.find(c => c.status !== 'revoked') ?? null;
  const configured = status?.providers[provider]?.configured ?? false;
  const deletions = (status?.deletions ?? []).filter(d => d.provider === provider);

  async function connect(connection: CloudDriveConnection | null) {
    setBusy(true); setError(null);
    try {
      rememberCloudDrivePending({ provider, organizationId, clientId: folder.clientId, projectId: folder.projectId, folderId: folder.id });
      const url = await getCloudDriveAuthUrl(organizationId, provider, window.location.href, connection?.account ?? null);
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Koppelen lukte niet.');
      setBusy(false);
    }
  }

  async function disconnect(connection: CloudDriveConnection) {
    const files = connection.linkedFiles;
    const warning = files
      ? `\n\nEr ${files === 1 ? 'staat 1 bestand' : `staan ${files} bestanden`} uit ${label} in ResoFly. Die blijven staan, maar verwijder je ze daarna in ResoFly, dan blijven ze in ${label} staan.`
      : '';
    if (!window.confirm(`${label} (${connection.account ?? 'dit account'}) ontkoppelen?${warning}`)) return;
    setBusy(true); setError(null);
    try { await disconnectCloudDrive(organizationId, connection.id); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Ontkoppelen lukte niet.'); }
    finally { setBusy(false); }
  }

  async function link(files: Array<{ id: string; driveId?: string | null }>) {
    if (!files.length) return;
    setBusy(true); setError(null);
    try {
      const done = await linkCloudFiles(organizationId, provider, folder.id, files);
      onLinked();
      if (done.skipped.length === 0 && done.notDeletable.length === 0) { onClose(); return; }
      setResult(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toevoegen lukte niet.');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function openGooglePicker() {
    setBusy(true); setError(null);
    try { setPicker(await getGooglePickerToken(organizationId)); }
    catch (e) { setError(e instanceof Error ? e.message : 'De kiezer van Google opende niet.'); await reload(); }
    finally { setBusy(false); }
  }

  async function retry(d: CloudDeletion) {
    setBusy(true); setError(null);
    try {
      const res = await retryCloudDeletion(organizationId, d.id);
      setStatus(s => s ? { ...s, deletions: res.deletions } : s);
    } catch (e) { setError(e instanceof Error ? e.message : 'Opnieuw proberen lukte niet.'); }
    finally { setBusy(false); }
  }

  async function dismiss(d: CloudDeletion) {
    if (!window.confirm(`"${d.name}" in ${label} laten staan? ResoFly probeert het dan niet meer weg te gooien.`)) return;
    setBusy(true); setError(null);
    try {
      const res = await dismissCloudDeletion(organizationId, d.id);
      setStatus(s => s ? { ...s, deletions: res.deletions } : s);
    } catch (e) { setError(e instanceof Error ? e.message : 'Dat lukte niet.'); }
    finally { setBusy(false); }
  }

  const deleteNote = <p className="cloud-note"><Info size={14} aria-hidden="true" /><span>
    Wat je kiest, blijft in je {label} staan en opent daar. Verwijder je het later in ResoFly, dan gaat het in {label} naar de prullenbak (daar kun je het nog terugzetten).
  </span></p>;

  let body: ReactNode;
  if (!status && !loadError) {
    body = <div className="cloud-loading"><Loader2 size={18} className="spin" /> Even kijken of {label} al gekoppeld is…</div>;
  } else if (loadError) {
    body = <div className="error">{loadError} <button type="button" className="cloud-link" onClick={() => void reload()}>Opnieuw</button></div>;
  } else if (result) {
    body = <LinkSummary result={result} label={label} folderName={folder.name} />;
  } else if (!configured) {
    body = <p className="mv-lede">{label} is op deze omgeving nog niet ingericht. De beheerder van ResoFly zet dat aan (zie <em>docs/setup/DRIVE_ONEDRIVE_SETUP.md</em>).</p>;
  } else if (!active) {
    body = <>
      <p className="mv-lede">
        {stale
          ? <>Je koppeling met {label}{stale.account ? <> (<strong>{stale.account}</strong>)</> : null} is verlopen of werkt niet meer. Koppel opnieuw om verder te gaan.</>
          : provider === 'google'
            ? <>Koppel je Google Drive. ResoFly ziet daarna alleen de bestanden die je zelf in de kiezer van Google aanwijst, niet de rest van je Drive.</>
            : <>Koppel je OneDrive. Daarna kies je hier bestanden uit je OneDrive en zet je ze in deze map.</>}
      </p>
      {stale?.lastError && <p className="cloud-muted">{stale.lastError}</p>}
      {deleteNote}
    </>;
  } else if (provider === 'google') {
    body = <>
      <CloudAccount connection={active} label={label} busy={busy} onDisconnect={() => void disconnect(active)} />
      <p className="mv-lede">Kies in Google Drive de bestanden voor de map <strong>{folder.name}</strong>. Je kunt er meer tegelijk kiezen, ook uit gedeelde Drives.</p>
      {deleteNote}
    </>;
  } else {
    body = <>
      <CloudAccount connection={active} label={label} busy={busy} onDisconnect={() => void disconnect(active)} />
      <OneDriveBrowser organizationId={organizationId} folderName={folder.name} busy={busy} onAdd={files => void link(files)} />
      {deleteNote}
    </>;
  }

  const footer = result
    ? <Button type="button" variant="primary" onClick={onClose}>Klaar</Button>
    : status && configured && !active
      ? <>
          <Button type="button" onClick={onClose}>Annuleren</Button>
          <Button type="button" variant="primary" disabled={busy} onClick={() => void connect(stale)}>{busy ? 'Even geduld…' : stale ? 'Opnieuw koppelen' : `${label} koppelen`}</Button>
        </>
      : status && configured && active && provider === 'google'
        ? <>
            <Button type="button" onClick={onClose}>Annuleren</Button>
            <Button type="button" variant="primary" disabled={busy} onClick={() => void openGooglePicker()}>{busy ? 'Even geduld…' : 'Kiezen in Google Drive'}</Button>
          </>
        : null;

  return <>
    <Modal title={`Uit ${label}`} className="move-modal cloud-modal" onClose={onClose} footer={footer ?? undefined}>
      {error && <div className="error">{error}</div>}
      {body}
      {deletions.length > 0 && !result && <DeletionList deletions={deletions} label={label} busy={busy} onRetry={d => void retry(d)} onDismiss={d => void dismiss(d)} />}
    </Modal>
    {picker && <GooglePickerFrame
      token={picker}
      onPicked={files => { setPicker(null); void link(files); }}
      onCancel={() => setPicker(null)}
      onError={message => { setPicker(null); setError(message); }}
    />}
  </>;
}

function CloudAccount({ connection, label, busy, onDisconnect }: { connection: CloudDriveConnection; label: string; busy: boolean; onDisconnect: () => void }) {
  return <div className="cloud-account">
    <Cloud size={15} aria-hidden="true" />
    <span>Gekoppeld met {label}{connection.account ? <> als <strong>{connection.account}</strong></> : null}</span>
    <button type="button" className="cloud-link" disabled={busy} onClick={onDisconnect}>Ontkoppelen</button>
  </div>;
}

function LinkSummary({ result, label, folderName }: { result: LinkResult; label: string; folderName: string }) {
  const added = result.added.length;
  return <div className="cloud-result">
    {added > 0 && <p className="success">{added === 1 ? '1 bestand staat' : `${added} bestanden staan`} nu in {folderName}.</p>}
    {result.skipped.length > 0 && <>
      <p className="cloud-result-head"><AlertTriangle size={14} aria-hidden="true" /> {result.skipped.length === 1 ? 'Eén bestand' : `${result.skipped.length} bestanden`} niet toegevoegd:</p>
      <ul className="cloud-result-list">{result.skipped.map((s, i) => <li key={`${s.name}-${i}`}><strong>{s.name}</strong>: {s.reason}</li>)}</ul>
    </>}
    {result.notDeletable.length > 0 && <>
      <p className="cloud-result-head"><Info size={14} aria-hidden="true" /> Deze kun je in {label} niet weggooien (je bent niet de eigenaar). Verwijder je ze in ResoFly, dan blijven ze in {label} staan:</p>
      <ul className="cloud-result-list">{result.notDeletable.map((name, i) => <li key={`${name}-${i}`}>{name}</li>)}</ul>
    </>}
  </div>;
}

function DeletionList({ deletions, label, busy, onRetry, onDismiss }: {
  deletions: CloudDeletion[]; label: string; busy: boolean; onRetry: (d: CloudDeletion) => void; onDismiss: (d: CloudDeletion) => void;
}) {
  return <section className="cloud-deletions" aria-label={`Nog niet uit ${label} verwijderd`}>
    <h4>Nog niet uit {label} verwijderd</h4>
    <p className="cloud-muted">Je verwijderde deze in ResoFly. In {label} staan ze nog.</p>
    <ul>
      {deletions.map(d => <li key={d.id} className="cloud-del-row">
        <FileText size={15} aria-hidden="true" />
        <span className="cloud-del-text"><strong>{d.name || 'Bestand'}</strong><span>{deletionStatusText(d)}</span></span>
        {d.status === 'failed' && <span className="cloud-del-actions">
          <button type="button" className="cloud-link" disabled={busy} onClick={() => onRetry(d)}><RotateCcw size={13} /> Opnieuw</button>
          <button type="button" className="cloud-link" disabled={busy} onClick={() => onDismiss(d)}>Laten staan</button>
        </span>}
      </li>)}
    </ul>
  </section>;
}

// ── OneDrive: een kleine verkenner in het venster ────────────────────────────

type Crumb = { id: string | null; name: string };

function OneDriveBrowser({ organizationId, folderName, busy, onAdd }: {
  organizationId: UUID; folderName: string; busy: boolean; onAdd: (files: Array<{ id: string; driveId: string | null }>) => void;
}) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: null, name: 'Mijn bestanden' }]);
  const [items, setItems] = useState<OneDriveItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Map<string, OneDriveItem>>(new Map());
  const request = useRef(0);

  const here = crumbs[crumbs.length - 1];

  const load = useCallback(async (opts: { folderId: string | null; query: string; next?: string | null; append?: boolean }) => {
    const ticket = ++request.current;
    setLoading(true); setError(null);
    try {
      const res = await browseOneDrive(organizationId, { folderId: opts.folderId, query: opts.query, next: opts.next ?? null });
      if (ticket !== request.current) return;
      setItems(prev => opts.append ? [...prev, ...res.items] : res.items);
      setNext(res.next);
    } catch (e) {
      if (ticket === request.current) setError(e instanceof Error ? e.message : 'Je OneDrive kon niet worden gelezen.');
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [organizationId]);

  useEffect(() => { void load({ folderId: here.id, query: search }); }, [here.id, search, load]);

  // Zoeken pas na een korte pauze in het typen.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(query.trim()), 350);
    return () => window.clearTimeout(t);
  }, [query]);

  const openFolder = (item: OneDriveItem) => { setQuery(''); setSearch(''); setCrumbs(c => [...c, { id: item.id, name: item.name }]); };
  const goTo = (index: number) => { setQuery(''); setSearch(''); setCrumbs(c => c.slice(0, index + 1)); };

  const toggle = (item: OneDriveItem) => setPicked(prev => {
    const nextMap = new Map(prev);
    if (nextMap.has(item.id)) nextMap.delete(item.id);
    else if (nextMap.size < MAX_PICK) nextMap.set(item.id, item);
    return nextMap;
  });

  const pickedList = useMemo(() => [...picked.values()], [picked]);

  return <div className="cloud-browser">
    <p className="mv-lede">Vink de bestanden aan voor de map <strong>{folderName}</strong>. Je kunt ook in andere mappen van je OneDrive iets aanvinken.</p>
    <nav className="mv-crumbs" aria-label="Map in OneDrive">
      <button type="button" className="mv-back" onClick={() => goTo(Math.max(0, crumbs.length - 2))} disabled={crumbs.length === 1 || Boolean(search)} aria-label="Eén niveau omhoog"><ChevronLeft size={15} /></button>
      {crumbs.map((c, i) => <span key={`${c.id ?? 'root'}-${i}`} className="mv-crumb-step">
        {i > 0 && <ChevronRight size={14} aria-hidden="true" />}
        {i === crumbs.length - 1 && !search
          ? <span className="mv-crumb-current">{c.name}</span>
          : <button type="button" onClick={() => goTo(i)}>{c.name}</button>}
      </span>)}
      {search && <span className="mv-crumb-step"><ChevronRight size={14} aria-hidden="true" /><span className="mv-crumb-current">Zoeken: “{search}”</span></span>}
    </nav>
    <label className="drive-search mv-search">
      <Search size={14} aria-hidden="true" />
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Zoeken in je OneDrive…" autoComplete="off" aria-label="Zoeken in je OneDrive" />
      {query && <button type="button" className="drive-search-clear" onClick={() => setQuery('')} aria-label="Wissen"><X size={13} /></button>}
    </label>
    <div className="mv-list" aria-busy={loading}>
      {error
        ? <div className="mv-empty">{error}</div>
        : items.length === 0 && loading
          ? <div className="mv-empty"><Loader2 size={16} className="spin" /> Laden…</div>
          : items.length === 0
            ? <div className="mv-empty">{search ? `Niets gevonden voor “${search}”.` : 'Deze map is leeg.'}</div>
            : items.map(item => item.isFolder
              ? <button type="button" key={item.id} className="mv-row" onClick={() => openFolder(item)}>
                  <span className="mv-row-ic" style={{ color: 'var(--accent)' }}><Folder size={18} fill="currentColor" strokeWidth={1.4} /></span>
                  <span className="mv-row-name">{item.name}</span>
                  <span className="mv-row-type">Map</span>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              : <label key={item.id} className={`mv-row cloud-pick${picked.has(item.id) ? ' is-picked' : ''}`}>
                  <input type="checkbox" checked={picked.has(item.id)} onChange={() => toggle(item)} disabled={!picked.has(item.id) && picked.size >= MAX_PICK} />
                  <span className="mv-row-name">{item.name}</span>
                  <span className="mv-row-type">{item.size !== null ? fmtBytes(item.size) : ''}</span>
                  {item.webUrl
                    ? <a href={item.webUrl} target="_blank" rel="noopener noreferrer" className="cloud-open" aria-label={`${item.name} openen in OneDrive`} onClick={e => e.stopPropagation()}><ExternalLink size={14} /></a>
                    : <span />}
                </label>)}
      {next && !error && <button type="button" className="cloud-more" disabled={loading} onClick={() => void load({ folderId: here.id, query: search, next, append: true })}>{loading ? 'Laden…' : 'Meer laden'}</button>}
    </div>
    <div className="cloud-browser-foot">
      <span className="cloud-muted">{picked.size === 0 ? 'Nog niets gekozen.' : `${picked.size} gekozen${picked.size >= MAX_PICK ? ` (hooguit ${MAX_PICK} tegelijk)` : ''}.`}</span>
      <Button type="button" variant="primary" disabled={busy || picked.size === 0} onClick={() => onAdd(pickedList.map(p => ({ id: p.id, driveId: p.driveId })))}>
        {busy ? 'Toevoegen…' : picked.size > 1 ? `${picked.size} bestanden toevoegen` : 'Toevoegen'}
      </Button>
    </div>
  </div>;
}

// ── Google: de kiezer van Google in een eigen kader ──────────────────────────

function GooglePickerFrame({ token, onPicked, onCancel, onError }: {
  token: GooglePickerToken;
  onPicked: (files: Array<{ id: string }>) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const handlers = useRef({ onPicked, onCancel, onError });
  handlers.current = { onPicked, onCancel, onError };

  useEffect(() => {
    const origin = window.location.origin;
    const onMessage = (event: MessageEvent) => {
      // Alleen ons eigen kader: een andere pagina of een ander venster mag hier
      // geen "gekozen bestanden" in stoppen.
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
      if (data.source !== 'resofly-drive-kiezer') return;
      if (data.type === 'ready') {
        frame.current?.contentWindow?.postMessage({ source: 'resofly-app', type: 'open', accessToken: token.accessToken, apiKey: token.apiKey, appId: token.appId, maxItems: MAX_PICK }, origin);
      } else if (data.type === 'picked') {
        const files = Array.isArray(data.files) ? data.files : [];
        handlers.current.onPicked(files
          .map(f => (f && typeof f === 'object' ? String((f as Record<string, unknown>).id ?? '') : ''))
          .filter(id => /^[A-Za-z0-9_-]{1,512}$/.test(id))
          .slice(0, MAX_PICK)
          .map(id => ({ id })));
      } else if (data.type === 'cancel') {
        handlers.current.onCancel();
      } else if (data.type === 'error') {
        handlers.current.onError(typeof data.message === 'string' ? data.message.slice(0, 200) : 'Google Drive kon niet laden.');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [token]);

  return <iframe ref={frame} className="gdrive-picker-frame" src="/drive-kiezer.html" title="Kiezen uit Google Drive" />;
}
