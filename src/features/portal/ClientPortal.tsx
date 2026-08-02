import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Textarea } from '../../components/Ui';
import { isSupabaseConfigured } from '../../lib/supabase';
import { supabasePortalAuth } from '../../lib/supabasePortal';
import {
  addPortalTicketNote,
  createPortalTicket,
  createPortalInvoicePayment,
  decidePortalQuote,
  downloadPortalContractPdf,
  downloadPortalInvoicePdf,
  fetchPortalData,
  fetchPortalGalleryDetail,
  fetchPortalInvoicePaymentInfo,
  fetchPortalProjectDetail,
  fetchPortalTicketThread,
  requestPortalLogin,
  togglePortalGalleryFavorite,
  type PortalAccount,
  type PortalContract,
  type PortalGallery,
  type PortalGalleryDetail,
  type PortalInvoice,
  type PortalInvoicePaymentInfo,
  type PortalProject,
  type PortalQuote,
  type PortalTask,
  type PortalTicket,
  type PortalTicketNote,
  type PortalTicketThread,
} from '../../lib/portalApi';
import { dateNL, euro, lineGross, priorityLabel, total } from '../../lib/format';
import type { FinanceLine, Priority } from '../../types';
import { GalleryViewer, type GalleryViewerItem } from '../GalleryViewer';
import { galleryFileUrl, galleryRefreshDelayMs, galleryZipUrl, streamDownloadUrl } from '../../lib/gallery';
import { brandStyle, ensureBrandFontsLoaded } from '../../lib/branding';

type PortalTab = 'overview' | 'invoices' | 'quotes' | 'contracts' | 'tickets' | 'projects' | 'galleries';

/**
 * Klantportaal-root. Aparte route (/portal) met een eigen, wachtwoordloze login
 * (magische e-maillink). Na inloggen ziet de klant uitsluitend zijn eigen
 * facturen, offertes, tickets en projecten — opgehaald via de `client-portal`
 * edge function, die de toegang afleidt uit het geverifieerde e-mailadres.
 */
export function ClientPortal() {
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    let active = true;
    supabasePortalAuth.getSession().then(({ data }) => {
      if (!active) return;
      setLoggedIn(Boolean(data.session));
      setSessionReady(true);
    });
    const { data: sub } = supabasePortalAuth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setLoggedIn(Boolean(session));
      setSessionReady(true);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  if (!isSupabaseConfigured) {
    return <main className="portal boot"><div className="login-card"><h1>Configuratie ontbreekt</h1><p>Het klantportaal is nog niet geconfigureerd. Neem contact op met je leverancier.</p></div></main>;
  }
  if (!sessionReady) return <main className="portal boot"><div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Klantportaal laden…</span></div></main>;
  if (!loggedIn) return <PortalLogin />;
  return <PortalDashboard />;
}

function PortalLogin() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setError(null); setBusy(true);
    try {
      const cleanEmail = email.trim();
      // Eerst server-side het account klaarzetten voor bekende klanten (zelf-
      // registratie staat uit). Onbekende e-mailadressen krijgen geen link.
      const { known } = await requestPortalLogin(cleanEmail);
      if (!known) {
        setError('Dit e-mailadres is bij ons niet als klant bekend. Neem contact op met je leverancier om toegang tot het portaal te krijgen.');
        return;
      }
      const { error } = await supabasePortalAuth.signInWithOtp({
        email: cleanEmail,
        options: { emailRedirectTo: `${window.location.origin}/portal`, shouldCreateUser: false },
      });
      if (error) setError(error.message); else setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Inloggen mislukt');
    } finally {
      setBusy(false);
    }
  }

  return <main className="portal login">
    <div className="login-card">
      <div className="app-brand"><div className="brand-icon">R</div><span>Klantportaal</span></div>
      <p className="eyebrow login-eyebrow">Facturen • Offertes • Tickets • Projecten</p>
      <h1>Inloggen</h1>
      <p>Vul je e-mailadres in. Je ontvangt een veilige inloglink in je mailbox — geen wachtwoord nodig.</p>
      <Input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="jij@bedrijf.nl"
        onKeyDown={e => { if (e.key === 'Enter' && email.trim()) void signIn(); }}
      />
      <Button variant="primary" onClick={signIn} disabled={!email.trim() || busy}>{busy ? 'Versturen…' : 'Stuur inloglink'}</Button>
      {sent && <p className="success">Check je mailbox. Open de link in dezelfde browser als waar je deze pagina hebt geopend.</p>}
      {error && <p className="error">{error}</p>}
    </div>
  </main>;
}

