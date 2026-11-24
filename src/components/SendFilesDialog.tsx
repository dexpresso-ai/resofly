import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  AlertTriangle, Check, FileText, Folder, FolderOpen, Image as ImageIcon, Lock, Mail, Plus, Search, Send,
  StickyNote, Upload, UserRound, X,
} from 'lucide-react';
import type { AppData, ClientContact, FileTransferBundle, FileTransferItem, UUID } from '../types';
import { Modal } from './Modal';
import { Button, Input, Select, Textarea } from './Ui';
import { dateNL } from '../lib/format';
import { folderPath } from '../lib/folders';
import { resolveShareContext } from '../lib/shares';
import { createClientContact } from '../lib/repository';
import {
  TRANSFER_DEFAULT_EXPIRY, TRANSFER_EXPIRY_OPTIONS, expiryForServer, fileCountLabel, fileRefusal, formatBytes,
  maxExpiryDate, minExpiryDate, parseLooseEmails, recipientInputs, transferRecipientOptions,
  type TransferRecipientOption,
} from '../lib/transfers';
import {
  addTransferSources, discardTransfer, prepareTransfer, removeTransferItem, sendTransfer, uploadTransferFile,
  type TransferRecipientResult, type TransferSkip, type TransferSource,
} from '../lib/transfers-api';

/**
 * "Bestanden versturen" — één venster, vanuit Inhoud, het klantdossier of een
 * lege start. De bestanden worden een ZENDING: een bevroren pakket met een
 * bericht, dat de ontvanger via een persoonlijke link opent (met een code die
 * naar het eigen e-mailadres gaat). Na de vervaldatum verdwijnen ze.
 *
 * De regel die dit venster zichtbaar maakt: hoort de zending bij een klant, dan
 * staan alleen het hoofdadres en de contactpersonen van díe klant in de lijst.
 * Een los adres kan alleen bij bestanden die bij geen klant horen. Het slot zelf
 * zit in de database; dit scherm zorgt dat je er niet tegenaan loopt.
 */
