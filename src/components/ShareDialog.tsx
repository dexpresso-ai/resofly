import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, Copy, Download, FileText, Link2, Mail, RefreshCw, RotateCcw, Send, Trash2, UserRound, Users,
} from 'lucide-react';
import type { AppData, ClientContact, DriveShare, OrganizationMember } from '../types';
import { Modal } from './Modal';
import { Button, Input, Select, Textarea } from './Ui';
import { dateNL } from '../lib/format';
import { supabaseAuth } from '../lib/supabase';
import { memberEmail, memberName } from '../lib/members';
import {
  createPageRelease, loadOrganizationMembers, loadPageShareStatus, releasePageToShares, resendDriveShareNotice,
  revokeDriveShare, shareDriveItem, updateClientContact, updateDriveShare,
  type DriveShareRecipientInput, type DriveShareResult, type PageShareStatus,
} from '../lib/repository';
import { subpagesOf } from '../lib/pageTree';
import {
  SHARE_EXPIRY_OPTIONS, SHARE_ITEM_LABEL, activeSharesFor, expiryToIso,
  resolveShareContext, shareChannelLabel, shareRecipientLabel, type ShareTarget,
} from '../lib/shares';

/**
 * "Delen" voor een map, bestand, notitie of document uit de drive.
 *
 * De regel die dit venster zichtbaar maakt: hoort het item bij een klantdossier,
 * dan kán er alleen met de geregistreerde contactpersonen van diezelfde klant
 * worden gedeeld — geen deellink naar een los adres. Het venster laat dan ook
 * niets anders zien. Het echte slot zit in de database (trigger
 * `drive_shares_guard`); dit scherm zorgt er alleen voor dat je er niet tegenaan
 * loopt.
 *
 * Een pagina (stap 1C) delen is vrijgeven: de ontvanger ziet de versie van nu,
 * en wat je daarna wijzigt pas na "Bijwerken bij klant". Subpagina's vink je
 * apart aan; elke wordt een eigen deling, met een eigen vrijgave.
 */