function PortalDashboard() {
  const [accounts, setAccounts] = useState<PortalAccount[] | null>(null);
  const [email, setEmail] = useState('');
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await fetchPortalData();
      setAccounts(data.accounts);
      setEmail(data.email);
      setActiveAccountId(prev => prev && data.accounts.some(a => a.id === prev) ? prev : (data.accounts[0]?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Portaalgegevens laden mislukt');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const activeAccount = useMemo(
    () => accounts?.find(a => a.id === activeAccountId) ?? accounts?.[0] ?? null,
    [accounts, activeAccountId],
  );

  const companyName = activeAccount?.company?.trade_name || activeAccount?.company?.company_name || 'Klantportaal';

  return <main className="portal portal-app">
    <header className="portal-topbar">
      <div className="portal-brand">
        <div className="brand-icon">{(companyName || 'R').slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="portal-brand-name">{companyName}</div>
          <div className="portal-brand-sub">{activeAccount?.actingContact ? `${activeAccount.actingContact.name} · ${email}` : (email || 'Klantportaal')}</div>
        </div>
      </div>
      <div className="portal-topbar-actions">
        {accounts && accounts.length > 1 && (
          <Select value={activeAccountId ?? ''} onChange={e => setActiveAccountId(e.target.value)}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.company?.trade_name || a.company?.company_name || a.client?.name || 'Dossier'}</option>)}
          </Select>
        )}
        <Button onClick={load}>{loading ? 'Laden…' : 'Ververs'}</Button>
        <Button onClick={() => supabasePortalAuth.signOut()}>Uitloggen</Button>
      </div>
    </header>

    <section className="portal-content">
      {error && <div className="error">{error}</div>}
      {loading && !accounts && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Gegevens laden…</span></div>}
      {!loading && accounts && accounts.length === 0 && <PortalEmpty email={email} />}
      {activeAccount && <PortalAccountView account={activeAccount} onTicketCreated={load} />}
    </section>
  </main>;
}

function PortalEmpty({ email }: { email: string }) {
  return <div className="portal-empty">
    <strong>Geen klantgegevens gevonden</strong>
    <span>Er zijn nog geen dossiers gekoppeld aan <em>{email || 'dit e-mailadres'}</em>. Neem contact op met je leverancier zodat zij je e-mailadres aan je klantdossier koppelen.</span>
  </div>;
}

function PortalAccountView({ account, onTicketCreated }: { account: PortalAccount; onTicketCreated: () => void }) {
  const [tab, setTab] = useState<PortalTab>('overview');
  const [openDoc, setOpenDoc] = useState<{ type: 'quote' | 'invoice'; id: string } | null>(null);

  if (openDoc?.type === 'quote') {
    const quote = account.quotes.find(q => q.id === openDoc.id);
    if (quote) return <div className="portal-account"><PortalQuoteDetail quote={quote} onBack={() => setOpenDoc(null)} onChanged={onTicketCreated} /></div>;
  }
  if (openDoc?.type === 'invoice') {
    const invoice = account.invoices.find(i => i.id === openDoc.id);
    if (invoice) return <div className="portal-account"><PortalInvoiceDetail invoice={invoice} account={account} onBack={() => setOpenDoc(null)} /></div>;
  }

  const openInvoices = account.invoices.filter(isInvoiceOpen);
  const overdueInvoices = account.invoices.filter(isInvoiceOverdue);
  const openTotal = openInvoices.reduce((sum, inv) => sum + total(inv.lines).total, 0);
  const overdueTotal = overdueInvoices.reduce((sum, inv) => sum + total(inv.lines).total, 0);
  const openTickets = account.tickets.filter(t => !['approved', 'rejected', 'converted'].includes(t.status));
  const ongoingProjects = account.projects.filter(p => !p.archived);

  const tabs: Array<{ id: PortalTab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overzicht' },
    { id: 'invoices', label: 'Facturen', count: account.invoices.length },
    { id: 'quotes', label: 'Offertes', count: account.quotes.length },
    { id: 'contracts', label: 'Contracten', count: account.contracts?.length ?? 0 },
    { id: 'tickets', label: 'Tickets', count: account.tickets.length },
    { id: 'projects', label: 'Projecten', count: ongoingProjects.length },
    { id: 'galleries', label: 'Galerijen', count: account.galleries?.length ?? 0 },
  ];

  return <div className="portal-account">
    <div className="portal-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`portal-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
          {t.label}{typeof t.count === 'number' && t.count > 0 && <span className="portal-tab-badge">{t.count}</span>}
        </button>
      ))}
    </div>

    {tab === 'overview' && <div className="portal-overview">
      <div className="portal-kpis">
        <PortalKpi label="Openstaand" value={euro(openTotal)} sub={`${openInvoices.length} factuur${openInvoices.length === 1 ? '' : 'en'}`} tone={openInvoices.length ? 'warning' : undefined} />
        <PortalKpi label="Vervallen" value={euro(overdueTotal)} sub={`${overdueInvoices.length} factuur${overdueInvoices.length === 1 ? '' : 'en'}`} tone={overdueInvoices.length ? 'danger' : undefined} />
        <PortalKpi label="Open tickets" value={String(openTickets.length)} sub={`${account.tickets.length} totaal`} />
        <PortalKpi label="Lopende projecten" value={String(ongoingProjects.length)} sub={`${account.projects.length} totaal`} />
      </div>

      <article className="portal-card">
        <div className="portal-card-head"><h2>Recente facturen</h2>{account.invoices.length > 0 && <button type="button" className="portal-more" onClick={() => setTab('invoices')}>Alle facturen →</button>}</div>
        {account.invoices.length === 0 && <p className="portal-muted">Nog geen facturen.</p>}
        <div className="portal-rows">{account.invoices.slice(0, 4).map(inv => <InvoiceRow key={inv.id} invoice={inv} onOpen={() => setOpenDoc({ type: 'invoice', id: inv.id })} />)}</div>
      </article>

      <article className="portal-card">
        <div className="portal-card-head"><h2>Recente offertes</h2>{account.quotes.length > 0 && <button type="button" className="portal-more" onClick={() => setTab('quotes')}>Alle offertes →</button>}</div>
        {account.quotes.length === 0 && <p className="portal-muted">Nog geen offertes.</p>}
        <div className="portal-rows">{account.quotes.slice(0, 4).map(q => <QuoteRow key={q.id} quote={q} onOpen={() => setOpenDoc({ type: 'quote', id: q.id })} />)}</div>
      </article>

      {account.company && <PortalContactCard account={account} />}
    </div>}

    {tab === 'invoices' && <article className="portal-card">
      <div className="portal-card-head"><h2>Facturen</h2><span>{account.invoices.length}</span></div>
      {account.invoices.length === 0 && <p className="portal-muted">Er zijn nog geen facturen voor je.</p>}
      <div className="portal-rows">{account.invoices.map(inv => <InvoiceRow key={inv.id} invoice={inv} onOpen={() => setOpenDoc({ type: 'invoice', id: inv.id })} />)}</div>
    </article>}

    {tab === 'quotes' && <article className="portal-card">
      <div className="portal-card-head"><h2>Offertes</h2><span>{account.quotes.length}</span></div>
      {account.quotes.length === 0 && <p className="portal-muted">Er zijn nog geen offertes voor je.</p>}
      <div className="portal-rows">{account.quotes.map(q => <QuoteRow key={q.id} quote={q} onOpen={() => setOpenDoc({ type: 'quote', id: q.id })} />)}</div>
    </article>}

    {tab === 'contracts' && <ContractsTab account={account} />}

    {tab === 'tickets' && <TicketsTab account={account} onTicketCreated={onTicketCreated} />}

    {tab === 'projects' && <ProjectsTab account={account} />}

    {tab === 'galleries' && <GalleriesTab account={account} />}
  </div>;
}

