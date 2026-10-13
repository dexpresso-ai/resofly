import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, Lock, Paperclip, StickyNote, Upload, X } from 'lucide-react';
import type { AppData, FileTransferBundle, FileTransferItem, UUID } from '../types';
import { Input, Select } from './Ui';
import { TransferSourcePicker } from './SendFilesDialog';
import {
  TRANSFER_DEFAULT_EXPIRY, TRANSFER_EXPIRY_OPTIONS, expiryForServer, fileCountLabel, fileRefusal, formatBytes,
  maxExpiryDate, minExpiryDate, transferRecipientOptions,
} from '../lib/transfers';
import {
  addTransferSources, discardTransfer, prepareTransfer, removeTransferItem, updateTransferDraft, uploadTransferFile,
  type TransferSource,
} from '../lib/transfers-api';

/**
 * Bestanden bij een mail uit het mailvenster (Berichten, klantdossier).
 *
 * Ze gaan niet als bijlage mee: de mail krijgt een beveiligd blok met een
 * persoonlijke link, precies als bij "Bestanden versturen". Achter de schermen
 * is het een concept-zending voor deze klant, die de mail-functie bij het
 * versturen afmaakt — met de ontvanger van de mail als ontvanger van de
 * bestanden. Wordt de mail niet verstuurd, dan gooit dit onderdeel het concept
 * weer weg.
 *
 * Met een `ticketId` hoort het concept bij een antwoord in de tickettijdlijn:
 * de klant ziet de bestanden dan in het portaal, onder dat antwoord.
 */
export type MessageFilesState = ReturnType<typeof useMessageFiles>;