export function ShareDialog({
  data, organizationId, target, onClose, onChanged, beforeShare,
}: {
  data: AppData;
  organizationId: string;
  target: ShareTarget;
  onClose: () => void;
  onChanged: () => void;
  /** Vanuit de editor: eerst opslaan wat er nog staat, want de vrijgave neemt de opgeslagen pagina. */
  beforeShare?: () => Promise<void>;
}) {
  const context = useMemo(() => resolveShareContext(data, target.type, target.id), [data, target.type, target.id]);
  const isClientRelated = Boolean(context.clientId);

  const contacts = useMemo<ClientContact[]>(() => (
    context.clientId
      ? data.clientContacts
        .filter(c => c.client_id === context.clientId && c.is_active)
        .sort((a, b) => a.name.localeCompare(b.name, 'nl'))
      : []
  ), [data.clientContacts, context.clientId]);

  const existing = useMemo(() => activeSharesFor(data, target.type, target.id), [data, target.type, target.id]);

  const isPage = target.type === 'document' && data.documents.some(d => d.id === target.id && d.format === 'page');
  const subpages = useMemo(() => (isPage
    ? subpagesOf(data.documents.filter(d => d.format === 'page').map(d => ({
      id: d.id, title: d.title, parent_id: d.parent_id ?? null, folder_id: d.folder_id,
      client_id: d.client_id, project_id: d.project_id, position: d.position ?? null,
    })), target.id)
    : []), [isPage, data.documents, target.id]);
  const [subpageIds, setSubpageIds] = useState<string[]>([]);
  /** Per lopende deling van een pagina: welke versie de ontvanger ziet. */
  const [pageStatus, setPageStatus] = useState<Map<string, PageShareStatus>>(new Map());
  const [releasing, setReleasing] = useState(false);
  const [pageNote, setPageNote] = useState<string | null>(null);
  const reloadPageStatus = useCallback(async () => {
    if (!isPage) return;
    try {
      const rows = await loadPageShareStatus(target.id);
      setPageStatus(new Map(rows.map(row => [row.share_id, row])));
    } catch {
      // Zonder status geen knop "Bijwerken bij klant"; delen zelf werkt gewoon.
    }
  }, [isPage, target.id]);
  useEffect(() => { void reloadPageStatus(); }, [reloadPageStatus, existing.length]);
  const outdated = existing.filter(share => pageStatus.get(share.id)?.is_current === false);

  // Het hoofdadres van de klant (de klantkaart) kan ook iets ontvangen; dat
  // logt al in op het portaal. Alleen als het een geldig adres is.
  const clientRow = context.clientId ? data.clients.find(c => c.id === context.clientId) ?? null : null;
  const mainEmail = String(clientRow?.email ?? '').trim().toLowerCase();
  const hasMainAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mainEmail);
  const mainAlreadyShared = existing.some(s => s.recipient_kind === 'client');
  const [shareWithMain, setShareWithMain] = useState(false);

  const [members, setMembers] = useState<OrganizationMember[] | null>(null);
  /** Je deelt niet met jezelf; wie "jij" is halen we uit de sessie i.p.v. via zes prop-lagen. */
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [contactIds, setContactIds] = useState<string[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [linkRecipients, setLinkRecipients] = useState<string[]>([]);
  const [emailDraft, setEmailDraft] = useState('');
  const [expiry, setExpiry] = useState('30');
  const [canDownload, setCanDownload] = useState(true);
  const [notify, setNotify] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<DriveShareResult[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Collega's worden pas geladen als het venster opengaat; de drive zelf heeft ze niet nodig.
  useEffect(() => {
    let cancelled = false;
    loadOrganizationMembers(organizationId)
      .then(rows => { if (!cancelled) setMembers(rows.filter(m => m.status === 'active')); })
      .catch(() => { if (!cancelled) setMembers([]); });
    return () => { cancelled = true; };
  }, [organizationId]);

  useEffect(() => {
    let cancelled = false;
    supabaseAuth.getUser()
      .then(({ data: auth }) => { if (!cancelled) setCurrentUserId(auth.user?.id ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const alreadySharedContactIds = new Set(existing.map(s => s.client_contact_id).filter(Boolean) as string[]);
  const alreadySharedMemberIds = new Set(existing.map(s => s.member_user_id).filter(Boolean) as string[]);
  const alreadySharedEmails = new Set(
    existing.filter(s => s.recipient_kind === 'link').map(s => (s.recipient_email ?? '').toLowerCase()),
  );

  // Pas tonen als we weten wie "jij" bent; anders sta je even in je eigen lijst en
  // kun je jezelf aanvinken (wat de database daarna gewoon accepteert).
  const membersReady = members !== null && currentUserId !== null;
  const selectableMembers = (members ?? []).filter(m => m.user_id && m.user_id !== currentUserId);
  const chosenCount = contactIds.length + memberIds.length + linkRecipients.length + (shareWithMain ? 1 : 0);

  function toggle(list: string[], setList: (next: string[]) => void, id: string) {
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
  }

  function addLinkRecipient() {
    const email = emailDraft.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Vul een geldig e-mailadres in.'); return; }
    if (linkRecipients.includes(email) || alreadySharedEmails.has(email)) {
      setError('Dit adres staat er al bij.');
      return;
    }
    setError(null);
    setLinkRecipients(list => [...list, email]);
    setEmailDraft('');
  }

  async function enablePortalAccess(contact: ClientContact) {
    setBusyShareId(contact.id); setError(null);
    try {
      await updateClientContact(contact.id, { gives_portal_access: true }, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Portaaltoegang aanzetten mislukt.');
    } finally {
      setBusyShareId(null);
    }
  }

  async function submit() {
    if (chosenCount === 0) { setError('Kies minstens één ontvanger.'); return; }
    setBusy(true); setError(null); setPageNote(null);
    try {
      const recipients: DriveShareRecipientInput[] = [
        ...(shareWithMain ? [{ kind: 'client' as const }] : []),
        ...contactIds.map(id => ({ kind: 'contact' as const, clientContactId: id })),
        ...memberIds.map(id => ({ kind: 'member' as const, memberUserId: id })),
        ...linkRecipients.map(email => ({ kind: 'link' as const, email })),
      ];
      const expiresAt = expiryToIso(expiry);
      // Een pagina: eerst opslaan, dan de vrijgave. Die versie ziet de ontvanger.
      if (isPage && beforeShare) await beforeShare();
      const outcome = await shareDriveItem({
        organizationId,
        itemType: target.type,
        itemId: target.id,
        itemName: target.name,
        recipients,
        canDownload: isPage ? false : canDownload,
        expiresAt,
        message: message.trim() || null,
        notify,
        documentVersionId: isPage ? await createPageRelease(target.id) : null,
      });
      setResults(outcome);
      if (isPage && subpageIds.length > 0) setPageNote(await shareSubpages(recipients, expiresAt));
      setContactIds([]); setMemberIds([]); setLinkRecipients([]); setMessage(''); setShareWithMain(false); setSubpageIds([]);
      onChanged();
      void reloadPageStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delen is niet gelukt.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * De aangevinkte subpagina's: elk een eigen vrijgave en deling, zonder eigen
   * mail (de ontvanger kreeg er al een, en ziet ze in het portaal). Niet via
   * een deellink: die is één pagina, en de link naar een subpagina zou
   * niemand krijgen.
   */
  async function shareSubpages(recipients: DriveShareRecipientInput[], expiresAt: string | null): Promise<string> {
    const forSubpages = recipients.filter(recipient => recipient.kind !== 'link');
    if (forSubpages.length === 0) return 'Subpagina\'s gaan niet mee via een deellink; deel ze apart.';
    const failed: string[] = [];
    let shared = 0;
    for (const { page } of subpages.filter(({ page }) => subpageIds.includes(page.id))) {
      try {
        const outcome = await shareDriveItem({
          organizationId, itemType: 'document', itemId: page.id, itemName: page.title,
          recipients: forSubpages, canDownload: false, expiresAt, message: null, notify: false,
          documentVersionId: await createPageRelease(page.id),
        });
        const error = outcome.find(result => result.share === null)?.error;
        if (error) failed.push(`${page.title || 'Naamloze pagina'}: ${error}`); else shared += 1;
      } catch (e) {
        failed.push(`${page.title || 'Naamloze pagina'}: ${e instanceof Error ? e.message : 'niet gelukt'}`);
      }
    }
    const done = shared === 1 ? 'Ook 1 subpagina gedeeld.' : shared > 1 ? `Ook ${shared} subpagina's gedeeld.` : '';
    return [done, failed.length ? `Niet gelukt: ${failed.join('; ')}` : ''].filter(Boolean).join(' ');
  }

  /** "Bijwerken bij klant": iedereen met wie de pagina gedeeld is, ziet daarna de pagina van nu. */
  async function releaseToShares() {
    setReleasing(true); setError(null); setPageNote(null);
    try {
      if (beforeShare) await beforeShare();
      const count = await releasePageToShares(target.id);
      setPageNote(count === 0 ? 'Iedereen ziet de pagina van nu al.' : count === 1 ? 'Bijgewerkt: de ontvanger ziet nu de pagina van nu.' : `Bijgewerkt: ${count} ontvangers zien nu de pagina van nu.`);
      await reloadPageStatus();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bijwerken is niet gelukt.');
    } finally {
      setReleasing(false);
    }
  }

  async function revoke(share: DriveShare) {
    if (!window.confirm(`Toegang van ${shareRecipientLabel(share)} intrekken?`)) return;
    setBusyShareId(share.id); setError(null);
    try {
      await revokeDriveShare(share.id, organizationId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Intrekken mislukt.');
    } finally {
      setBusyShareId(null);
    }
  }

  /** Downloaden aan/uit voor een lopende deling — zonder opnieuw te hoeven delen. */
  async function toggleDownload(share: DriveShare) {
    setBusyShareId(share.id); setError(null);
    try {
      await updateDriveShare(share.id, organizationId, { can_download: !share.can_download });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bijwerken mislukt.');
    } finally {
      setBusyShareId(null);
    }
  }

  async function resend(share: DriveShare) {
    setBusyShareId(share.id); setError(null);
    try {
      const result = await resendDriveShareNotice(organizationId, share.id);
      setResults([result]);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'De melding opnieuw versturen is niet gelukt.');
    } finally {
      setBusyShareId(null);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied(current => (current === value ? null : current)), 2000);
    } catch {
      setError('Kopiëren lukte niet. Selecteer de link en kopieer hem handmatig.');
    }
  }

  const kindLabel = isPage ? 'Pagina' : SHARE_ITEM_LABEL[target.type];

  return <Modal
    title={`${kindLabel} delen`}
    className={`share-modal${isPage ? ' share-modal-page' : ''}`}
    onClose={onClose}
    footer={<>
      <Button onClick={onClose} disabled={busy}>Sluiten</Button>
      <Button variant="primary" onClick={submit} disabled={busy || chosenCount === 0}>
        {busy ? 'Bezig…' : chosenCount > 0 ? `Deel met ${chosenCount} ${chosenCount === 1 ? 'persoon' : 'mensen'}` : 'Delen'}
      </Button>
    </>}
  >
    <p className="share-lede">
      <strong>{target.name}</strong>
      {target.type === 'folder' && <span> — alles wat er nu in deze map zit gaat mee, submappen inbegrepen. Wat je er later in zet, deel je apart.</span>}
      {isPage && <span> — de ontvanger ziet de pagina zoals ze nu is. Wat je daarna wijzigt, ziet hij pas als je “Bijwerken bij klant” kiest.</span>}
    </p>

    {isClientRelated
      ? <div className="share-rule">
          <UserRound size={16} />
          <span>
            Dit hoort bij klantdossier <strong>{context.clientName ?? 'onbekend'}</strong>. Klantgerelateerde
            bestanden gaan alleen naar de geregistreerde contactpersonen van deze klant — een open deellink
            naar een los e-mailadres kan hier niet.
          </span>
        </div>
      : <div className="share-rule is-open">
          <Link2 size={16} />
          <span>Dit item hangt niet aan een klantdossier. Je kunt het met collega's delen of met een deellink naar een e-mailadres.</span>
        </div>}

    {error && <p className="error">{error}</p>}

    {isClientRelated && <section className="share-section">
      <h4><UserRound size={14} /> {context.clientName ?? 'Deze klant'}</h4>
      {hasMainAddress && <ul className="share-people">
        <li className={mainAlreadyShared ? 'is-shared' : undefined}>
          <label>
            <input type="checkbox" checked={shareWithMain} disabled={busy || mainAlreadyShared} onChange={() => setShareWithMain(v => !v)} />
            <span className="share-person">
              <strong>{clientRow?.contact_name?.trim() || clientRow?.name}</strong>
              <span className="share-person-meta">{mainEmail} · hoofdadres</span>
            </span>
          </label>
          {mainAlreadyShared && <span className="share-tag">Al gedeeld</span>}
        </li>
      </ul>}
      {contacts.length === 0 && !hasMainAddress
        ? <p className="share-empty">
            Deze klant heeft nog geen actieve contactpersonen. Voeg ze toe in het klantdossier onder
            “Contactpersonen”; daarna kun je hier met ze delen.
          </p>
        : <ul className="share-people">
            {contacts.map(contact => {
              const already = alreadySharedContactIds.has(contact.id);
              return <li key={contact.id} className={already ? 'is-shared' : undefined}>
                <label>
                  <input
                    type="checkbox"
                    checked={contactIds.includes(contact.id)}
                    disabled={busy || !contact.gives_portal_access}
                    onChange={() => toggle(contactIds, setContactIds, contact.id)}
                  />
                  <span className="share-person">
                    <strong>{contact.name}</strong>
                    <span className="share-person-meta">
                      {contact.email}{contact.role ? ` · ${contact.role}` : ''}
                    </span>
                  </span>
                </label>
                {already && <span className="share-tag">Al gedeeld</span>}
                {!contact.gives_portal_access && <span className="share-warn">
                  <AlertTriangle size={13} /> Geen portaaltoegang
                  <button type="button" disabled={busyShareId === contact.id} onClick={() => enablePortalAccess(contact)}>
                    Aanzetten
                  </button>
                </span>}
              </li>;
            })}
          </ul>}
      {contacts.some(c => !c.gives_portal_access) && <p className="share-hint">
        Zonder portaaltoegang kan een contactpersoon niet inloggen op het klantportaal en het gedeelde bestand dus
        niet openen; daarom staat die regel op slot. “Aanzetten” geeft deze persoon toegang tot het hele
        klantportaal van deze klant — dus ook tot facturen, offertes en tickets.
      </p>}
    </section>}

    <section className="share-section">
      <h4><Users size={14} /> Collega's</h4>
      {!membersReady
        ? <p className="share-empty">Collega's laden…</p>
        : selectableMembers.length === 0
          ? <p className="share-empty">Er zijn geen andere teamleden in deze organisatie.</p>
          : <ul className="share-people">
              {selectableMembers.map(member => {
                const userId = member.user_id as string;
                const already = alreadySharedMemberIds.has(userId);
                return <li key={member.id} className={already ? 'is-shared' : undefined}>
                  <label>
                    <input
                      type="checkbox"
                      checked={memberIds.includes(userId)}
                      disabled={busy}
                      onChange={() => toggle(memberIds, setMemberIds, userId)}
                    />
                    <span className="share-person">
                      <strong>{memberName(userId, members, currentUserId)}</strong>
                      <span className="share-person-meta">{memberEmail(member)}</span>
                    </span>
                  </label>
                  {already && <span className="share-tag">Al gedeeld</span>}
                </li>;
              })}
            </ul>}
      <p className="share-hint">Collega's hebben al toegang tot deze werkruimte; ze krijgen een melding met een link ernaartoe.</p>
    </section>

    {!isClientRelated && <section className="share-section">
      <h4><Link2 size={14} /> Deellink per e-mail</h4>
      <div className="share-email-row">
        <Input
          type="email"
          value={emailDraft}
          placeholder="naam@bedrijf.nl"
          disabled={busy}
          onChange={e => setEmailDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addLinkRecipient(); } }}
        />
        <Button onClick={addLinkRecipient} disabled={busy || !emailDraft.trim()}>Toevoegen</Button>
      </div>
      {linkRecipients.length > 0 && <ul className="share-chips">
        {linkRecipients.map(email => <li key={email}>
          <Mail size={13} /> {email}
          <button type="button" aria-label={`${email} verwijderen`} disabled={busy} onClick={() => setLinkRecipients(list => list.filter(x => x !== email))}>×</button>
        </li>)}
      </ul>}
      <p className="share-hint">Iedereen met de link kan erbij. Stuur hem alleen naar mensen die hem mogen hebben.</p>
    </section>}

    {isPage && subpages.length > 0 && <section className="share-section share-subpages">
      <h4><FileText size={14} /> Subpagina's</h4>
      <label className="share-toggle">
        <input
          type="checkbox"
          checked={subpageIds.length === subpages.length}
          disabled={busy}
          onChange={e => setSubpageIds(e.target.checked ? subpages.map(({ page }) => page.id) : [])}
        />
        <span>Alle subpagina's</span>
      </label>
      <ul className="share-people share-subpage-list">
        {subpages.map(({ page, depth }) => <li key={page.id} style={{ paddingLeft: (depth - 1) * 18 }}>
          <label>
            <input type="checkbox" checked={subpageIds.includes(page.id)} disabled={busy} onChange={() => toggle(subpageIds, setSubpageIds, page.id)} />
            <span className="share-person"><strong>{page.title || 'Naamloze pagina'}</strong></span>
          </label>
        </li>)}
      </ul>
      <p className="share-hint">
        Elke subpagina die je aanvinkt, wordt een eigen deling met haar eigen versie. Een subpagina die je niet
        aanvinkt, ziet de ontvanger niet, ook haar titel niet. Via een deellink gaat alleen deze pagina mee.
      </p>
    </section>}

    <section className="share-section">
      <h4>Instellingen</h4>
      <div className="share-options">
        <label className="share-option">
          <span>Vervaldatum</span>
          <Select value={expiry} onChange={e => setExpiry(e.target.value)} disabled={busy}>
            {SHARE_EXPIRY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
        </label>
        {!isPage && <label className="share-toggle">
          <input type="checkbox" checked={canDownload} disabled={busy} onChange={e => setCanDownload(e.target.checked)} />
          <span>Downloaden toestaan<em>Laat je dit uit, dan kan de ontvanger alleen kijken.</em></span>
        </label>}
        <label className="share-toggle">
          <input type="checkbox" checked={notify} disabled={busy} onChange={e => setNotify(e.target.checked)} />
          <span>Stuur een e-mail met de link<em>Zet je dit uit, dan deel je stilletjes; de ontvanger ziet het pas als hij zelf kijkt.</em></span>
        </label>
      </div>
      <label className="share-message">
        <span>Bericht (optioneel)</span>
        <Textarea
          value={message}
          rows={3}
          maxLength={2000}
          placeholder="Hoi, hierbij de stukken die we net bespraken."
          disabled={busy}
          onChange={e => setMessage(e.target.value)}
        />
      </label>
    </section>

    {pageNote && <p className="share-hint share-page-note" role="status">{pageNote}</p>}

    {results && results.length > 0 && <section className="share-section share-results">
      <h4><Check size={14} /> {results.every(r => r.share === null) ? 'Niet gelukt' : 'Gedeeld'}</h4>
      <ul>
        {results.map((result, index) => result.share === null
          ? <li key={`fail-${index}`}>
              <p className="share-warn-line"><AlertTriangle size={13} /> {result.error}</p>
            </li>
          : <li key={result.share.id}>
          <div className="share-result-line">
            <strong>{shareRecipientLabel(result.share)}</strong>
            <span className="share-tag">{shareChannelLabel(result.share)}</span>
          </div>
          {result.url && <div className="share-link-row">
            <code>{result.url}</code>
            <Button onClick={() => copy(result.url!)}>{copied === result.url ? 'Gekopieerd' : <><Copy size={13} /> Kopieer</>}</Button>
          </div>}
          {result.url && <p className="share-hint">Bewaar deze link nu: hij is later niet meer op te vragen. Opnieuw versturen maakt een nieuwe link.</p>}
          {result.notifyError && <p className="share-warn-line"><AlertTriangle size={13} /> {result.notifyError}</p>}
          {!result.notifyError && result.notified && <p className="share-hint">De melding is per e-mail verstuurd.</p>}
        </li>)}
      </ul>
    </section>}

    <section className="share-section">
      <h4>Wie heeft nu toegang</h4>
      {isPage && outdated.length > 0 && <div className="share-rule share-outdated">
        <AlertTriangle size={16} />
        <span>De klant ziet een oudere versie: wat je sindsdien wijzigde, staat er nog niet in.</span>
        <Button onClick={() => void releaseToShares()} disabled={releasing || busy}>
          <RefreshCw size={13} /> {releasing ? 'Bezig…' : 'Bijwerken bij klant'}
        </Button>
      </div>}
      {existing.length === 0
        ? <p className="share-empty">Nog met niemand gedeeld.</p>
        : <ul className="share-current">
            {existing.map(share => <li key={share.id}>
              <div className="share-current-main">
                <strong>{shareRecipientLabel(share)}</strong>
                <span className="share-person-meta">
                  {shareChannelLabel(share)}
                  {isPage ? '' : share.can_download ? ' · mag downloaden' : ' · alleen bekijken'}
                  {share.expires_at ? ` · tot ${dateNL(share.expires_at)}` : ''}
                  {share.last_viewed_at ? ` · laatst bekeken ${dateNL(share.last_viewed_at)}` : ''}
                </span>
                {isPage && pageStatus.get(share.id) && <span className="share-person-meta">
                  Ziet versie {pageStatus.get(share.id)?.version ?? '?'}
                  {pageStatus.get(share.id)?.released_at ? ` van ${dateNL(pageStatus.get(share.id)?.released_at as string)}` : ''}
                  {pageStatus.get(share.id)?.is_current === false && <span className="share-tag is-outdated">Oudere versie</span>}
                </span>}
              </div>
              <div className="share-current-actions">
                {!isPage && <button type="button" disabled={busyShareId === share.id} onClick={() => toggleDownload(share)} title="Downloaden aan- of uitzetten">
                  <Download size={14} /> {share.can_download ? 'Downloaden uit' : 'Downloaden aan'}
                </button>}
                <button type="button" disabled={busyShareId === share.id} onClick={() => resend(share)} title="Melding opnieuw versturen">
                  <Send size={14} /> Opnieuw sturen
                </button>
                <button type="button" className="danger" disabled={busyShareId === share.id} onClick={() => revoke(share)} title="Toegang intrekken">
                  <Trash2 size={14} /> Intrekken
                </button>
              </div>
            </li>)}
          </ul>}
      {existing.some(s => s.recipient_kind === 'link') && <p className="share-hint">
        <RotateCcw size={12} /> Een deellink is na versturen niet meer op te vragen. “Opnieuw sturen” maakt een nieuwe link en maakt de oude ongeldig.
      </p>}
    </section>
  </Modal>;
}
