import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, CalendarClock, Download, FileText, History, Lock, Mail, Plus, RotateCcw, Send,
  StickyNote, Trash2, UserRound, X,
} from 'lucide-react';
import type { AppData, FileTransferBundle, FileTransferEvent, FileTransferItem, UUID } from '../types';
import { Button, Input, Select } from './Ui';
import { ReadModal } from './ReadModal';
import { dateNL } from '../lib/format';
import { NotMigratedError } from '../lib/postgrestErrors';
import {
  TRANSFER_EXPIRY_OPTIONS, TRANSFER_STATE_LABEL, downloadedCount, expiryForServer, fileCountLabel, formatBytes,
  maxExpiryDate, minExpiryDate, parseLooseEmails, recipientInputs, recipientLabel, recipientStatus, remainingLabel,
  transferRecipientOptions, transferState, transferSummary,
} from '../lib/transfers';
import {
  addTransferRecipients, deleteTransfer, downloadTransferItem, extendTransfer, loadTransferBundle, loadTransferEvents,
  loadTransferItemText, loadTransfers, resendTransfer, revokeTransfer, revokeTransferRecipient,
} from '../lib/transfers-api';

/**
 * "Verzonden" — de zendingen van deze organisatie (of van één klant): wat er
 * wanneer naar wie ging, en hoe elke ontvanger erbij staat (verstuurd,
 * afgeleverd, geopend, gedownload). Met de knoppen die je daarna nog nodig hebt:
 * intrekken, verlengen, opnieuw sturen, iemand toevoegen.
 */
export function TransferList({ data, organizationId, clientId = null, currentUserId, canWrite, onChanged, initialTransferId = null }: {
  data: AppData;
  organizationId: UUID;
  clientId?: UUID | null;
  currentUserId: UUID | null;
  canWrite: boolean;
  onChanged?: () => void;
  initialTransferId?: UUID | null;
}) {
  const [bundles, setBundles] = useState<FileTransferBundle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [openId, setOpenId] = useState<UUID | null>(initialTransferId);
  const [filter, setFilter] = useState<'active' | 'all'>('active');

  const load = useCallback(async () => {
    setError(null);
    try {
      setBundles(await loadTransfers(organizationId, { clientId, userId: currentUserId }));
    } catch (e) {
      if (e instanceof NotMigratedError) { setNotMigrated(true); setBundles([]); return; }
      setError(e instanceof Error ? e.message : 'Zendingen laden mislukte.');
      setBundles((prev) => prev ?? []);
    }
  }, [organizationId, clientId, currentUserId]);

  useEffect(() => { void load(); }, [load]);

  const open = bundles?.find((b) => b.transfer.id === openId) ?? null;
  if (open) {
    return <TransferDetail
      data={data}
      organizationId={organizationId}
      bundle={open}
      canWrite={canWrite}
      onBack={() => setOpenId(null)}
      onChanged={(next) => {
        setBundles((prev) => (prev ?? []).flatMap((b) => (b.transfer.id === open.transfer.id ? (next ? [next] : []) : [b])));
        if (!next) setOpenId(null);
        onChanged?.();
      }}
    />;
  }

  if (notMigrated) return <p className="share-empty">Bestanden versturen is in deze omgeving nog niet beschikbaar.</p>;
  if (bundles === null) return <p className="share-empty">Zendingen laden…</p>;

  const now = Date.now();
  const shown = bundles.filter((b) => filter === 'all' || ['active', 'draft'].includes(transferState(b.transfer, now)));
  return <div className="xfer-list">
    {error && <p className="error">{error}</p>}
    <div className="xfer-list-head">
      <span className="share-lede">{shown.length === 0 ? (filter === 'active' ? 'Er lopen nu geen zendingen.' : 'Nog niets verstuurd.') : `${shown.length} ${shown.length === 1 ? 'zending' : 'zendingen'}`}</span>
      <Select value={filter} onChange={(e) => setFilter(e.target.value as 'active' | 'all')} inline>
        <option value="active">Lopend</option>
        <option value="all">Alles, ook verlopen</option>
      </Select>
    </div>
    <ul className="share-current xfer-rows">
      {shown.map((bundle) => {
        const state = transferState(bundle.transfer, now);
        const clientName = bundle.transfer.client_id ? data.clients.find((c) => c.id === bundle.transfer.client_id)?.name ?? null : null;
        const active = bundle.recipients.filter((r) => !r.revoked_at);
        const done = downloadedCount(bundle);
        const failed = active.filter((r) => recipientStatus(r).tone === 'danger').length;
        return <li key={bundle.transfer.id}>
          <button type="button" className="xfer-row" onClick={() => setOpenId(bundle.transfer.id)}>
            <span className="share-current-main">
              <strong>{bundle.transfer.subject}</strong>
              <span className="share-person-meta">
                {[clientName, transferSummary(bundle.transfer), bundle.transfer.sent_at ? `verstuurd ${dateNL(bundle.transfer.sent_at)}` : null].filter(Boolean).join(' · ')}
              </span>
              <span className="share-person-meta">
                {state === 'active' ? remainingLabel(bundle.transfer.expires_at, now) : TRANSFER_STATE_LABEL[state]}
                {active.length > 0 ? ` · ${done} van ${active.length} gedownload` : ''}
                {bundle.transfer.ticket_note_id ? ' · bij een ticketantwoord' : ''}
              </span>
            </span>
            <span className={`xfer-state xfer-state-${state}`}>{TRANSFER_STATE_LABEL[state]}</span>
            {failed > 0 && <AlertTriangle size={14} className="xfer-row-warn" aria-label="Een ontvanger heeft aandacht nodig" />}
          </button>
        </li>;
      })}
    </ul>
  </div>;
}