// ── Galerijen (foto/video-oplevering) ───────────────────────────────────────

function GalleriesTab({ account }: { account: PortalAccount }) {
  const galleries = account.galleries ?? [];
  const [openGallery, setOpenGallery] = useState<PortalGallery | null>(null);

  if (openGallery) {
    return <PortalGalleryView gallery={openGallery} account={account} onBack={() => setOpenGallery(null)} />;
  }

  return <article className="portal-card">
    <div className="portal-card-head"><h2>Galerijen</h2><span>{galleries.length}</span></div>
    {galleries.length === 0 && <p className="portal-muted">Er zijn nog geen galerijen voor je gepubliceerd.</p>}
    <div className="portal-rows">
      {galleries.map(gallery => {
        const project = account.projects.find(p => p.id === gallery.project_id);
        return (
          <button key={gallery.id} type="button" className="portal-row portal-row-clickable" onClick={() => setOpenGallery(gallery)}>
            <div className="portal-row-main">
              <span className="portal-row-number">{gallery.title}</span>
              <span className="portal-muted">
                {project ? `${project.name} · ` : ''}
                {gallery.published_at ? `Gepubliceerd ${dateNL(gallery.published_at)}` : ''}
                {gallery.expires_at ? ` · beschikbaar tot ${dateNL(gallery.expires_at)}` : ''}
              </span>
            </div>
            <span className="portal-row-status">Bekijken →</span>
          </button>
        );
      })}
    </div>
  </article>;
}