export function SendFilesDialog({
  data, organizationId, sources = [], clientId: initialClientId = null, files: initialFiles = [],
  chooseClient = false, origin = 'content', onClose, onSent, onChanged,
}: {
  data: AppData;
  organizationId: UUID;
  /** Wat er al mee moet (een selectie uit Inhoud). */
  sources?: TransferSource[];
  /** De klant als die vaststaat (klantdossier); bij bronnen volgt hij uit de bronnen. */
  clientId?: UUID | null;
  /** Bestanden die al in het venster gesleept zijn. */
  files?: File[];
  /** Begint zonder context: eerst kiezen voor welke klant (of geen klant). */
  chooseClient?: boolean;
  origin?: 'content' | 'client';
  onClose: () => void;
  onSent?: (bundle: FileTransferBundle) => void;
  onChanged?: () => void;
}) {
  const [phase, setPhase] = useState<'client' | 'preparing' | 'editing' | 'done'>(chooseClient && sources.length === 0 ? 'client' : 'preparing');
  const [pickedClient, setPickedClient] = useState<string>(initialClientId ?? '');
  const [bundle, setBundle] = useState<FileTransferBundle | null>(null);
  const [skipped, setSkipped] = useState<TransferSkip[]>([]);
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; size: number; done: number; error: string | null }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [extraContacts, setExtraContacts] = useState<ClientContact[]>([]);
  const [looseEmails, setLooseEmails] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [expiry, setExpiry] = useState(TRANSFER_DEFAULT_EXPIRY);
  const [customDate, setCustomDate] = useState('');
  const [canDownload, setCanDownload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TransferRecipientResult[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [newContact, setNewContact] = useState<{ name: string; email: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const started = useRef(false);
  const pendingFiles = useRef<File[]>(initialFiles);

  const transfer = bundle?.transfer ?? null;
  const clientId = transfer ? transfer.client_id : (initialClientId ?? null);
  const client = clientId ? data.clients.find((c) => c.id === clientId) ?? null : null;
  const items = bundle?.items ?? [];
  const totalBytes = items.reduce((sum, item) => sum + (item.size_bytes || 0), 0);
  const uploading = uploads.some((u) => u.done < u.size && !u.error);

  const options = useMemo<TransferRecipientOption[]>(() => transferRecipientOptions(
    { clients: data.clients, clientContacts: [...data.clientContacts, ...extraContacts.filter((c) => !data.clientContacts.some((d) => d.id === c.id))] },
    clientId,
  ), [data.clients, data.clientContacts, extraContacts, clientId]);

  // ── Concept aanmaken ────────────────────────────────────────────────────
  const prepare = useCallback(async (forClient: string | null) => {
    setPhase('preparing'); setError(null);
    try {
      const { bundle: created, skipped: skip } = await prepareTransfer(organizationId, {
        clientId: sources.length > 0 ? undefined : forClient,
        origin,
        sources,
      });
      setBundle(created);
      setSkipped(skip);
      setSubject(created.transfer.subject);
      setPhase('editing');
      // De klant (als die er is) staat standaard aan als ontvanger.
      const first = transferRecipientOptions(data, created.transfer.client_id)[0];
      if (first?.kind === 'client') setSelected(new Set(['client']));
      const queued = pendingFiles.current;
      pendingFiles.current = [];
      if (queued.length > 0) void uploadFiles(queued, created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'De zending kon niet worden aangemaakt.');
      setPhase(chooseClient && sources.length === 0 ? 'client' : 'editing');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, origin, sources]);

  useEffect(() => {
    if (phase !== 'preparing' || started.current) return;
    started.current = true;
    void prepare(initialClientId ?? null);
  }, [phase, prepare, initialClientId]);

  // ── Bestanden ───────────────────────────────────────────────────────────
  async function uploadFiles(list: File[], target: FileTransferBundle | null = bundle) {
    if (!target) { pendingFiles.current.push(...list); return; }
    const refusals: string[] = [];
    const accepted: File[] = [];
    for (const file of list) {
      const refusal = fileRefusal(file);
      if (refusal) refusals.push(refusal); else accepted.push(file);
    }
    if (refusals.length) setError(refusals.join(' '));
    for (const file of accepted) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      setUploads((prev) => [...prev, { id, name: file.name, size: file.size, done: 0, error: null }]);
      try {
        const item = await uploadTransferFile(file, organizationId, target.transfer.id, (done) => {
          setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, done } : u)));
        });
        setUploads((prev) => prev.filter((u) => u.id !== id));
        setBundle((prev) => (prev ? { ...prev, items: [...prev.items, item] } : prev));
      } catch (e) {
        const reason = e instanceof Error ? e.message : 'Uploaden mislukte.';
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, error: reason } : u)));
      }
    }
  }

  async function removeItem(item: FileTransferItem) {
    if (!transfer) return;
    setBusy(true); setError(null);
    try {
      setBundle(await removeTransferItem(organizationId, transfer.id, item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Weghalen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  async function addFromContent(picked: TransferSource[]) {
    setPicking(false);
    if (!transfer || picked.length === 0) return;
    setBusy(true); setError(null);
    try {
      const { bundle: next, skipped: skip } = await addTransferSources(organizationId, transfer.id, picked);
      setBundle(next);
      setSkipped((prev) => [...prev, ...skip]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toevoegen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragOver(false);
    const dropped = Array.from(event.dataTransfer.files ?? []);
    if (dropped.length) void uploadFiles(dropped);
  }

  // ── Ontvangers ──────────────────────────────────────────────────────────
  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function addLoose() {
    const { emails, invalid } = parseLooseEmails(emailDraft);
    if (invalid.length) { setError(`Geen geldig e-mailadres: ${invalid.join(', ')}`); return; }
    setError(null);
    setLooseEmails((prev) => [...new Set([...prev, ...emails])].slice(0, 25));
    setEmailDraft('');
  }

  async function saveNewContact() {
    if (!newContact || !clientId) return;
    const name = newContact.name.trim();
    const email = newContact.email.trim().toLowerCase();
    if (!name) { setError('Vul een naam in voor de contactpersoon.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Vul een geldig e-mailadres in.'); return; }
    setBusy(true); setError(null);
    try {
      const contact = await createClientContact(organizationId, { client_id: clientId, name, email, is_active: true, gives_portal_access: false });
      setExtraContacts((prev) => [...prev, contact]);
      setSelected((prev) => new Set([...prev, `contact:${contact.id}`]));
      setNewContact(null);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'De contactpersoon kon niet worden opgeslagen.');
    } finally {
      setBusy(false);
    }
  }

  const chosen = options.filter((option) => selected.has(option.key));
  const recipientCount = clientId ? chosen.length : looseEmails.length;
  const expiryValue = expiryForServer(expiry, customDate);
  const expiryDate = expiryValue === null
    ? null
    : typeof expiryValue === 'number'
      ? new Date(Date.now() + expiryValue * 86_400_000).toISOString()
      : `${expiryValue}T23:59:59`;

  const sentence = useMemo(() => {
    if (items.length === 0 || recipientCount === 0 || !expiryDate) return null;
    const names = clientId ? chosen.map((o) => (o.kind === 'client' ? `het hoofdadres van ${client?.name ?? 'de klant'}` : o.name)) : looseEmails;
    const list = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} en ${names[names.length - 1]}`;
    return `${fileCountLabel(items.length)} (${formatBytes(totalBytes)}) naar ${list}, beschikbaar tot ${dateNL(expiryDate)}.`;
  }, [items.length, recipientCount, expiryDate, clientId, chosen, client?.name, looseEmails, totalBytes]);

  async function send() {
    if (!transfer) return;
    if (items.length === 0) { setError('Voeg eerst bestanden toe.'); return; }
    if (recipientCount === 0) { setError('Kies minstens één ontvanger.'); return; }
    if (expiryValue === null) { setError('Kies tot wanneer de bestanden beschikbaar zijn.'); return; }
    if (uploading) { setError('Wacht tot het uploaden klaar is.'); return; }
    setBusy(true); setError(null);
    try {
      const outcome = await sendTransfer(organizationId, {
        transferId: transfer.id,
        subject: subject.trim() || transfer.subject,
        message: message.trim() || null,
        expiresAt: expiryValue,
        canDownload,
        recipients: clientId ? recipientInputs(chosen) : looseEmails.map((email) => ({ kind: 'email', email })),
      });
      setBundle(outcome.bundle);
      setResults(outcome.results);
      setPhase('done');
      onSent?.(outcome.bundle);
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Versturen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (phase === 'editing' && transfer?.status === 'draft') {
      if ((items.length > 0 || uploads.length > 0) && !window.confirm('Deze zending is nog niet verstuurd. Weggooien? De geüploade bestanden worden verwijderd.')) return;
      void discardTransfer(organizationId, transfer.id).catch(() => undefined);
    }
    onClose();
  }

  // ── Weergave ────────────────────────────────────────────────────────────
  if (phase === 'client') {
    const sorted = [...data.clients].sort((a, b) => a.name.localeCompare(b.name, 'nl'));
    return <Modal title="Bestanden versturen" className="share-modal xfer-modal" onClose={onClose} footer={<>
      <Button onClick={onClose}>Annuleren</Button>
      <Button variant="primary" onClick={() => { started.current = true; void prepare(pickedClient || null); }}>Verder</Button>
    </>}>
      <p className="share-lede">Voor wie zijn de bestanden? Kies de klant: dan gaan ze alleen naar het hoofdadres of een contactpersoon van die klant.</p>
      {error && <p className="error">{error}</p>}
      <label className="share-option">
        <span>Klant</span>
        <Select value={pickedClient} onChange={(e) => setPickedClient(e.target.value)} searchable searchPlaceholder="Zoek een klant…">
          <option value="">Geen klant — naar een los e-mailadres</option>
          {sorted.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </label>
      <p className="share-hint">Bestanden uit een klantdossier kunnen alleen naar die klant. Kies je geen klant, dan kun je naar elk e-mailadres sturen — maar alleen bestanden die je hier zelf uploadt of die bij geen klant horen.</p>
    </Modal>;
  }

  if (phase === 'preparing') {
    return <Modal title="Bestanden versturen" className="share-modal xfer-modal" onClose={onClose}>
      <p className="share-lede">Even klaarzetten…{sources.length > 0 ? ' De bestanden worden gekopieerd zodat ze niet meer veranderen.' : ''}</p>
      {error && <p className="error">{error}</p>}
    </Modal>;
  }

  if (phase === 'done' && bundle) {
    const ok = (results ?? []).filter((r) => r.notified);
    return <Modal title="Verstuurd" className="share-modal xfer-modal" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Klaar</Button>}>
      <p className="share-lede"><strong>{bundle.transfer.subject}</strong> — {fileCountLabel(bundle.transfer.item_count)}, beschikbaar tot {dateNL(bundle.transfer.expires_at)}.</p>
      <section className="share-section share-results">
        <h4><Check size={14} /> {ok.length === (results ?? []).length ? 'Iedereen is gemaild' : `${ok.length} van ${(results ?? []).length} gemaild`}</h4>
        <ul>
          {(results ?? []).map((result, index) => <li key={result.recipientId ?? `r-${index}`}>
            <div className="share-result-line"><strong>{result.name || result.email || 'Ontvanger'}</strong>{result.email && result.name && <span className="share-person-meta">{result.email}</span>}</div>
            {result.error
              ? <p className="share-warn-line"><AlertTriangle size={13} /> {result.error}</p>
              : <p className="share-hint">Ontvangt een mail met een persoonlijke link. Openen gaat met een code die naar dit adres gaat.</p>}
          </li>)}
        </ul>
      </section>
      <p className="share-hint"><Lock size={12} /> Je ziet onder “Gedeeld &amp; verzonden” wie de bestanden heeft geopend en gedownload. Daar kun je ook intrekken of verlengen.</p>
    </Modal>;
  }

  const clientRelated = Boolean(clientId);
  return <Modal
    title="Bestanden versturen"
    className="share-modal xfer-modal"
    onClose={close}
    footer={<>
      <Button onClick={close} disabled={busy}>Annuleren</Button>
      <Button variant="primary" onClick={send} disabled={busy || uploading || !transfer || items.length === 0 || recipientCount === 0}>
        <Send size={14} /> {busy ? 'Bezig…' : recipientCount > 1 ? `Verstuur naar ${recipientCount} mensen` : 'Versturen'}
      </Button>
    </>}
  >
    {clientRelated
      ? <div className="share-rule"><UserRound size={16} /><span>Voor <strong>{client?.name ?? 'deze klant'}</strong>. De bestanden gaan alleen naar het hoofdadres of een contactpersoon van deze klant.</span></div>
      : <div className="share-rule is-open"><Mail size={16} /><span>Deze bestanden horen bij geen klant. Je kunt ze naar elk e-mailadres sturen.</span></div>}

    {error && <p className="error">{error}</p>}

    {/* ── Aan ── */}
    <section className="share-section">
      <h4><UserRound size={14} /> Aan</h4>
      {clientRelated
        ? <>
            {options.length === 0
              ? <p className="share-empty">Deze klant heeft geen geldig e-mailadres en nog geen contactpersonen. Voeg hieronder iemand toe.</p>
              : <ul className="share-people">
                  {options.map((option) => <li key={option.key}>
                    <label>
                      <input type="checkbox" checked={selected.has(option.key)} disabled={busy} onChange={() => toggle(option.key)} />
                      <span className="share-person">
                        <strong>{option.name}</strong>
                        <span className="share-person-meta">{option.email}{option.role && option.kind !== 'client' ? ` · ${option.role}` : ''}</span>
                      </span>
                    </label>
                    {option.kind === 'client' && <span className="share-tag">Hoofdadres</span>}
                  </li>)}
                </ul>}
            {newContact
              ? <div className="xfer-new-contact">
                  <Input value={newContact.name} placeholder="Naam" disabled={busy} onChange={(e) => setNewContact({ ...newContact, name: e.target.value })} />
                  <Input type="email" value={newContact.email} placeholder="naam@bedrijf.nl" disabled={busy} onChange={(e) => setNewContact({ ...newContact, email: e.target.value })} />
                  <Button onClick={() => void saveNewContact()} disabled={busy}>Opslaan</Button>
                  <Button variant="ghost" onClick={() => setNewContact(null)} disabled={busy}>Annuleren</Button>
                </div>
              : <button type="button" className="xfer-link-btn" onClick={() => setNewContact({ name: '', email: '' })} disabled={busy}><Plus size={13} /> Nieuwe contactpersoon</button>}
            <p className="share-hint">Iemand anders bij deze klant (de drukker, de boekhouder)? Voeg die toe als contactpersoon; portaaltoegang is niet nodig.</p>
          </>
        : <>
            <div className="share-email-row">
              <Input type="email" value={emailDraft} placeholder="naam@bedrijf.nl" disabled={busy}
                onChange={(e) => setEmailDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addLoose(); } }} />
              <Button onClick={addLoose} disabled={busy || !emailDraft.trim()}>Toevoegen</Button>
            </div>
            {looseEmails.length > 0 && <ul className="share-chips">
              {looseEmails.map((email) => <li key={email}><Mail size={13} /> {email}
                <button type="button" aria-label={`${email} verwijderen`} onClick={() => setLooseEmails((prev) => prev.filter((x) => x !== email))}>×</button>
              </li>)}
            </ul>}
          </>}
    </section>

    {/* ── Bestanden ── */}
    <section
      className={`share-section xfer-files${dragOver ? ' is-dragging' : ''}`}
      onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <h4><FileText size={14} /> Bestanden {items.length > 0 && <span className="share-tag">{fileCountLabel(items.length)} · {formatBytes(totalBytes)}</span>}</h4>
      {items.length === 0 && uploads.length === 0
        ? <p className="share-empty">Nog niets. Sleep bestanden hierheen, kies ze van je computer of uit Inhoud. Hoogstens 1 GB per bestand.</p>
        : <ul className="xfer-items">
            {items.map((item) => <li key={item.id}>
              <span className="xfer-item-ic"><ItemIcon item={item} /></span>
              <span className="xfer-item-main">
                <strong>{item.name}</strong>
                <span>{[item.path, item.storage_key ? formatBytes(item.size_bytes) : 'tekst — wordt op de pagina gelezen'].filter(Boolean).join(' · ')}</span>
              </span>
              <button type="button" className="xfer-item-remove" aria-label={`${item.name} weghalen`} disabled={busy} onClick={() => void removeItem(item)}><X size={14} /></button>
            </li>)}
            {uploads.map((upload) => <li key={upload.id} className={upload.error ? 'is-error' : 'is-uploading'}>
              <span className="xfer-item-ic"><Upload size={15} /></span>
              <span className="xfer-item-main">
                <strong>{upload.name}</strong>
                {upload.error
                  ? <span className="xfer-item-error">{upload.error}</span>
                  : <span className="xfer-progress"><span style={{ width: `${upload.size ? Math.round((upload.done / upload.size) * 100) : 0}%` }} /></span>}
              </span>
              {upload.error && <button type="button" className="xfer-item-remove" aria-label="Sluiten" onClick={() => setUploads((prev) => prev.filter((u) => u.id !== upload.id))}><X size={14} /></button>}
            </li>)}
          </ul>}
      {skipped.length > 0 && <div className="xfer-skipped">
        <p><AlertTriangle size={13} /> Niet meegenomen:</p>
        <ul>{skipped.map((s, i) => <li key={`${s.name}-${i}`}><strong>{s.name}</strong> — {s.reason}</li>)}</ul>
      </div>}
      <div className="xfer-add-row">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (list.length) void uploadFiles(list); }} />
        <Button onClick={() => fileInput.current?.click()} disabled={busy || !transfer}><Upload size={14} /> Van je computer</Button>
        <Button onClick={() => setPicking(true)} disabled={busy || !transfer}><FolderOpen size={14} /> Uit Inhoud</Button>
      </div>
      <p className="share-hint">Bestanden worden gekopieerd: wat je daarna in Inhoud verandert, verandert niet aan wat de ontvanger krijgt. Nieuwe uploads komen niet in het klantdossier; ze tellen wel mee in je opslag tot ze verlopen.</p>
    </section>

    {/* ── Bericht ── */}
    <section className="share-section">
      <h4><Mail size={14} /> Bericht</h4>
      <label className="share-option">
        <span>Onderwerp</span>
        <Input value={subject} maxLength={200} disabled={busy} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="share-message">
        <span>Bericht (optioneel)</span>
        <Textarea value={message} rows={3} maxLength={5000} disabled={busy} placeholder="Hoi, hierbij de bestanden die we bespraken." onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="share-options xfer-options">
        <label className="share-option">
          <span>Beschikbaar tot</span>
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={busy}>
            {TRANSFER_EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>
        {expiry === 'custom' && <label className="share-option">
          <span>Datum</span>
          <Input type="date" value={customDate} min={minExpiryDate()} max={maxExpiryDate()} disabled={busy} onChange={(e) => setCustomDate(e.target.value)} />
        </label>}
        <label className="share-toggle">
          <input type="checkbox" checked={canDownload} disabled={busy} onChange={(e) => setCanDownload(e.target.checked)} />
          <span>Downloaden toestaan<em>Uit = de ontvanger kan alleen teksten lezen; bestanden zijn dan niet op te halen.</em></span>
        </label>
      </div>
      <p className="share-hint"><Lock size={12} /> Na de vervaldatum worden de bestanden verwijderd. Wie ze kreeg en wanneer, blijft zichtbaar.</p>
    </section>

    {sentence && <p className="xfer-sentence"><Check size={14} /> {sentence}</p>}

    {picking && <TransferSourcePicker data={data} clientId={clientId} existing={items} onClose={() => setPicking(false)} onPick={(picked) => void addFromContent(picked)} />}
  </Modal>;
}

function ItemIcon({ item }: { item: FileTransferItem }) {
  if (!item.storage_key) return <StickyNote size={15} style={{ color: 'var(--accent-v)' }} />;
  if (item.mime_type.startsWith('image/')) return <ImageIcon size={15} style={{ color: 'var(--accent-g)' }} />;
  return <FileText size={15} style={{ color: 'var(--accent-b)' }} />;
}

/**
 * Kiezen uit Inhoud: alleen wat bij dezelfde klant hoort als de zending (of bij
 * geen klant, voor een zending zonder klant). Een map neemt alles mee wat erin
 * zit, ook submappen.
 */
export function TransferSourcePicker({ data, clientId, existing, onClose, onPick }: {
  data: AppData;
  clientId: UUID | null;
  existing: FileTransferItem[];
  onClose: () => void;
  onPick: (sources: TransferSource[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const already = new Set(existing.map((item) => `${item.source_type}:${item.source_id}`));
  const belongs = (type: 'folder' | 'attachment' | 'note' | 'document', id: string) =>
    (resolveShareContext(data, type, id).clientId ?? null) === (clientId ?? null);

  const folders = useMemo(() => data.folders
    .filter((f) => belongs('folder', f.id))
    .map((f) => ({ id: f.id, name: f.name, path: folderPath(data.folders, f.parent_id).map((p) => p.name).join(' / ') }))
    .sort((a, b) => `${a.path}/${a.name}`.localeCompare(`${b.path}/${b.name}`, 'nl')),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data.folders, clientId]);

  const files = useMemo(() => data.attachments
    .filter((a) => a.entity_type === 'folder' && belongs('attachment', a.id))
    .map((a) => ({ id: a.id, name: a.name, size: a.size_bytes, path: folderPath(data.folders, a.entity_id).map((p) => p.name).join(' / ') }))
    .sort((a, b) => a.name.localeCompare(b.name, 'nl', { numeric: true })),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data.attachments, data.folders, clientId]);

  const texts = useMemo(() => [
    ...data.notes.filter((n) => belongs('note', n.id)).map((n) => ({ type: 'note' as const, id: n.id, name: n.title || 'Notitie', when: n.updated_at || n.created_at })),
    ...data.documents.filter((d) => belongs('document', d.id)).map((d) => ({ type: 'document' as const, id: d.id, name: d.title || 'Document', when: d.updated_at || d.created_at })),
  ].sort((a, b) => b.when.localeCompare(a.when)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [data.notes, data.documents, clientId]);

  const q = query.trim().toLowerCase();
  const hit = (...values: Array<string | null | undefined>) => !q || values.some((v) => String(v ?? '').toLowerCase().includes(q));
  const toggle = (key: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  function confirm() {
    const sources: TransferSource[] = [...picked].map((key) => {
      const [type, id] = key.split(':') as [TransferSource['type'], string];
      return { type, id };
    });
    onPick(sources);
  }

  return <Modal title="Kiezen uit Inhoud" className="share-modal xfer-picker" onClose={onClose} footer={<>
    <Button onClick={onClose}>Annuleren</Button>
    <Button variant="primary" onClick={confirm} disabled={picked.size === 0}>{picked.size === 0 ? 'Toevoegen' : `${picked.size} toevoegen`}</Button>
  </>}>
    <div className="xfer-picker-search"><Search size={14} /><Input value={query} placeholder="Zoeken…" onChange={(e) => setQuery(e.target.value)} /></div>
    {folders.length + files.length + texts.length === 0 && <p className="share-empty">{clientId ? 'Deze klant heeft nog niets in Inhoud.' : 'Er staat niets in Inhoud dat bij geen klant hoort.'}</p>}
    {folders.some((f) => hit(f.name, f.path)) && <section className="share-section">
      <h4><Folder size={14} /> Mappen <span className="share-person-meta">— met alles wat erin zit</span></h4>
      <ul className="share-people">{folders.filter((f) => hit(f.name, f.path)).map((f) => <li key={f.id}>
        <label><input type="checkbox" checked={picked.has(`folder:${f.id}`)} onChange={() => toggle(`folder:${f.id}`)} />
          <span className="share-person"><strong>{f.name}</strong>{f.path && <span className="share-person-meta">{f.path}</span>}</span></label>
      </li>)}</ul>
    </section>}
    {files.some((f) => hit(f.name, f.path)) && <section className="share-section">
      <h4><FileText size={14} /> Bestanden</h4>
      <ul className="share-people">{files.filter((f) => hit(f.name, f.path)).map((f) => <li key={f.id} className={already.has(`attachment:${f.id}`) ? 'is-shared' : undefined}>
        <label><input type="checkbox" disabled={already.has(`attachment:${f.id}`)} checked={picked.has(`attachment:${f.id}`)} onChange={() => toggle(`attachment:${f.id}`)} />
          <span className="share-person"><strong>{f.name}</strong><span className="share-person-meta">{[f.path, formatBytes(f.size)].filter(Boolean).join(' · ')}</span></span></label>
        {already.has(`attachment:${f.id}`) && <span className="share-tag">Zit erin</span>}
      </li>)}</ul>
    </section>}
    {texts.some((t) => hit(t.name)) && <section className="share-section">
      <h4><StickyNote size={14} /> Notities en documenten</h4>
      <ul className="share-people">{texts.filter((t) => hit(t.name)).map((t) => <li key={`${t.type}:${t.id}`} className={already.has(`${t.type}:${t.id}`) ? 'is-shared' : undefined}>
        <label><input type="checkbox" disabled={already.has(`${t.type}:${t.id}`)} checked={picked.has(`${t.type}:${t.id}`)} onChange={() => toggle(`${t.type}:${t.id}`)} />
          <span className="share-person"><strong>{t.name}</strong><span className="share-person-meta">{t.type === 'note' ? 'Notitie' : 'Document'} · {dateNL(t.when)}</span></span></label>
        {already.has(`${t.type}:${t.id}`) && <span className="share-tag">Zit erin</span>}
      </li>)}</ul>
    </section>}
  </Modal>;
}