export function TransferDetail({ data, organizationId, bundle: initial, canWrite, onBack, onChanged }: {
  data: AppData;
  organizationId: UUID;
  bundle: FileTransferBundle;
  canWrite: boolean;
  onBack?: () => void;
  /** null = de zending is verwijderd. */
  onChanged?: (bundle: FileTransferBundle | null) => void;
}) {
  const [bundle, setBundle] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [events, setEvents] = useState<FileTransferEvent[] | null>(null);
  const [showEvents, setShowEvents] = useState(false);
  const [extending, setExtending] = useState(false);
  const [expiry, setExpiry] = useState('30');
  const [customDate, setCustomDate] = useState('');
  const [adding, setAdding] = useState(false);
  const [addKeys, setAddKeys] = useState<Set<string>>(new Set());
  const [addEmails, setAddEmails] = useState('');
  const [reading, setReading] = useState<{ title: string; html: string } | null>(null);

  useEffect(() => { setBundle(initial); }, [initial]);

  const { transfer, items, recipients } = bundle;
  const state = transferState(transfer);
  const active = state === 'active';
  const clientName = transfer.client_id ? data.clients.find((c) => c.id === transfer.client_id)?.name ?? null : null;
  const options = useMemo(() => transferRecipientOptions(data, transfer.client_id)
    .filter((o) => !recipients.some((r) => r.email === o.email)), [data, transfer.client_id, recipients]);

  async function run(label: string, action: () => Promise<FileTransferBundle | null>, done?: string) {
    setBusy(label); setError(null); setNotice(null);
    try {
      const next = await action();
      if (next) setBundle(next);
      if (done) setNotice(done);
      onChanged?.(next);
      if (showEvents) setEvents(await loadTransferEvents(organizationId, transfer.id).catch(() => events));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dat lukte niet.');
    } finally {
      setBusy(null);
    }
  }

  async function toggleEvents() {
    const next = !showEvents;
    setShowEvents(next);
    if (next && events === null) {
      try { setEvents(await loadTransferEvents(organizationId, transfer.id)); } catch { setEvents([]); }
    }
  }

  async function openItem(item: FileTransferItem) {
    setError(null);
    try {
      if (item.storage_key) await downloadTransferItem(item);
      else setReading({ title: item.name, html: await loadTransferItemText(organizationId, item.id) });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Openen mislukte.');
    }
  }

  return <div className="xfer-detail">
    {onBack && <button type="button" className="xfer-back" onClick={onBack}><ArrowLeft size={14} /> Alle zendingen</button>}
    <div className="xfer-detail-head">
      <div>
        <h4>{transfer.subject}</h4>
        <p className="share-person-meta">
          {[clientName, transferSummary(transfer), transfer.sender_name ? `door ${transfer.sender_name}` : null, transfer.sent_at ? dateNL(transfer.sent_at) : null].filter(Boolean).join(' · ')}
        </p>
      </div>
      <span className={`xfer-state xfer-state-${state}`}>{TRANSFER_STATE_LABEL[state]}</span>
    </div>

    {error && <p className="error">{error}</p>}
    {notice && <p className="xfer-notice"><Mail size={13} /> {notice}</p>}

    <p className="share-hint">
      <Lock size={12} />
      {state === 'active' && `Beschikbaar tot ${dateNL(transfer.expires_at)} (${remainingLabel(transfer.expires_at)}). Daarna worden de bestanden verwijderd.`}
      {state === 'expired' && `Verlopen op ${dateNL(transfer.expires_at)}; de bestanden zijn (of worden) verwijderd.`}
      {state === 'revoked' && `Ingetrokken${transfer.revoked_at ? ` op ${dateNL(transfer.revoked_at)}` : ''}; de links werken niet meer en de bestanden zijn verwijderd.`}
      {state === 'draft' && 'Nog niet verstuurd.'}
      {!transfer.can_download && ' Downloaden staat uit.'}
    </p>

    {transfer.message && <p className="share-public-message xfer-message">{transfer.message}</p>}

    <section className="share-section">
      <h4><UserRound size={14} /> Ontvangers</h4>
      {recipients.length === 0
        ? <p className="share-empty">{transfer.ticket_note_id ? 'Bij een ticketantwoord: iedereen die het ticket in het portaal ziet, kan de bestanden openen.' : 'Geen ontvangers.'}</p>
        : <ul className="share-current">
            {recipients.map((recipient) => {
              const status = recipientStatus(recipient);
              return <li key={recipient.id}>
                <div className="share-current-main">
                  <strong>{recipientLabel(recipient)}</strong>
                  <span className="share-person-meta">
                    <span className={`xfer-dot xfer-tone-${status.tone}`} /> {status.label}
                    {recipient.last_downloaded_at ? ` · laatst ${dateNL(recipient.last_downloaded_at)}` : recipient.last_opened_at ? ` · geopend ${dateNL(recipient.last_opened_at)}` : ''}
                    {recipient.notify_error ? ` · ${recipient.notify_error}` : ''}
                  </span>
                </div>
                {canWrite && active && !recipient.revoked_at && <div className="share-current-actions">
                  <button type="button" disabled={busy !== null} onClick={() => void run(`resend-${recipient.id}`, async () => (await resendTransfer(organizationId, transfer.id, recipient.id)).bundle, `Opnieuw gemaild naar ${recipient.email}. De vorige link werkt niet meer.`)} title="Opnieuw mailen met een nieuwe link">
                    <Send size={13} /> Opnieuw
                  </button>
                  <button type="button" className="danger" disabled={busy !== null} onClick={() => {
                    if (!window.confirm(`De toegang van ${recipient.email} intrekken?`)) return;
                    void run(`revoke-${recipient.id}`, () => revokeTransferRecipient(organizationId, transfer.id, recipient.id));
                  }}><X size={13} /> Intrekken</button>
                </div>}
              </li>;
            })}
          </ul>}

      {canWrite && active && !transfer.ticket_note_id && (adding
        ? <div className="xfer-add-recipients">
            {transfer.client_id
              ? (options.length === 0
                  ? <p className="share-empty">Iedereen van deze klant staat er al bij. Voeg een contactpersoon toe op de klantkaart.</p>
                  : <ul className="share-people">{options.map((option) => <li key={option.key}>
                      <label><input type="checkbox" checked={addKeys.has(option.key)} onChange={() => setAddKeys((prev) => { const next = new Set(prev); if (next.has(option.key)) next.delete(option.key); else next.add(option.key); return next; })} />
                        <span className="share-person"><strong>{option.name}</strong><span className="share-person-meta">{option.email}</span></span></label>
                    </li>)}</ul>)
              : <Input value={addEmails} placeholder="naam@bedrijf.nl, ander@bedrijf.nl" onChange={(e) => setAddEmails(e.target.value)} />}
            <div className="xfer-inline-actions">
              <Button variant="primary" disabled={busy !== null} onClick={() => {
                const recipientsInput = transfer.client_id
                  ? recipientInputs(options.filter((o) => addKeys.has(o.key)))
                  : parseLooseEmails(addEmails).emails.map((email) => ({ kind: 'email', email }));
                if (recipientsInput.length === 0) { setError('Kies wie je wilt toevoegen.'); return; }
                void run('add', async () => {
                  const outcome = await addTransferRecipients(organizationId, transfer.id, recipientsInput);
                  const failed = outcome.results.filter((r) => r.error);
                  if (failed.length) setError(failed.map((r) => `${r.email ?? 'Ontvanger'}: ${r.error}`).join(' '));
                  setAdding(false); setAddKeys(new Set()); setAddEmails('');
                  return outcome.bundle;
                }, 'Toegevoegd en gemaild.');
              }}>Toevoegen en mailen</Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>Annuleren</Button>
            </div>
          </div>
        : <button type="button" className="xfer-link-btn" onClick={() => setAdding(true)} disabled={busy !== null}><Plus size={13} /> Iemand toevoegen</button>)}
    </section>

    <section className="share-section">
      <h4><FileText size={14} /> {fileCountLabel(items.length)} <span className="share-tag">{formatBytes(transfer.total_bytes)}</span></h4>
      <ul className="xfer-items">
        {items.map((item) => <li key={item.id} className={item.purged_at ? 'is-purged' : undefined}>
          <span className="xfer-item-ic">{item.storage_key ? <FileText size={15} /> : <StickyNote size={15} />}</span>
          <span className="xfer-item-main">
            <strong>{item.name}</strong>
            <span>{[item.path, item.storage_key ? formatBytes(item.size_bytes) : 'tekst', item.purged_at ? 'verwijderd' : null].filter(Boolean).join(' · ')}</span>
          </span>
          {!item.purged_at && <button type="button" className="xfer-item-open" onClick={() => void openItem(item)} title={item.storage_key ? 'Downloaden' : 'Lezen'}>
            {item.storage_key ? <Download size={14} /> : <FileText size={14} />}
          </button>}
        </li>)}
      </ul>
    </section>

    {canWrite && <section className="share-section xfer-actions">
      {active && (extending
        ? <div className="xfer-extend">
            <label className="share-option"><span>Nieuwe vervaldatum</span>
              <Select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {TRANSFER_EXPIRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.days ? `${o.label} vanaf nu` : o.label}</option>)}
              </Select>
            </label>
            {expiry === 'custom' && <Input type="date" value={customDate} min={minExpiryDate()} max={maxExpiryDate()} onChange={(e) => setCustomDate(e.target.value)} />}
            <div className="xfer-inline-actions">
              <Button variant="primary" disabled={busy !== null} onClick={() => {
                const value = expiryForServer(expiry, customDate);
                if (value === null) { setError('Kies een datum.'); return; }
                void run('extend', () => extendTransfer(organizationId, transfer.id, value), 'Vervaldatum aangepast.');
                setExtending(false);
              }}>Opslaan</Button>
              <Button variant="ghost" onClick={() => setExtending(false)}>Annuleren</Button>
            </div>
          </div>
        : <Button onClick={() => setExtending(true)} disabled={busy !== null}><CalendarClock size={14} /> Vervaldatum aanpassen</Button>)}
      {active && <Button variant="danger" disabled={busy !== null} onClick={() => {
        if (!window.confirm('Alle links intrekken? De bestanden worden meteen verwijderd; dit kun je niet ongedaan maken.')) return;
        void run('revoke', () => revokeTransfer(organizationId, transfer.id), 'Ingetrokken. De bestanden zijn verwijderd.');
      }}><RotateCcw size={14} /> Intrekken</Button>}
      <Button variant="ghost" disabled={busy !== null} onClick={() => {
        if (!window.confirm('Deze zending helemaal verwijderen, met het overzicht van wie wat kreeg? De bestanden gaan ook weg.')) return;
        void run('delete', async () => { await deleteTransfer(organizationId, transfer.id); return null; });
      }}><Trash2 size={14} /> Verwijderen</Button>
      <Button variant="ghost" onClick={() => void toggleEvents()}><History size={14} /> {showEvents ? 'Logboek verbergen' : 'Logboek'}</Button>
    </section>}

    {showEvents && <section className="share-section">
      <h4><History size={14} /> Logboek</h4>
      {events === null ? <p className="share-empty">Laden…</p> : events.length === 0 ? <p className="share-empty">Nog niets vastgelegd.</p>
        : <ul className="xfer-events">{events.map((event) => {
            const who = event.recipient_id ? recipients.find((r) => r.id === event.recipient_id) : null;
            const what = event.item_id ? items.find((i) => i.id === event.item_id)?.name : null;
            return <li key={event.id}>
              <span className="xfer-event-when">{new Date(event.created_at).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
              <span>{eventLabel(event.kind)}{who ? ` — ${who.name || who.email}` : ''}{what ? ` · ${what}` : ''}{event.detail ? ` (${event.detail})` : ''}</span>
            </li>;
          })}</ul>}
    </section>}

    {reading && <ReadModal title={reading.title} html={reading.html} onClose={() => setReading(null)} />}
  </div>;
}