function PortalGalleryView({ gallery, account, onBack }: { gallery: PortalGallery; account: PortalAccount; onBack: () => void }) {
  const [detail, setDetail] = useState<PortalGalleryDetail | null>(null);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  const [likeIds, setLikeIds] = useState<Set<string>>(new Set());
  const [likeCounts, setLikeCounts] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: number | null = null;
    setLoading(true);
    setError(null);

    // De media-tokens leven een uur. Ruim vóór het verlopen halen we het detail
    // opnieuw op, anders breken thumbnails, video en downloads stilletjes af bij
    // een tabblad dat lang open blijft staan.
    const load = () => fetchPortalGalleryDetail(gallery.id)
      .then(result => {
        if (!active) return;
        setDetail(result);
        // Lettertypen van de beeldmaker inladen vóór de galerij in beeld komt.
        ensureBrandFontsLoaded([result.branding?.headingFont, result.branding?.bodyFont]);
        setFavoriteIds(new Set(result.myFavoriteIds));
        setLikeIds(new Set(result.myLikeIds));
        setLikeCounts(new Map(Object.entries(result.likeCounts ?? {})));
        const delay = galleryRefreshDelayMs(result.tokens);
        if (delay != null) timer = window.setTimeout(load, delay);
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Galerij laden mislukt.'); })
      .finally(() => { if (active) setLoading(false); });

    void load();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [gallery.id]);

  async function toggleFavorite(item: GalleryViewerItem, on: boolean) {
    // Optimistisch bijwerken; bij een fout draaien we terug.
    setFavoriteIds(prev => {
      const next = new Set(prev);
      if (on) next.add(item.id); else next.delete(item.id);
      return next;
    });
    try {
      await togglePortalGalleryFavorite(gallery.id, item.id, on, 'favorite');
    } catch {
      setFavoriteIds(prev => {
        const next = new Set(prev);
        if (on) next.delete(item.id); else next.add(item.id);
        return next;
      });
    }
  }

  async function toggleLike(item: GalleryViewerItem, on: boolean) {
    const shift = (delta: number) => setLikeCounts(prev => {
      const next = new Map(prev);
      next.set(item.id, Math.max(0, (next.get(item.id) ?? 0) + delta));
      return next;
    });
    setLikeIds(prev => {
      const next = new Set(prev);
      if (on) next.add(item.id); else next.delete(item.id);
      return next;
    });
    shift(on ? 1 : -1);
    try {
      await togglePortalGalleryFavorite(gallery.id, item.id, on, 'like');
    } catch {
      setLikeIds(prev => {
        const next = new Set(prev);
        if (on) next.delete(item.id); else next.add(item.id);
        return next;
      });
      shift(on ? -1 : 1);
    }
  }

  function downloadItem(item: GalleryViewerItem) {
    if (!detail) return;
    // Webkwaliteit: foto's als web-preview; anders het origineel uit R2.
    const webPhoto = detail.gallery.download_quality === 'web' && item.media_type === 'photo';
    const r2Key = (webPhoto ? item.preview_key : null) || item.storage_key || item.preview_key;
    let url: string | null = null;
    if (r2Key) {
      url = galleryFileUrl(r2Key, detail.tokens.mediaToken, { download: true });
    } else if (item.stream_uid && item.stream_playback_base && detail.tokens.streamTokens[item.stream_uid]) {
      url = streamDownloadUrl(item.stream_playback_base, detail.tokens.streamTokens[item.stream_uid]);
    }
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = item.file_name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const project = account.projects.find(p => p.id === gallery.project_id);
  const branding = detail?.branding;

  return <article className="portal-card portal-gallery" style={brandStyle(branding)}>
    {branding?.logoDataUrl && (
      <div className="portal-gallery-brand">
        <img src={branding.logoDataUrl} alt={branding.companyName ?? 'Logo'} />
      </div>
    )}
    <div className="portal-card-head">
      <div className="portal-gallery-head">
        <button type="button" className="portal-back" onClick={onBack}>← Terug</button>
        <h2>{gallery.title}</h2>
      </div>
      {detail?.gallery.allow_downloads && detail.items.some(i => i.storage_key || i.preview_key) && (
        <a className="portal-gallery-zip" href={galleryZipUrl(gallery.id, detail.tokens.mediaToken)} download>
          Alles downloaden (zip)
        </a>
      )}
    </div>
    {(gallery.description || project) && (
      <p className="portal-muted portal-gallery-sub">
        {project ? `Project: ${project.name}` : ''}
        {project && gallery.description ? ' — ' : ''}
        {gallery.description ?? ''}
      </p>
    )}
    {error && <p className="portal-error">{error}</p>}
    {loading && <p className="portal-muted">Galerij laden…</p>}
    {detail?.branding?.footerText && <p className="portal-gallery-own-note">{detail.branding.footerText}</p>}
    {detail && !loading && (
      <GalleryViewer
        items={detail.items}
        bundle={detail.tokens}
        allowDownload={detail.gallery.allow_downloads}
        format={detail.gallery.format}
        categories={detail.categories}
        hero={{
          template: detail.gallery.hero_template,
          title: detail.gallery.title,
          description: detail.gallery.description,
          itemId: detail.gallery.cover_item_id,
        }}
        favorites={favoriteIds}
        canFavorite
        likes={likeIds}
        likeCounts={likeCounts}
        canLike
        onToggleLike={(item, on) => void toggleLike(item, on)}
        onToggleFavorite={(item, on) => void toggleFavorite(item, on)}
        onDownloadItem={downloadItem}
        emptyText="Deze galerij bevat nog geen media."
      />
    )}
  </article>;
}

function PortalKpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warning' | 'danger' }) {
  return <div className={`portal-kpi${tone ? ` ${tone}` : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </div>;
}

function InvoiceRow({ invoice, onOpen }: { invoice: PortalInvoice; onOpen: () => void }) {
  const overdue = isInvoiceOverdue(invoice);
  const amount = total(invoice.lines).total;

  return <button type="button" className={`portal-row portal-row-clickable${overdue ? ' is-overdue' : ''}`} onClick={onOpen}>
    <div className="portal-row-main">
      <span className="portal-row-number">{invoice.number}</span>
      <span className="portal-muted">{dateNL(invoice.date)} · Vervalt {dateNL(invoice.due_date)}</span>
    </div>
    <span className="portal-row-amount">{euro(amount)}</span>
    <span className={`portal-status ${overdue ? 'overdue' : invoice.status}`}>{overdue ? 'Vervallen' : (invoiceStatusLabels[invoice.status] ?? invoice.status)}</span>
    <span className="portal-row-chevron" aria-hidden="true">›</span>
  </button>;
}

function QuoteRow({ quote, onOpen }: { quote: PortalQuote; onOpen: () => void }) {
  const amount = total(quote.lines).total;
  return <button type="button" className="portal-row portal-row-clickable" onClick={onOpen}>
    <div className="portal-row-main">
      <span className="portal-row-number">{quote.number}</span>
      <span className="portal-muted">{dateNL(quote.date)} · Geldig tot {dateNL(quote.valid_until)}</span>
    </div>
    <span className="portal-row-amount">{euro(amount)}</span>
    <span className={`portal-status ${quote.status}`}>{quoteStatusLabels[quote.status] ?? quote.status}</span>
    <span className="portal-row-chevron" aria-hidden="true">›</span>
  </button>;
}

// ── Offerte- & factuurdetail met acties (goedkeuren / betalen) ────────

function PortalDocLines({ lines }: { lines: FinanceLine[] }) {
  const totals = total(lines);
  return <>
    <div className="portal-doc-lines">
      {lines.map(line => <div className="portal-doc-line" key={line.id || line.description}>
        <div><strong>{line.description}</strong><span>{line.quantity} × {euro(line.unit_price)} · btw {line.vat ?? 0}%</span></div>
        <strong>{euro(lineGross(line))}</strong>
      </div>)}
    </div>
    <div className="portal-doc-total"><span>Totaal excl. btw</span><strong>{euro(totals.subtotal)}</strong></div>
    <div className="portal-doc-total"><span>Btw</span><strong>{euro(totals.vat)}</strong></div>
    <div className="portal-doc-total grand"><span>Totaal incl. btw</span><strong>{euro(totals.total)}</strong></div>
  </>;
}

function PortalQuoteDetail({ quote: initialQuote, onBack, onChanged }: { quote: PortalQuote; onBack: () => void; onChanged: () => void }) {
  const [quote, setQuote] = useState(initialQuote);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'accept' | 'reject'>(null);
  const [error, setError] = useState<string | null>(null);
  const decided = quote.status === 'accepted' || quote.status === 'rejected';

  async function decide(kind: 'accept' | 'reject') {
    setBusy(kind); setError(null);
    try {
      const updated = await decidePortalQuote(quote.id, kind, note.trim() || undefined);
      setQuote(updated);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Beslissing verwerken mislukt');
    } finally {
      setBusy(null);
    }
  }

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head"><button type="button" className="portal-back" onClick={onBack}>← Terug</button></div>
    <div className="portal-detail-title">
      <h2>Offerte {quote.number}</h2>
      <span className={`portal-status ${quote.status}`}>{quoteStatusLabels[quote.status] ?? quote.status}</span>
    </div>
    <p className="portal-muted">{dateNL(quote.date)} · Geldig tot {dateNL(quote.valid_until)}</p>
    {quote.notes && <p className="portal-detail-desc">{quote.notes}</p>}

    <PortalDocLines lines={quote.lines} />

    <div className="portal-doc-action">
      {decided ? (
        <div className={`portal-decision-done ${quote.status}`}>
          <strong>{quote.status === 'accepted' ? 'Je hebt deze offerte goedgekeurd' : 'Je hebt deze offerte geweigerd'}</strong>
          {quote.client_decision_at && <span className="portal-muted"> · {dateNL(quote.client_decision_at)}</span>}
          {quote.client_decision_note && <p>{quote.client_decision_note}</p>}
        </div>
      ) : quote.status === 'sent' ? (
        <>
          <label className="portal-field"><span>Opmerking (optioneel)</span>
            <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={2000} placeholder="Eventuele opmerking bij je beslissing…" disabled={busy !== null} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="portal-doc-actions">
            <Button variant="danger" onClick={() => decide('reject')} disabled={busy !== null}>{busy === 'reject' ? 'Bezig…' : 'Weigeren'}</Button>
            <Button variant="primary" onClick={() => decide('accept')} disabled={busy !== null}>{busy === 'accept' ? 'Bezig…' : 'Akkoord geven'}</Button>
          </div>
        </>
      ) : (
        <p className="portal-muted">Deze offerte kan niet (meer) in het portaal worden beoordeeld.</p>
      )}
    </div>
  </article>;
}

function PortalInvoiceDetail({ invoice, account, onBack }: { invoice: PortalInvoice; account: PortalAccount; onBack: () => void }) {
  const [info, setInfo] = useState<PortalInvoicePaymentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetchPortalInvoicePaymentInfo(invoice.id)
      .then(r => { if (active) setInfo(r); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Betaalinfo laden mislukt'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [invoice.id]);

  async function pay() {
    setPaying(true); setError(null);
    try {
      const { checkoutUrl } = await createPortalInvoicePayment(invoice.id);
      window.location.href = checkoutUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Betaling starten mislukt');
      setPaying(false);
    }
  }

  async function downloadPdf() {
    setDownloading(true); setError(null);
    try {
      const pdf = await downloadPortalInvoicePdf(invoice.id);
      downloadBase64File(pdf.base64, pdf.fileName, pdf.mimeType);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PDF downloaden mislukt');
    } finally {
      setDownloading(false);
    }
  }

  const overdue = isInvoiceOverdue(invoice);
  const amountEuro = info ? info.amountCents / 100 : total(invoice.lines).total;
  const iban = info?.iban ?? account.company?.iban ?? null;
  const companyName = info?.companyName || account.company?.trade_name || account.company?.company_name || '';

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head"><button type="button" className="portal-back" onClick={onBack}>← Terug</button></div>
    <div className="portal-detail-title">
      <h2>Factuur {invoice.number}</h2>
      <span className={`portal-status ${overdue ? 'overdue' : invoice.status}`}>{overdue ? 'Vervallen' : (invoiceStatusLabels[invoice.status] ?? invoice.status)}</span>
    </div>
    <p className="portal-muted">{dateNL(invoice.date)} · Vervalt {dateNL(invoice.due_date)}</p>
    {invoice.notes && <p className="portal-detail-desc">{invoice.notes}</p>}

    <PortalDocLines lines={invoice.lines} />

    {error && <p className="error">{error}</p>}

    <div className="portal-pay">
      {loading && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Betaalinfo laden…</span></div>}
      {info?.isPaid && <div className="portal-decision-done accepted"><strong>Deze factuur is betaald</strong></div>}
      {info && !info.isPaid && info.payable && <>
        {info.mollieAvailable && <div className="portal-pay-online">
          <Button variant="primary" onClick={pay} disabled={paying}>{paying ? 'Bezig…' : `Betaal nu ${euro(amountEuro)}`}</Button>
          <span className="portal-muted">Veilig online betalen via iDEAL, creditcard e.a.</span>
        </div>}
        {iban && <div className="portal-bank">
          <strong>{info.mollieAvailable ? 'Of via overschrijving' : 'Betalen via overschrijving'}</strong>
          <div className="portal-bank-facts">
            <span>Bedrag</span><strong>{euro(amountEuro)}</strong>
            <span>IBAN</span><strong>{iban}</strong>
            <span>Kenmerk</span><strong>{invoice.number}</strong>
            {companyName && <><span>T.n.v.</span><strong>{companyName}</strong></>}
          </div>
        </div>}
        {!info.mollieAvailable && !iban && <p className="portal-muted">Neem contact op met {companyName || 'je leverancier'} voor de betaalgegevens.</p>}
      </>}
      {info && !info.isPaid && !info.payable && <p className="portal-muted">Deze factuur staat niet open voor betaling.</p>}
    </div>

    <div className="portal-doc-actions portal-doc-actions-pdf">
      <Button onClick={downloadPdf} disabled={downloading}>{downloading ? 'PDF…' : 'PDF downloaden'}</Button>
    </div>
  </article>;
}

function ContractsTab({ account }: { account: PortalAccount }) {
  const contracts = account.contracts ?? [];
  return <article className="portal-card">
    <div className="portal-card-head"><h2>Contracten</h2><span>{contracts.length}</span></div>
    {contracts.length === 0 && <p className="portal-muted">Er zijn nog geen contracten voor je.</p>}
    <div className="portal-rows">{contracts.map(c => <ContractRow key={c.id} contract={c} />)}</div>
  </article>;
}

function ContractRow({ contract }: { contract: PortalContract }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setDownloading(true); setError(null);
    try {
      const pdf = await downloadPortalContractPdf(contract.id);
      downloadBase64File(pdf.base64, pdf.fileName, pdf.mimeType);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Downloaden mislukt');
    } finally {
      setDownloading(false);
    }
  }

  return <div className="portal-row">
    <div className="portal-row-main">
      <span className="portal-row-number">{contract.number}{contract.title ? ` · ${contract.title}` : ''}</span>
      <span className="portal-muted">{dateNL(contract.date)}{contract.signed_at ? ` · getekend ${dateNL(contract.signed_at)}` : ''}</span>
    </div>
    <span className={`portal-status ${contract.status}`}>{contractStatusLabels[contract.status] ?? contract.status}</span>
    {contract.status === 'signed' && <div className="portal-row-actions">
      <Button onClick={download} disabled={downloading}>{downloading ? 'PDF…' : 'PDF'}</Button>
      {error && <span className="portal-row-error">{error}</span>}
    </div>}
    {contract.status === 'sent' && <span className="portal-muted" style={{ fontSize: 12 }}>Check je e-mail voor de ondertekenlink</span>}
  </div>;
}

function PortalContactCard({ account }: { account: PortalAccount }) {
  const c = account.company!;
  const name = c.trade_name || c.company_name || 'Contact';
  return <article className="portal-card">
    <div className="portal-card-head"><h2>Contact</h2></div>
    <div className="portal-contact">
      <p><strong>{name}</strong></p>
      {c.email && <p>{c.email}</p>}
      {c.phone && <p>{c.phone}</p>}
      {c.website && <p>{c.website}</p>}
      {c.iban && <p className="portal-muted">IBAN: {c.iban}</p>}
    </div>
  </article>;
}

function TicketsTab({ account, onTicketCreated }: { account: PortalAccount; onTicketCreated: () => void }) {
  const [showForm, setShowForm] = useState(account.tickets.length === 0);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('med');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);

  async function submit() {
    if (!title.trim()) { setError('Geef een korte titel op.'); return; }
    setSubmitting(true); setError(null);
    try {
      const ticket = await createPortalTicket({ clientId: account.id, title: title.trim(), description: description.trim(), priority });
      setCreatedId(ticket.id);
      setTitle(''); setDescription(''); setPriority('med'); setShowForm(false);
      onTicketCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ticket aanmaken mislukt');
    } finally {
      setSubmitting(false);
    }
  }

  if (openTicketId) {
    return <PortalTicketDetail ticketId={openTicketId} onBack={() => setOpenTicketId(null)} onChanged={onTicketCreated} />;
  }

  return <article className="portal-card">
    <div className="portal-card-head">
      <h2>Tickets</h2>
      <Button variant="primary" onClick={() => setShowForm(v => !v)}>{showForm ? 'Annuleren' : '+ Nieuw ticket'}</Button>
    </div>

    {showForm && <div className="portal-ticket-form">
      <label className="portal-field"><span>Onderwerp</span><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Korte titel van je vraag of melding" maxLength={200} /></label>
      <label className="portal-field"><span>Omschrijving</span><Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Beschrijf je vraag of probleem…" rows={4} maxLength={5000} /></label>
      <label className="portal-field portal-field-inline"><span>Prioriteit</span>
        <Select value={priority} onChange={e => setPriority(e.target.value as Priority)}>
          <option value="low">Laag</option>
          <option value="med">Normaal</option>
          <option value="high">Hoog</option>
        </Select>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="portal-ticket-form-actions">
        <Button variant="primary" onClick={submit} disabled={submitting || !title.trim()}>{submitting ? 'Versturen…' : 'Ticket versturen'}</Button>
      </div>
    </div>}

    {!showForm && error && <p className="error">{error}</p>}
    {account.tickets.length === 0 && !showForm && <p className="portal-muted">Je hebt nog geen tickets. Maak er een aan om een vraag of melding door te geven.</p>}

    <div className="portal-rows">
      {account.tickets.map(t => <TicketRow key={t.id} ticket={t} highlight={t.id === createdId} onOpen={() => setOpenTicketId(t.id)} />)}
    </div>
  </article>;
}

function TicketRow({ ticket, highlight, onOpen }: { ticket: PortalTicket; highlight?: boolean; onOpen: () => void }) {
  return <button type="button" className={`portal-row portal-ticket portal-row-clickable${highlight ? ' is-new' : ''}`} onClick={onOpen}>
    <div className="portal-row-main">
      <span className="portal-row-number">{ticket.title}</span>
      <span className="portal-muted">{dateNL(ticket.created_at)} · Prioriteit {priorityLabel(ticket.priority)}</span>
      {ticket.description && <p className="portal-ticket-desc">{ticket.description}</p>}
    </div>
    <span className={`portal-status ticket-${ticket.status}`}>{ticketStatusLabels[ticket.status] ?? ticket.status}</span>
    <span className="portal-row-chevron" aria-hidden="true">›</span>
  </button>;
}

// ── Ticketdetail met tijdlijn ────────────────────────────────────────

function PortalTicketDetail({ ticketId, onBack, onChanged }: { ticketId: string; onBack: () => void; onChanged: () => void }) {
  const [thread, setThread] = useState<PortalTicketThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetchPortalTicketThread(ticketId)
      .then(result => { if (active) setThread(result); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Ticket laden mislukt'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ticketId]);

  async function submit() {
    const body = draft.trim();
    if (!body) return;
    setPosting(true); setError(null);
    try {
      const note = await addPortalTicketNote(ticketId, body);
      setThread(prev => prev ? { ...prev, notes: [...prev.notes, note] } : prev);
      setDraft('');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Notitie plaatsen mislukt');
    } finally {
      setPosting(false);
    }
  }

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head">
      <button type="button" className="portal-back" onClick={onBack}>← Terug naar tickets</button>
    </div>

    {loading && !thread && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Ticket laden…</span></div>}
    {error && <p className="error">{error}</p>}

    {thread && <>
      <div className="portal-detail-title">
        <h2>{thread.ticket.title}</h2>
        <span className={`portal-status ticket-${thread.ticket.status}`}>{ticketStatusLabels[thread.ticket.status] ?? thread.ticket.status}</span>
      </div>
      <p className="portal-muted">Aangemaakt {dateNL(thread.ticket.created_at)} · Prioriteit {priorityLabel(thread.ticket.priority)}</p>
      {thread.ticket.description && <p className="portal-detail-desc">{thread.ticket.description}</p>}

      <div className="portal-thread">
        {thread.notes.length === 0 && <p className="portal-muted">Nog geen berichten. Stel hieronder je vraag of voeg informatie toe.</p>}
        {thread.notes.map(note => <PortalThreadItem key={note.id} note={note} />)}
      </div>

      <div className="portal-thread-composer">
        <Textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Typ een bericht aan ons team…" rows={3} maxLength={5000} disabled={posting} />
        <div className="portal-thread-composer-actions">
          <Button variant="primary" onClick={submit} disabled={posting || !draft.trim()}>{posting ? 'Versturen…' : 'Bericht versturen'}</Button>
        </div>
      </div>
    </>}
  </article>;
}

function PortalThreadItem({ note }: { note: PortalTicketNote }) {
  const fromClient = note.author_type === 'client';
  return <div className={`portal-thread-item ${fromClient ? 'is-mine' : 'is-team'}`}>
    <div className="portal-thread-meta">
      <strong>{fromClient ? (note.author_name || 'U') : 'Support team'}</strong>
      <span>{new Date(note.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
    </div>
    <p>{note.body}</p>
  </div>;
}

// ── Projecten met live meekijken ─────────────────────────────────────

function ProjectsTab({ account }: { account: PortalAccount }) {
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  if (openProjectId) {
    return <PortalProjectDetail projectId={openProjectId} onBack={() => setOpenProjectId(null)} />;
  }

  return <article className="portal-card">
    <div className="portal-card-head"><h2>Projecten</h2><span>{account.projects.length}</span></div>
    {account.projects.length === 0 && <p className="portal-muted">Er zijn nog geen projecten voor je.</p>}
    <div className="portal-project-list">
      {account.projects.map(p => <button type="button" key={p.id} className="portal-project portal-row-clickable" onClick={() => setOpenProjectId(p.id)}>
        <span className="portal-project-dot" style={{ background: p.color || '#FFD966' }} />
        <div className="portal-project-body">
          <strong>{p.name}{p.archived && <em className="portal-archived"> · Afgerond</em>}</strong>
          {p.description && <p>{p.description}</p>}
          <span className="portal-muted">{p.start_date ? `Start ${dateNL(p.start_date)}` : 'Nog geen startdatum'}{p.end_date ? ` · Eind ${dateNL(p.end_date)}` : ''}</span>
        </div>
        <span className="portal-row-chevron" aria-hidden="true">›</span>
      </button>)}
    </div>
  </article>;
}

function PortalProjectDetail({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<PortalProject | null>(null);
  const [tasks, setTasks] = useState<PortalTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetchPortalProjectDetail(projectId)
      .then(result => { if (active) { setProject(result.project); setTasks(result.tasks); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Project laden mislukt'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);

  async function refresh() {
    setRefreshing(true); setError(null);
    try {
      const result = await fetchPortalProjectDetail(projectId);
      setProject(result.project); setTasks(result.tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Project laden mislukt');
    } finally {
      setRefreshing(false);
    }
  }

  const doneCount = tasks.filter(t => t.status === 'done').length;
  const progress = tasks.length ? Math.round((doneCount / tasks.length) * 100) : 0;

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head">
      <button type="button" className="portal-back" onClick={onBack}>← Terug naar projecten</button>
      <button type="button" className="portal-more" onClick={refresh} disabled={refreshing}>{refreshing ? 'Verversen…' : 'Ververs'}</button>
    </div>

    {loading && !project && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Project laden…</span></div>}
    {error && <p className="error">{error}</p>}

    {project && <>
      <div className="portal-detail-title">
        <h2><span className="portal-project-dot" style={{ background: project.color || '#FFD966' }} /> {project.name}</h2>
        {project.archived && <span className="portal-status">Afgerond</span>}
      </div>
      <p className="portal-muted">{project.start_date ? `Start ${dateNL(project.start_date)}` : 'Nog geen startdatum'}{project.end_date ? ` · Eind ${dateNL(project.end_date)}` : ''}</p>
      {project.description && <p className="portal-detail-desc">{project.description}</p>}

      <div className="portal-progress">
        <div className="portal-progress-head"><span>Voortgang</span><strong>{progress}%</strong></div>
        <div className="portal-progress-bar"><span style={{ width: `${progress}%` }} /></div>
        <span className="portal-muted">{doneCount} van {tasks.length} {tasks.length === 1 ? 'taak' : 'taken'} afgerond</span>
      </div>

      <div className="portal-task-list">
        {tasks.length === 0 && <p className="portal-muted">Er zijn nog geen taken ingepland voor dit project.</p>}
        {tasks.map(task => <div key={task.id} className="portal-task-row">
          <span className={`portal-task-status status-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
          <span className="portal-task-title">{task.title}</span>
          {(task.end_date || task.planned_date) && <span className="portal-muted portal-task-date">{task.end_date ? `Deadline ${dateNL(task.end_date)}` : `Gepland ${dateNL(task.planned_date)}`}</span>}
        </div>)}
      </div>
    </>}
  </article>;
}