export function useMessageFiles(organizationId: UUID, clientId: UUID | null, ticketId: UUID | null = null) {
  const [bundle, setBundle] = useState<FileTransferBundle | null>(null);
  const [uploads, setUploads] = useState<Array<{ id: string; name: string; size: number; done: number; error: string | null }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expiry, setExpiry] = useState(TRANSFER_DEFAULT_EXPIRY);
  const [customDate, setCustomDate] = useState('');
  const draft = useRef<{ id: UUID; organizationId: UUID } | null>(null);
  const creating = useRef<Promise<FileTransferBundle> | null>(null);

  const forget = useCallback(() => {
    draft.current = null;
    creating.current = null;
    setBundle(null);
    setUploads([]);
    setError(null);
  }, []);

  const discard = useCallback(async () => {
    const current = draft.current;
    forget();
    if (current) await discardTransfer(current.organizationId, current.id).catch(() => undefined);
  }, [forget]);

  // Een andere klant (of weg uit het venster): het concept hoort nergens meer bij.
  useEffect(() => () => {
    const current = draft.current;
    if (current) void discardTransfer(current.organizationId, current.id).catch(() => undefined);
    draft.current = null;
    creating.current = null;
  }, [organizationId, clientId, ticketId]);
  useEffect(() => { setBundle(null); setUploads([]); }, [organizationId, clientId, ticketId]);

  async function ensureDraft(): Promise<FileTransferBundle> {
    if (bundle) return bundle;
    if (!clientId) throw new Error('Kies eerst een klant.');
    if (!creating.current) {
      const context = ticketId ? { clientId, origin: 'ticket' as const, ticketId } : { clientId, origin: 'message' as const };
      creating.current = prepareTransfer(organizationId, context).then(({ bundle: created }) => {
        draft.current = { id: created.transfer.id, organizationId };
        setBundle(created);
        return created;
      });
    }
    return creating.current;
  }

  async function addFiles(list: File[]) {
    setError(null);
    const refusals = list.map(fileRefusal).filter(Boolean) as string[];
    const accepted = list.filter((file) => !fileRefusal(file));
    if (refusals.length) setError(refusals.join(' '));
    if (accepted.length === 0) return;
    let target: FileTransferBundle;
    try {
      target = await ensureDraft();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'De bestanden konden niet worden klaargezet.');
      return;
    }
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
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, error: e instanceof Error ? e.message : 'Uploaden mislukte.' } : u)));
      }
    }
  }

  async function addSources(sources: TransferSource[]) {
    if (sources.length === 0) return;
    setBusy(true); setError(null);
    try {
      const target = await ensureDraft();
      const { bundle: next, skipped } = await addTransferSources(organizationId, target.transfer.id, sources);
      setBundle(next);
      if (skipped.length) setError(`Niet meegenomen: ${skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toevoegen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: FileTransferItem) {
    if (!bundle) return;
    setBusy(true); setError(null);
    try {
      setBundle(await removeTransferItem(organizationId, bundle.transfer.id, item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Weghalen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Vlak voor het versturen: de gekozen termijn vastleggen en het id teruggeven
   * dat met de mail mee moet. Zonder bestanden: null (en geen concept meer).
   */
  async function finalize(): Promise<UUID | null> {
    if (uploads.some((u) => !u.error && u.done < u.size)) throw new Error('Wacht tot het uploaden klaar is.');
    if (!bundle || bundle.items.length === 0) {
      if (bundle) await discard();
      return null;
    }
    const value = expiryForServer(expiry, customDate);
    if (value === null) throw new Error('Kies tot wanneer de bestanden beschikbaar zijn.');
    await updateTransferDraft(organizationId, bundle.transfer.id, { expiresAt: value });
    return bundle.transfer.id;
  }

  const items = bundle?.items ?? [];
  return {
    bundle, items, uploads, error, busy, expiry, setExpiry, customDate, setCustomDate,
    totalBytes: items.reduce((sum, item) => sum + (item.size_bytes || 0), 0),
    /** De gekozen termijn zoals de server hem wil (dagen of een datum). */
    expiresAtForServer: () => expiryForServer(expiry, customDate),
    uploading: uploads.some((u) => !u.error && u.done < u.size),
    addFiles, addSources, removeItem, finalize, discard,
    /** Na een geslaagde mail: het concept is nu een verstuurde zending; niet meer weggooien. */
    markSent: forget,
    dismissUpload: (id: string) => setUploads((prev) => prev.filter((u) => u.id !== id)),
  };
}

/** De paperclip-strook onder het bericht. */
export function MessageFilesBar({ state, data, clientId, disabled }: {
  state: MessageFilesState;
  data: AppData;
  clientId: UUID | null;
  disabled?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const has = state.items.length > 0 || state.uploads.length > 0;

  return <div className="xfer-mail-files">
    <div className="xfer-mail-files-head">
      <div className="xfer-mail-attach">
        <button type="button" className="xfer-link-btn" disabled={disabled || !clientId} onClick={() => setMenuOpen((v) => !v)} aria-haspopup="menu" aria-expanded={menuOpen}>
          <Paperclip size={14} /> Bestanden toevoegen
        </button>
        {menuOpen && <div className="drive-pop xfer-mail-pop" role="menu">
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenuOpen(false); fileInput.current?.click(); }}><Upload size={15} /> Van je computer</button>
          <button type="button" className="drive-pop-item" role="menuitem" onClick={() => { setMenuOpen(false); setPicking(true); }}><FolderOpen size={15} /> Uit Inhoud</button>
        </div>}
      </div>
      {has && <span className="share-person-meta">{fileCountLabel(state.items.length)} · {formatBytes(state.totalBytes)}</span>}
    </div>
    <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const list = Array.from(e.target.files ?? []); e.target.value = ''; if (list.length) void state.addFiles(list); }} />

    {state.error && <p className="error">{state.error}</p>}

    {has && <>
      <ul className="xfer-items xfer-items-compact">
        {state.items.map((item) => <li key={item.id}>
          <span className="xfer-item-ic">{item.storage_key ? <FileText size={14} /> : <StickyNote size={14} />}</span>
          <span className="xfer-item-main"><strong>{item.name}</strong><span>{item.storage_key ? formatBytes(item.size_bytes) : 'tekst'}</span></span>
          <button type="button" className="xfer-item-remove" aria-label={`${item.name} weghalen`} disabled={disabled || state.busy} onClick={() => void state.removeItem(item)}><X size={13} /></button>
        </li>)}
        {state.uploads.map((upload) => <li key={upload.id} className={upload.error ? 'is-error' : 'is-uploading'}>
          <span className="xfer-item-ic"><Upload size={14} /></span>
          <span className="xfer-item-main">
            <strong>{upload.name}</strong>
            {upload.error ? <span className="xfer-item-error">{upload.error}</span>
              : <span className="xfer-progress"><span style={{ width: `${upload.size ? Math.round((upload.done / upload.size) * 100) : 0}%` }} /></span>}
          </span>
          {upload.error && <button type="button" className="xfer-item-remove" aria-label="Sluiten" onClick={() => state.dismissUpload(upload.id)}><X size={13} /></button>}
        </li>)}
      </ul>
      <div className="xfer-mail-expiry">
        <span>Beschikbaar tot</span>
        <Select value={state.expiry} onChange={(e) => state.setExpiry(e.target.value)} disabled={disabled} inline>
          {TRANSFER_EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {state.expiry === 'custom' && <Input type="date" value={state.customDate} min={minExpiryDate()} max={maxExpiryDate()} disabled={disabled} onChange={(e) => state.setCustomDate(e.target.value)} />}
      </div>
      <p className="share-hint"><Lock size={12} /> Gaat als beveiligde link mee, niet als bijlage: de ontvanger opent ze met een code die naar het eigen adres gaat. Na de termijn worden ze verwijderd.</p>
    </>}

    {picking && <TransferSourcePicker data={data} clientId={clientId} existing={state.items} onClose={() => setPicking(false)} onPick={(sources) => { setPicking(false); void state.addSources(sources); }} />}
  </div>;
}

/**
 * Aan wie de mail gaat: het hoofdadres van de klant of een contactpersoon van
 * díe klant. Geeft de keuze terug als `client` of `contact:<id>`.
 */
export function MailRecipientSelect({ data, clientId, value, onChange, disabled }: {
  data: AppData;
  clientId: UUID | null;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const options = transferRecipientOptions(data, clientId);
  if (options.length <= 1) return null;
  return <label className="client-comm-field">Aan
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {options.map((option) => <option key={option.key} value={option.key}>
        {option.name} — {option.email}{option.kind === 'client' ? ' (hoofdadres)' : option.role ? ` (${option.role})` : ''}
      </option>)}
    </Select>
  </label>;
}

/** Het adres dat bij een keuze uit MailRecipientSelect hoort (of null als die er niet meer is). */
export function mailRecipientFor(data: AppData, clientId: UUID | null, value: string): { contactId: UUID | null; email: string } | null {
  const options = transferRecipientOptions(data, clientId);
  const found = options.find((o) => o.key === value) ?? options[0];
  return found ? { contactId: found.contactId, email: found.email } : null;
}