function eventLabel(kind: FileTransferEvent['kind']): string {
  const labels: Record<FileTransferEvent['kind'], string> = {
    sent: 'Verstuurd', resent: 'Opnieuw gemaild', recipient_added: 'Ontvanger toegevoegd',
    delivered: 'Mail afgeleverd', bounced: 'Mail kwam niet aan', complained: 'Gemeld als spam', failed: 'Mail mislukt',
    code_sent: 'Code aangevraagd', code_failed: 'Verkeerde code', code_locked: 'Op slot na te veel pogingen',
    opened: 'Geopend', downloaded: 'Gedownload', zip_downloaded: 'Alles als zip gedownload',
    extended: 'Vervaldatum aangepast', revoked: 'Ingetrokken', recipient_revoked: 'Toegang ingetrokken',
    expired: 'Verlopen', purged: 'Bestanden verwijderd',
  };
  return labels[kind] ?? kind;
}

/**
 * Het blokje onder een bericht met bestanden (Berichten, klantdossier):
 * aantal, termijn en hoe deze ontvanger erbij staat, met de details erachter.
 */
export function TransferMessageBlock({ data, organizationId, bundle, recipientId, canWrite, onChanged }: {
  data: AppData;
  organizationId: UUID;
  bundle: FileTransferBundle;
  recipientId: UUID | null;
  canWrite: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(bundle);
  useEffect(() => { setCurrent(bundle); }, [bundle]);
  const recipient = current.recipients.find((r) => r.id === recipientId) ?? null;
  const state = transferState(current.transfer);
  const status = recipient ? recipientStatus(recipient) : null;
  return <div className="xfer-msg-block">
    <button type="button" className="xfer-msg-head" onClick={() => setOpen((v) => !v)}>
      <FileText size={14} />
      <span><strong>{fileCountLabel(current.transfer.item_count)}</strong> · {formatBytes(current.transfer.total_bytes)}</span>
      <span className={`xfer-state xfer-state-${state}`}>{state === 'active' ? remainingLabel(current.transfer.expires_at) : TRANSFER_STATE_LABEL[state]}</span>
      {status && <span className="share-person-meta"><span className={`xfer-dot xfer-tone-${status.tone}`} /> {status.label}</span>}
    </button>
    {open && <div className="xfer-msg-detail">
      <TransferDetail
        data={data}
        organizationId={organizationId}
        bundle={current}
        canWrite={canWrite}
        onChanged={async (next) => {
          if (next) setCurrent(next);
          else {
            const reloaded = await loadTransferBundle(organizationId, current.transfer.id).catch(() => null);
            if (reloaded) setCurrent(reloaded);
          }
          onChanged?.();
        }}
      />
    </div>}
  </div>;
}