// ── Helpers ──────────────────────────────────────────────────────────

const invoiceStatusLabels: Record<string, string> = {
  draft: 'Concept',
  sent: 'Openstaand',
  accepted: 'Openstaand',
  overdue: 'Vervallen',
  paid: 'Betaald',
  cancelled: 'Geannuleerd',
  void: 'Ongeldig',
  written_off: 'Afgeboekt',
  refunded: 'Terugbetaald',
};

const quoteStatusLabels: Record<string, string> = {
  draft: 'Concept',
  sent: 'Verzonden',
  accepted: 'Geaccepteerd',
  rejected: 'Afgewezen',
  expired: 'Verlopen',
  cancelled: 'Geannuleerd',
};

const contractStatusLabels: Record<string, string> = {
  sent: 'Wacht op ondertekening',
  signed: 'Ondertekend',
  declined: 'Geweigerd',
  expired: 'Verlopen',
};

const ticketStatusLabels: Record<string, string> = {
  new: 'Nieuw',
  review: 'In behandeling',
  approved: 'Goedgekeurd',
  rejected: 'Afgewezen',
  converted: 'Omgezet naar project',
};

const taskStatusLabels: Record<string, string> = {
  todo: 'Te doen',
  doing: 'Bezig',
  review: 'Review',
  done: 'Klaar',
};

function isInvoiceOpen(invoice: PortalInvoice): boolean {
  return !['paid', 'cancelled', 'void', 'written_off', 'refunded', 'draft'].includes(invoice.status);
}

function isInvoiceOverdue(invoice: PortalInvoice): boolean {
  if (['paid', 'cancelled', 'void', 'written_off', 'refunded'].includes(invoice.status)) return false;
  if (invoice.status === 'overdue') return true;
  if (!invoice.due_date) return false;
  return invoice.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

function downloadBase64File(base64: string, fileName: string, mimeType: string) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i += 1) byteNumbers[i] = byteCharacters.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
