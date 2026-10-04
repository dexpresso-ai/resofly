import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { LifeBuoy, Mail, Settings } from 'lucide-react';
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
  downloadPortalSharedItem,
  fetchPortalData,
  fetchPortalGalleryDetail,
  fetchPortalInvoicePaymentInfo,
  fetchPortalMessageThread,
  fetchPortalMessageThreads,
  fetchPortalNotificationSettings,
  fetchPortalProjectDetail,
  fetchPortalSharedFiles,
  fetchPortalTicketThread,
  requestPortalLogin,
  sendPortalMessage,
  togglePortalGalleryFavorite,
  updatePortalNotificationSettings,
  type PortalAccount,
  type PortalContract,
  type PortalGallery,
  type PortalGalleryDetail,
  type PortalInvoice,
  type PortalInvoicePaymentInfo,
  type PortalMessage,
  type PortalMessageThreadSummary,
  type PortalNotificationSettings,
  type PortalNotificationState,
  type PortalProject,
  type PortalShare,
  type PortalSharedItem,
  type PortalQuote,
  type PortalTask,
  type PortalTicket,
  type PortalTicketEvent,
  type PortalTicketNote,
  type PortalTicketThread,
} from '../../lib/portalApi';
import {
  isThreadUnread,
  isTicketUnread,
  parsePortalLink,
  PORTAL_LINK_MAX_AGE_MS,
  portalConversations,
  revalidatePortalLink,
  seenKey,
  splitQuotedReply,
  type PortalLink,
} from '../../lib/portalConversations';
import { listTime } from '../../lib/communication';
import { sanitizeEmailHtml } from '../../lib/sanitizeHtml';
import { dateNL, euro, lineGross, priorityLabel, total } from '../../lib/format';
import type { FinanceLine, Priority } from '../../types';
import { GalleryViewer, type GalleryViewerItem } from '../GalleryViewer';
import { galleryFileUrl, galleryRefreshDelayMs, galleryZipUrl, streamDownloadUrl } from '../../lib/gallery';
import { applyBrandTheme, brandStyle, ensureBrandFontsLoaded, sanitizeStoredBranding, type BrandingPayload } from '../../lib/branding';
import { ReadModal } from '../../components/ReadModal';

type PortalTab = 'overview' | 'messages' | 'tickets' | 'invoices' | 'quotes' | 'contracts' | 'files' | 'projects' | 'galleries' | 'settings';

/**
 * Deeplinks uit de meldingsmail: /portal?dossier=…&ticket=… opent meteen het
 * juiste dossier en ticket, ?view=instellingen de meldingsinstellingen. Is de
 * bezoeker nog niet ingelogd, dan gaat de link via de magische inloglink
 * verloren (die keert terug op /portal). Daarom bewaart dit apparaat hem kort,
 * en haalt hem meteen uit de adresbalk: een ververs mag niet opnieuw springen.
 */
const LINK_MEMORY_KEY = 'resofly.portal.link';

function capturePortalLink(): void {
  try {
    const link = parsePortalLink(window.location.search);
    if (!link) return;
    window.localStorage.setItem(LINK_MEMORY_KEY, JSON.stringify({ link, at: Date.now() }));
    const url = new URL(window.location.href);
    for (const key of ['dossier', 'ticket', 'bericht', 'view']) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // Geen opslag (privémodus): dan opent het portaal gewoon op het overzicht.
  }
}

function peekPortalLink(): PortalLink | null {
  try {
    const raw = window.localStorage.getItem(LINK_MEMORY_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { link?: unknown; at?: unknown };
    if (typeof stored.at !== 'number' || Date.now() - stored.at > PORTAL_LINK_MAX_AGE_MS) {
      window.localStorage.removeItem(LINK_MEMORY_KEY);
      return null;
    }
    return revalidatePortalLink(stored.link);
  } catch {
    return null;
  }
}

function forgetPortalLink(): void {
  try {
    window.localStorage.removeItem(LINK_MEMORY_KEY);
  } catch {
    // Niets aan te doen.
  }
}

/** Met welk tabblad (en wat er open staat) een dossier opent. */
function viewFromLink(link: PortalLink | null): { tab: PortalTab; ticketId: string | null; threadId: string | null } {
  if (!link) return { tab: 'overview', ticketId: null, threadId: null };
  if (link.ticket) return { tab: 'tickets', ticketId: link.ticket, threadId: null };
  if (link.thread) return { tab: 'messages', ticketId: null, threadId: link.thread };
  if (link.view) return { tab: link.view, ticketId: null, threadId: null };
  return { tab: 'overview', ticketId: null, threadId: null };
}

/**
 * Het loginscherm weet nog niet bij wélke leverancier deze bezoeker hoort — dat
 * blijkt pas uit het geverifieerde e-mailadres. Het adres vóór de login naar de
 * server sturen om alvast de huisstijl op te halen zou van elk e-mailadres
 * verklappen wie zijn leverancier is, dus dat doen we niet. In plaats daarvan
 * onthoudt dit apparaat de huisstijl van de vorige sessie: de eerste keer is
 * het portaal neutraal, elke keer daarna staat het meteen in het merk van de
 * leverancier.
 *
 * Bij het uitloggen gaat de herinnering wél weg. Op een balie- of gezinscomputer
 * zou de volgende bezoeker anders het logo en de afsluittekst van de vorige
 * zien staan, en daarmee weten bij wie die klant is. En bij het lezen keuren we
 * de waarde opnieuw (`sanitizeStoredBranding`): wat van de schijf van de
 * bezoeker komt is geen databasewaarde meer.
 */
const BRAND_MEMORY_KEY = 'resofly.portal.brand';

function rememberBranding(branding: BrandingPayload | null | undefined): void {
  try {
    if (branding) window.localStorage.setItem(BRAND_MEMORY_KEY, JSON.stringify(branding));
  } catch {
    // Privémodus of vol quotum: dan blijft het loginscherm gewoon neutraal.
  }
}

function forgetBranding(): void {
  try {
    window.localStorage.removeItem(BRAND_MEMORY_KEY);
  } catch {
    // Niets aan te doen; het is een sierlaag.
  }
}

function rememberedBranding(): BrandingPayload | null {
  try {
    const raw = window.localStorage.getItem(BRAND_MEMORY_KEY);
    return raw ? sanitizeStoredBranding(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Logo als de leverancier er een heeft, anders zijn initiaal in de merkkleur.
 *  Kent het apparaat de leverancier nog niet, dan blijft het tegeltje weg —
 *  liever niets dan de "R" van ResoFly op andermans portaal. */
function PortalMark({ branding, name }: { branding: BrandingPayload | null | undefined; name: string }) {
  if (branding?.logoDataUrl) {
    return <img className="portal-mark" src={branding.logoDataUrl} alt={branding.companyName ?? name} />;
  }
  if (!name) return null;
  return <div className="brand-icon">{name.slice(0, 1).toUpperCase()}</div>;
}

/** Afsluiting van de leverancier onder elk portaalscherm. */
function PortalFooter({ branding }: { branding: BrandingPayload | null | undefined }) {
  if (!branding) return null;
  if (!branding.footerText && branding.hidePoweredBy) return null;
  return <footer className="portal-foot">
    {branding.footerText && <span className="portal-foot-own">{branding.footerText}</span>}
    {!branding.hidePoweredBy && <span className="portal-foot-by">Geleverd via ResoFly</span>}
  </footer>;
}

/**
 * Klantportaal-root. Aparte route (/portal) met een eigen, wachtwoordloze login
 * (magische e-maillink). Na inloggen ziet de klant uitsluitend zijn eigen
 * facturen, offertes, tickets en projecten — opgehaald via de `client-portal`
 * edge function, die de toegang afleidt uit het geverifieerde e-mailadres.
 */
export function ClientPortal() {
  // Vóór alles: een deeplink uit de meldingsmail veiligstellen. In de
  // initializer (en niet in een effect) zodat het dashboard hem bij zijn eerste
  // render al vindt; effecten van kinderen draaien vóór die van de ouder.
  useState(() => { capturePortalLink(); return true; });
  const [sessionReady, setSessionReady] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  // Begint bij de huisstijl die dit apparaat onthield en gaat over op de echte
  // zodra de dossiers binnen zijn. Bewust ÉÉN eigenaar van het thema: twee
  // componenten die allebei :root beschrijven zouden elkaars momentopname
  // terugzetten, en dan staat het portaal na uitloggen weer in ResoFly-goud.
  const [branding, setBranding] = useState<BrandingPayload | null>(rememberedBranding);

  // Alleen opnieuw toepassen als er echt iets aan het beeld verandert; `load()`
  // levert bij elke "Ververs" een nieuw object met dezelfde inhoud.
  const brandKey = branding
    ? [branding.accentColor, branding.clientTheme, branding.headingFont, branding.bodyFont,
       branding.companyName, branding.footerText, branding.hidePoweredBy, branding.logoDataUrl].join('|')
    : '';
  useEffect(() => applyBrandTheme(branding), [brandKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
  if (!loggedIn) return <PortalLogin branding={branding} />;
  return <PortalDashboard branding={branding} onBranding={setBranding} />;
}

function PortalLogin({ branding }: { branding: BrandingPayload | null }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingLink] = useState(peekPortalLink);

  async function signIn() {
    setError(null); setBusy(true);
    try {
      const cleanEmail = email.trim();
      // Eerst server-side het account klaarzetten voor bekende klanten (zelf-
      // registratie staat uit). Onbekende e-mailadressen krijgen geen link — en
      // we zeggen niet welke dat zijn, anders is dit scherm een opzoekdienst.
      await requestPortalLogin(cleanEmail);
      const { error } = await supabasePortalAuth.signInWithOtp({
        email: cleanEmail,
        options: { emailRedirectTo: `${window.location.origin}/portal`, shouldCreateUser: false },
      });
      // "Signups not allowed" = onbekend adres: zelfde melding als bij een bekend adres.
      if (error && !/signup|not allowed|not found/i.test(error.message)) setError(error.message); else setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Inloggen mislukt');
    } finally {
      setBusy(false);
    }
  }

  return <main className="portal login">
    <div className="login-card">
      <div className="app-brand"><PortalMark branding={branding} name={branding?.companyName ?? ''} /><span>{branding?.companyName ?? 'Klantportaal'}</span></div>
      <p className="eyebrow login-eyebrow">Facturen • Offertes • Tickets • Projecten</p>
      <h1>Inloggen</h1>
      <p>Vul je e-mailadres in. Je ontvangt een veilige inloglink in je mailbox — geen wachtwoord nodig.</p>
      {pendingLink && <p className="portal-login-next">
        {pendingLink.ticket ? 'Na het inloggen openen we meteen het ticket uit je e-mail.'
          : pendingLink.view === 'settings' ? 'Na het inloggen kom je meteen bij je meldingsinstellingen.'
            : 'Na het inloggen gaan we meteen verder waar je e-mail over ging.'}
      </p>}
      <Input
        type="email"
        value={email}
        onChange={e => setEmail(e.target.value)}
        placeholder="jij@bedrijf.nl"
        onKeyDown={e => { if (e.key === 'Enter' && email.trim()) void signIn(); }}
      />
      <Button variant="primary" onClick={signIn} disabled={!email.trim() || busy}>{busy ? 'Versturen…' : 'Stuur inloglink'}</Button>
      {sent && <p className="success">Als dit adres bij ons bekend is, ontvang je zo een inloglink. Open die in dezelfde browser als waar je deze pagina hebt geopend. Geen mail? Neem contact op met je leverancier.</p>}
      {error && <p className="error">{error}</p>}
      <PortalFooter branding={branding} />
    </div>
  </main>;
}

function PortalDashboard({ branding, onBranding }: {
  branding: BrandingPayload | null;
  onBranding: (branding: BrandingPayload | null) => void;
}) {
  const [accounts, setAccounts] = useState<PortalAccount[] | null>(null);
  const [email, setEmail] = useState('');
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // De deeplink uit de meldingsmail, tot het dossier hem heeft overgenomen.
  const [link, setLink] = useState<PortalLink | null>(peekPortalLink);
  const linkRef = useRef(link);
  linkRef.current = link;
  const linkUsed = useCallback(() => { forgetPortalLink(); setLink(null); }, []);
  // De knop Instellingen in de kopbalk: elke klik opent de instellingen van het
  // gekozen dossier (een teller, zodat ook een tweede klik iets doet).
  const [settingsRequest, setSettingsRequest] = useState(0);

  async function load() {
    setLoading(true); setError(null);
    try {
      const data = await fetchPortalData();
      setAccounts(data.accounts);
      setEmail(data.email);
      const wanted = linkRef.current?.dossier;
      // Een link naar een dossier dat (deze login) niet (meer) heeft: vergeten.
      if (wanted && !data.accounts.some(a => a.id === wanted)) linkUsed();
      setActiveAccountId(prev => {
        if (wanted && data.accounts.some(a => a.id === wanted)) return wanted;
        return prev && data.accounts.some(a => a.id === prev) ? prev : (data.accounts[0]?.id ?? null);
      });
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
  const accountBranding = activeAccount?.branding ?? null;

  // Eén klant kan bij meerdere leveranciers klant zijn; de huisstijl hoort dus
  // bij het gekozen dossier, niet bij de sessie. Wisselen van dossier zet het
  // hele portaal om — het toepassen zelf doet ClientPortal hierboven.
  useEffect(() => {
    if (!accountBranding) return;
    rememberBranding(accountBranding);
    onBranding(accountBranding);
  }, [accountBranding, onBranding]);

  return <main className="portal portal-app">
    <header className="portal-topbar">
      <div className="portal-brand">
        <PortalMark branding={branding} name={companyName} />
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
        {activeAccount && <Button className="portal-settings-btn" onClick={() => setSettingsRequest(n => n + 1)} aria-label="Instellingen" title="Meldingen en instellingen">
          <Settings size={15} aria-hidden="true" /><span className="portal-btn-label">Instellingen</span>
        </Button>}
        <Button onClick={load}>{loading ? 'Laden…' : 'Ververs'}</Button>
        <Button onClick={() => { forgetBranding(); forgetPortalLink(); void supabasePortalAuth.signOut(); }}>Uitloggen</Button>
      </div>
    </header>

    <section className="portal-content">
      {error && <div className="error">{error}</div>}
      {loading && !accounts && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Gegevens laden…</span></div>}
      {!loading && accounts && accounts.length === 0 && <PortalEmpty email={email} />}
      {activeAccount && <PortalAccountView
        key={activeAccount.id}
        account={activeAccount}
        email={email}
        supplierName={companyName}
        onTicketCreated={load}
        link={link && (!link.dossier || link.dossier === activeAccount.id) ? link : null}
        onLinkUsed={linkUsed}
        settingsRequest={settingsRequest}
      />}
      <PortalFooter branding={branding} />
    </section>
  </main>;
}

function PortalEmpty({ email }: { email: string }) {
  return <div className="portal-empty">
    <strong>Geen klantgegevens gevonden</strong>
    <span>Er zijn nog geen dossiers gekoppeld aan <em>{email || 'dit e-mailadres'}</em>. Neem contact op met je leverancier zodat zij je e-mailadres aan je klantdossier koppelen.</span>
  </div>;
}

function PortalAccountView({ account, email, supplierName, onTicketCreated, link, onLinkUsed, settingsRequest }: {
  account: PortalAccount;
  email: string;
  supplierName: string;
  onTicketCreated: () => void;
  /** Deeplink uit de meldingsmail; bepaalt alleen waar dit dossier opent. */
  link: PortalLink | null;
  onLinkUsed: () => void;
  /** Telt op bij elke klik op Instellingen in de kopbalk. */
  settingsRequest: number;
}) {
  const [initial] = useState(() => viewFromLink(link));
  const [tab, setTab] = useState<PortalTab>(initial.tab);
  const [openDoc, setOpenDoc] = useState<{ type: 'quote' | 'invoice'; id: string } | null>(null);
  const [openTicketId, setOpenTicketId] = useState<string | null>(initial.ticketId);
  const [openConversation, setOpenConversation] = useState<OpenConversation | null>(
    initial.threadId ? { kind: 'thread', id: initial.threadId } : null,
  );

  // Wat je hier net opende telt meteen als gelezen — de server weet het al,
  // maar de gegevens van dit scherm pas na "Ververs".
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const markSeen = useCallback((kind: 'ticket' | 'thread', id: string) => {
    setSeen(prev => {
      const key = seenKey(kind, id);
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  // De mailgesprekken: pas geladen als Berichten openstaat, en opnieuw na
  // "Ververs" (dan komt er een nieuw account-object binnen).
  const [threads, setThreads] = useState<PortalMessageThreadSummary[] | null>(null);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const loadThreads = useCallback(async () => {
    setThreadsError(null);
    try {
      setThreads(await fetchPortalMessageThreads(account.id));
    } catch (e) {
      setThreadsError(e instanceof Error ? e.message : 'Berichten laden mislukt');
      setThreads(prev => prev ?? []);
    }
  }, [account.id]);
  useEffect(() => { setThreads(null); }, [account]);
  useEffect(() => { if (tab === 'messages' && threads === null) void loadThreads(); }, [tab, threads, loadThreads]);

  // De deeplink is gebruikt zodra dit dossier ermee geopend is.
  useEffect(() => { if (link) onLinkUsed(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Alleen een klik ná het openen van dit dossier telt; wie van dossier wisselt
  // na een eerdere klik, begint gewoon op het overzicht.
  const settingsBaseline = useRef(settingsRequest);
  useEffect(() => {
    if (settingsRequest === settingsBaseline.current) return;
    // Een open factuur of offerte gaat vóór de tabs; die moet dus eerst dicht.
    setOpenDoc(null);
    setTab('settings');
  }, [settingsRequest]);

  const unreadTickets = account.tickets.filter(t => isTicketUnread(t, seen));
  const unreadThreads = threads ? threads.filter(t => isThreadUnread(t, seen)).length : (account.messages?.unread ?? 0);

  function openTab(next: PortalTab) {
    setTab(next);
    if (next === 'tickets') setOpenTicketId(null);
    if (next === 'messages') setOpenConversation(null);
  }

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

  // `fresh` = iets nieuws van de leverancier dat je hier nog niet opende; dat
  // telletje krijgt de accentkleur, een gewoon aantal blijft grijs.
  const tabs: Array<{ id: PortalTab; label: string; count?: number; fresh?: number }> = [
    { id: 'overview', label: 'Overzicht' },
    { id: 'messages', label: 'Berichten', fresh: unreadTickets.length + unreadThreads },
    { id: 'tickets', label: 'Tickets', count: account.tickets.length, fresh: unreadTickets.length },
    { id: 'invoices', label: 'Facturen', count: account.invoices.length },
    { id: 'quotes', label: 'Offertes', count: account.quotes.length },
    { id: 'contracts', label: 'Contracten', count: account.contracts?.length ?? 0 },
    { id: 'files', label: 'Bestanden', count: account.sharedFileCount ?? 0 },
    { id: 'projects', label: 'Projecten', count: ongoingProjects.length },
    // Galerijen horen bij de creatieve module; zonder galerij is het een lege tab.
    ...((account.galleries?.length ?? 0) > 0 || tab === 'galleries'
      ? [{ id: 'galleries' as const, label: 'Galerijen', count: account.galleries?.length ?? 0 }]
      : []),
  ];

  return <div className="portal-account">
    <div className="portal-tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`portal-tab${tab === t.id ? ' active' : ''}`} onClick={() => openTab(t.id)}>
          {t.label}
          {t.fresh
            ? <span className="portal-tab-badge is-new" title={`${t.fresh} nieuw`}>{t.fresh}</span>
            : typeof t.count === 'number' && t.count > 0 && <span className="portal-tab-badge">{t.count}</span>}
        </button>
      ))}
    </div>

    {tab === 'overview' && <div className="portal-overview">
      <div className="portal-kpis">
        <PortalKpi label="Openstaand" value={euro(openTotal)} sub={`${openInvoices.length} factuur${openInvoices.length === 1 ? '' : 'en'}`} tone={openInvoices.length ? 'warning' : undefined} />
        <PortalKpi label="Vervallen" value={euro(overdueTotal)} sub={`${overdueInvoices.length} factuur${overdueInvoices.length === 1 ? '' : 'en'}`} tone={overdueInvoices.length ? 'danger' : undefined} />
        <PortalKpi label="Open tickets" value={String(openTickets.length)} sub={unreadTickets.length ? `${unreadTickets.length} met nieuw antwoord` : `${account.tickets.length} totaal`} />
        <PortalKpi label="Lopende projecten" value={String(ongoingProjects.length)} sub={`${account.projects.length} totaal`} />
      </div>

      {(unreadTickets.length > 0 || unreadThreads > 0) && <article className="portal-card portal-new-card">
        <div className="portal-card-head"><h2>Nieuw voor jou</h2></div>
        <div className="portal-rows">
          {unreadTickets.slice(0, 3).map(t => (
            <button key={t.id} type="button" className="portal-row portal-row-clickable" onClick={() => { setTab('tickets'); setOpenTicketId(t.id); }}>
              <div className="portal-row-main">
                <span className="portal-row-number"><span className="portal-unread-dot" aria-hidden="true" />{t.title}</span>
                <span className="portal-muted">{ticketNewLabel(t, supplierName)}{t.last_activity_at ? ` · ${listTime(t.last_activity_at)}` : ''}</span>
              </div>
              <span className="portal-row-chevron" aria-hidden="true">›</span>
            </button>
          ))}
          {unreadTickets.length > 3 && <button type="button" className="portal-more" onClick={() => openTab('tickets')}>Nog {unreadTickets.length - 3} ticket{unreadTickets.length - 3 === 1 ? '' : 's'} met een nieuw antwoord →</button>}
          {unreadThreads > 0 && (
            <button type="button" className="portal-row portal-row-clickable" onClick={() => openTab('messages')}>
              <div className="portal-row-main">
                <span className="portal-row-number"><span className="portal-unread-dot" aria-hidden="true" />{unreadThreads === 1 ? 'Nieuw bericht' : `${unreadThreads} nieuwe berichten`}</span>
                <span className="portal-muted">Van {supplierName}, onder Berichten</span>
              </div>
              <span className="portal-row-chevron" aria-hidden="true">›</span>
            </button>
          )}
        </div>
      </article>}

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

    {tab === 'files' && <SharedFilesTab account={account} />}

    {tab === 'messages' && <MessagesTab
      account={account}
      email={email}
      supplierName={supplierName}
      threads={threads}
      threadsError={threadsError}
      onReloadThreads={loadThreads}
      seen={seen}
      markSeen={markSeen}
      open={openConversation}
      onOpen={setOpenConversation}
      onTicketChanged={onTicketCreated}
      onOpenSettings={() => openTab('settings')}
    />}

    {tab === 'tickets' && <TicketsTab
      account={account}
      supplierName={supplierName}
      onTicketCreated={onTicketCreated}
      openTicketId={openTicketId}
      onOpenTicket={setOpenTicketId}
      seen={seen}
      markSeen={markSeen}
      onOpenSettings={() => openTab('settings')}
    />}

    {tab === 'projects' && <ProjectsTab account={account} />}

    {tab === 'galleries' && <GalleriesTab account={account} />}

    {tab === 'settings' && <SettingsTab account={account} supplierName={supplierName} onBack={() => openTab('overview')} />}
  </div>;
}

type OpenConversation = { kind: 'thread' | 'ticket'; id: string } | { kind: 'new' };

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
    </div>
    {/* Alleen de projectcontext: de titel en omschrijving toont de hero van de
        viewer al, en die twee keer onder elkaar zetten leest als een fout. */}
    {project && <p className="portal-muted portal-gallery-sub">Project: {project.name}</p>}
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
          coverPreviewKey: detail.gallery.cover_preview_key,
          focusX: detail.gallery.cover_focus_x,
          focusY: detail.gallery.cover_focus_y,
        }}
        favorites={favoriteIds}
        canFavorite
        likes={likeIds}
        likeCounts={likeCounts}
        canLike
        onToggleLike={(item, on) => void toggleLike(item, on)}
        onToggleFavorite={(item, on) => void toggleFavorite(item, on)}
        onDownloadItem={downloadItem}
        zipUrl={galleryZipUrl(gallery.id, detail.tokens.mediaToken)}
        downloadQuality={detail.gallery.download_quality}
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

// ── Met jou gedeelde bestanden ──────────────────────────────────────────────
//
// Een medewerker deelt een map, bestand, notitie of document met jou als
// geregistreerde contactpersoon. Alleen delingen die op jouw geverifieerde
// e-mailadres staan komen hier terug; de server leidt dat opnieuw af bij elke
// aanvraag en vertrouwt nooit een id uit de browser.

function SharedFilesTab({ account }: { account: PortalAccount }) {
  const [shares, setShares] = useState<PortalShare[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setShares(null); setError(null);
    fetchPortalSharedFiles(account.id)
      .then(rows => { if (!cancelled) setShares(rows); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Gedeelde bestanden ophalen mislukt'); });
    return () => { cancelled = true; };
  }, [account.id]);

  if (error) {
    return <article className="portal-card">
      <div className="portal-card-head"><h2>Bestanden</h2></div>
      <p className="portal-row-error">{error}</p>
    </article>;
  }
  if (shares === null) {
    return <article className="portal-card">
      <div className="portal-card-head"><h2>Bestanden</h2></div>
      <p className="portal-muted">Bestanden laden…</p>
    </article>;
  }
  if (shares.length === 0) {
    return <article className="portal-card">
      <div className="portal-card-head"><h2>Bestanden</h2></div>
      <p className="portal-muted">Er zijn nog geen bestanden met je gedeeld.</p>
    </article>;
  }

  return <>
    {shares.map(share => <SharedShareCard key={share.id} share={share} />)}
  </>;
}

function SharedShareCard({ share }: { share: PortalShare }) {
  const [reading, setReading] = useState<{ title: string; html: string } | null>(null);
  return <article className="portal-card">
    <div className="portal-card-head">
      <h2>{share.itemName || 'Gedeeld'}</h2>
      <span>{share.items.length}</span>
    </div>
    <p className="portal-muted">
      Gedeeld op {dateNL(share.sharedAt)}
      {share.expiresAt ? ` · beschikbaar tot ${dateNL(share.expiresAt)}` : ''}
      {share.canDownload ? '' : ' · alleen bekijken'}
    </p>
    {share.message && <p className="portal-shared-message">{share.message}</p>}
    {share.items.length === 0
      ? <p className="portal-muted">Deze map is op dit moment leeg.</p>
      : <div className="portal-rows">
          {share.items.map(item => <SharedItemRow
            key={`${item.itemType}-${item.itemId}`}
            shareId={share.id}
            item={item}
            canDownload={share.canDownload}
            onRead={setReading}
          />)}
        </div>}
    {reading && <ReadModal title={reading.title} html={reading.html} onClose={() => setReading(null)} />}
  </article>;
}

function SharedItemRow({ shareId, item, canDownload, onRead }: {
  shareId: string;
  item: PortalSharedItem;
  canDownload: boolean;
  onRead: (value: { title: string; html: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true); setError(null);
    try {
      const result = await downloadPortalSharedItem(shareId, item.itemType, item.itemId);
      if (result.kind === 'text') onRead({ title: result.title || item.name, html: result.html });
      else downloadBase64File(result.base64, result.fileName, result.mimeType);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Openen mislukt');
    } finally {
      setBusy(false);
    }
  }

  return <div className="portal-row">
    <div className="portal-row-main">
      <span className="portal-row-number">{item.name}</span>
      <span className="portal-muted">
        {[item.path, fmtSharedBytes(item.sizeBytes), item.modified ? dateNL(item.modified) : ''].filter(Boolean).join(' · ')}
      </span>
    </div>
    <div className="portal-row-actions">
      {(item.readable || item.downloadable)
        ? <Button onClick={open} disabled={busy}>{busy ? 'Bezig…' : item.readable ? 'Lezen' : 'Downloaden'}</Button>
        : <span className="portal-muted" style={{ fontSize: 12 }}>{canDownload ? 'Niet beschikbaar' : 'Downloaden staat uit'}</span>}
      {error && <span className="portal-row-error">{error}</span>}
    </div>
  </div>;
}

function fmtSharedBytes(bytes: number | null): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
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

function TicketsTab({ account, supplierName, onTicketCreated, openTicketId, onOpenTicket, seen, markSeen, onOpenSettings }: {
  account: PortalAccount;
  supplierName: string;
  onTicketCreated: () => void;
  openTicketId: string | null;
  onOpenTicket: (id: string | null) => void;
  seen: ReadonlySet<string>;
  markSeen: (kind: 'ticket' | 'thread', id: string) => void;
  onOpenSettings: () => void;
}) {
  const [showForm, setShowForm] = useState(account.tickets.length === 0);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('med');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Laatste activiteit bovenaan: een ticket met een nieuw antwoord komt vanzelf naar boven.
  const tickets = useMemo(
    () => [...account.tickets].sort((a, b) => activityMs(b) - activityMs(a)),
    [account.tickets],
  );

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
    return <PortalTicketDetail
      ticketId={openTicketId}
      supplierName={supplierName}
      backLabel="← Terug naar tickets"
      onBack={() => onOpenTicket(null)}
      onChanged={onTicketCreated}
      onOpened={() => markSeen('ticket', openTicketId)}
      onOpenSettings={onOpenSettings}
    />;
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
    {createdId && !showForm && <p className="portal-hint">
      Je ticket is verstuurd. Een antwoord zie je hier terug; bij <button type="button" className="portal-link" onClick={onOpenSettings}>Instellingen</button> kies je of je daar ook een e-mail van krijgt.
    </p>}
    {account.tickets.length === 0 && !showForm && <p className="portal-muted">Je hebt nog geen tickets. Maak er een aan om een vraag of melding door te geven.</p>}

    <div className="portal-rows">
      {tickets.map(t => <TicketRow
        key={t.id}
        ticket={t}
        supplierName={supplierName}
        unread={isTicketUnread(t, seen)}
        highlight={t.id === createdId}
        onOpen={() => onOpenTicket(t.id)}
      />)}
    </div>
  </article>;
}

function activityMs(ticket: PortalTicket): number {
  return Date.parse(ticket.last_activity_at || ticket.created_at) || 0;
}

/** "Nieuw antwoord van Studio Lopik" — of, zonder antwoorden, een ticket dat zij voor je aanmaakten. */
function ticketNewLabel(ticket: PortalTicket, supplierName: string): string {
  return (ticket.reply_count ?? 0) > 0 ? `Nieuw antwoord van ${supplierName}` : `Nieuw ticket van ${supplierName}`;
}

function TicketRow({ ticket, supplierName, unread, highlight, onOpen }: {
  ticket: PortalTicket;
  supplierName: string;
  unread: boolean;
  highlight?: boolean;
  onOpen: () => void;
}) {
  const replies = ticket.reply_count ?? 0;
  const lastActivity = ticket.last_activity_at && ticket.last_activity_at !== ticket.created_at ? ticket.last_activity_at : null;
  return <button type="button" className={`portal-row portal-ticket portal-row-clickable${highlight ? ' is-new' : ''}${unread ? ' is-unread' : ''}`} onClick={onOpen}>
    <div className="portal-row-main">
      <span className="portal-row-number">{unread && <span className="portal-unread-dot" title={ticketNewLabel(ticket, supplierName)} />}{ticket.title}</span>
      <span className="portal-muted">
        {dateNL(ticket.created_at)} · Prioriteit {priorityLabel(ticket.priority)}
        {replies > 0 ? ` · ${replies} ${replies === 1 ? 'reactie' : 'reacties'}` : ''}
        {lastActivity ? ` · laatst ${listTime(lastActivity)}` : ''}
      </span>
      {unread
        ? <p className="portal-ticket-desc portal-ticket-fresh">
            <strong>{ticketNewLabel(ticket, supplierName)}</strong>
            {ticket.last_reply_from === 'team' && ticket.last_reply_preview ? `: ${ticket.last_reply_preview}` : ''}
          </p>
        : ticket.description && <p className="portal-ticket-desc">{ticket.description}</p>}
    </div>
    <span className={`portal-status ticket-${ticket.status}`}>{ticketStatusLabels[ticket.status] ?? ticket.status}</span>
    <span className="portal-row-chevron" aria-hidden="true">›</span>
  </button>;
}

/** Ctrl/Cmd+Enter verstuurt, zoals in elk mailprogramma; Enter alleen is een nieuwe regel. */
function submitOnCtrlEnter(action: () => void) {
  return (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      action();
    }
  };
}

function formatThreadTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Ticketdetail met tijdlijn ────────────────────────────────────────

type TicketTimelineEntry =
  | { kind: 'note'; at: string; note: PortalTicketNote }
  | { kind: 'event'; at: string; event: PortalTicketEvent };

function PortalTicketDetail({ ticketId, supplierName, backLabel, onBack, onChanged, onOpened, onOpenSettings }: {
  ticketId: string;
  supplierName: string;
  backLabel: string;
  onBack: () => void;
  onChanged: () => void;
  /** Het ticket is geopend (en telt dus als gelezen). */
  onOpened: () => void;
  onOpenSettings: () => void;
}) {
  const [thread, setThread] = useState<PortalTicketThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const openedRef = useRef(onOpened);
  openedRef.current = onOpened;

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetchPortalTicketThread(ticketId)
      .then(result => {
        if (!active) return;
        setThread(result);
        openedRef.current();
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Ticket laden mislukt'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ticketId]);

  async function submit() {
    const body = draft.trim();
    if (!body || posting) return;
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

  // Reacties en statuswijzigingen in één tijdlijn, oudste eerst.
  const timeline = useMemo<TicketTimelineEntry[]>(() => {
    if (!thread) return [];
    return [
      ...thread.notes.map((note): TicketTimelineEntry => ({ kind: 'note', at: note.created_at, note })),
      ...thread.events.map((event): TicketTimelineEntry => ({ kind: 'event', at: event.created_at, event })),
    ].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  }, [thread]);

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head">
      <button type="button" className="portal-back" onClick={onBack}>{backLabel}</button>
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
        {timeline.length === 0 && <p className="portal-muted">Nog geen berichten. Stel hieronder je vraag of voeg informatie toe.</p>}
        {timeline.map(entry => entry.kind === 'note'
          ? <PortalThreadItem key={entry.note.id} note={entry.note} supplierName={supplierName} />
          : <PortalThreadEvent key={entry.event.id} event={entry.event} />)}
      </div>

      <div className="portal-thread-composer">
        <Textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={submitOnCtrlEnter(submit)} placeholder={`Typ een bericht aan ${supplierName}…`} rows={3} maxLength={5000} disabled={posting} />
        <div className="portal-thread-composer-actions">
          <span className="portal-composer-hint">
            E-mail bij een antwoord? <button type="button" className="portal-link" onClick={onOpenSettings}>Instellingen</button>
          </span>
          <Button variant="primary" onClick={submit} disabled={posting || !draft.trim()}>{posting ? 'Versturen…' : 'Bericht versturen'}</Button>
        </div>
      </div>
    </>}
  </article>;
}

function PortalThreadItem({ note, supplierName }: { note: PortalTicketNote; supplierName: string }) {
  const fromClient = note.author_type === 'client';
  return <div className={`portal-thread-item ${fromClient ? 'is-mine' : 'is-team'}`}>
    <div className="portal-thread-meta">
      {/* De leverancier ondertekent met zijn eigen naam; "Support team" was
          hier het enige wat nog niet van hem was. */}
      <strong>{fromClient ? (note.author_name || 'U') : supplierName}</strong>
      <span>{formatThreadTime(note.created_at)}</span>
    </div>
    <p>{note.body}</p>
  </div>;
}

/** Een statuswijziging als rustige regel tussen de berichten. */
function PortalThreadEvent({ event }: { event: PortalTicketEvent }) {
  const label = ticketStatusLabels[event.new_status ?? ''] ?? event.new_status ?? '';
  return <div className="portal-thread-event" role="note">
    <span>Status gewijzigd naar <strong>{label}</strong></span>
    <time dateTime={event.created_at}>{formatThreadTime(event.created_at)}</time>
  </div>;
}

// ── Berichten: mailgesprekken en tickets op één plek ─────────────────
//
// Wat de leverancier je mailde en wat je zelf terugschreef, plus je tickets —
// nieuwste activiteit bovenaan, zoals de pagina Berichten van het team. Een
// antwoord of nieuw bericht dat je hier schrijft komt bij de leverancier
// binnen als bericht van jou, in hetzelfde gesprek; het antwoord krijg je per
// e-mail én zie je hier.

function MessagesTab({ account, email, supplierName, threads, threadsError, onReloadThreads, seen, markSeen, open, onOpen, onTicketChanged, onOpenSettings }: {
  account: PortalAccount;
  email: string;
  supplierName: string;
  threads: PortalMessageThreadSummary[] | null;
  threadsError: string | null;
  onReloadThreads: () => Promise<void>;
  seen: ReadonlySet<string>;
  markSeen: (kind: 'ticket' | 'thread', id: string) => void;
  open: OpenConversation | null;
  onOpen: (value: OpenConversation | null) => void;
  onTicketChanged: () => void;
  onOpenSettings: () => void;
}) {
  if (open?.kind === 'ticket') {
    return <PortalTicketDetail
      ticketId={open.id}
      supplierName={supplierName}
      backLabel="← Terug naar berichten"
      onBack={() => onOpen(null)}
      onChanged={onTicketChanged}
      onOpened={() => markSeen('ticket', open.id)}
      onOpenSettings={onOpenSettings}
    />;
  }
  if (open?.kind === 'thread') {
    return <PortalMessageThreadView
      threadId={open.id}
      supplierName={supplierName}
      onBack={() => onOpen(null)}
      onOpened={() => markSeen('thread', open.id)}
      onSent={() => { void onReloadThreads(); }}
    />;
  }
  if (open?.kind === 'new') {
    return <PortalNewMessage
      account={account}
      email={email}
      supplierName={supplierName}
      onCancel={() => onOpen(null)}
      onSent={threadId => { void onReloadThreads(); onOpen({ kind: 'thread', id: threadId }); }}
    />;
  }

  const conversations = threads ? portalConversations(account.tickets, threads, supplierName, seen) : null;

  return <article className="portal-card">
    <div className="portal-card-head">
      <h2>Berichten</h2>
      <Button variant="primary" onClick={() => onOpen({ kind: 'new' })}>+ Nieuw bericht</Button>
    </div>
    <p className="portal-muted portal-card-intro">Je gesprekken met {supplierName} — e-mails en tickets, nieuwste bovenaan.</p>
    {threadsError && <p className="error">{threadsError}</p>}
    {!conversations && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Berichten laden…</span></div>}
    {conversations && conversations.length === 0 && <p className="portal-muted">Nog geen berichten. Stel je vraag met “Nieuw bericht”, of maak een ticket aan als je de voortgang wilt volgen.</p>}
    {conversations && conversations.length > 0 && <div className="portal-conv-list">
      {conversations.map(c => (
        <button
          key={`${c.kind}:${c.id}`}
          type="button"
          className={`portal-conv${c.unread ? ' is-unread' : ''}`}
          onClick={() => onOpen({ kind: c.kind, id: c.id })}
        >
          <span className={`portal-conv-icon is-${c.kind}`} aria-hidden="true">
            {c.kind === 'ticket' ? <LifeBuoy size={16} /> : <Mail size={16} />}
          </span>
          <span className="portal-conv-main">
            <span className="portal-conv-top">
              <strong className="portal-conv-title">{c.title}</strong>
              <time className="portal-conv-time" dateTime={c.lastAt}>{listTime(c.lastAt)}</time>
            </span>
            <span className="portal-conv-bottom">
              <span className="portal-conv-kind">{c.kind === 'ticket' ? 'Ticket' : 'E-mail'}</span>
              <span className="portal-conv-preview">{c.preview}</span>
              {c.kind === 'ticket' && <span className={`portal-status ticket-${c.status}`}>{ticketStatusLabels[c.status] ?? c.status}</span>}
              {c.unread && <span className="portal-unread-dot" title="Nieuw" />}
            </span>
          </span>
        </button>
      ))}
    </div>}
  </article>;
}

function PortalMessageThreadView({ threadId, supplierName, onBack, onOpened, onSent }: {
  threadId: string;
  supplierName: string;
  onBack: () => void;
  onOpened: () => void;
  onSent: () => void;
}) {
  const [data, setData] = useState<{ thread: { id: string; clientId: string; subject: string }; messages: PortalMessage[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const openedRef = useRef(onOpened);
  openedRef.current = onOpened;

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null);
    fetchPortalMessageThread(threadId)
      .then(result => {
        if (!active) return;
        setData(result);
        openedRef.current();
      })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Gesprek laden mislukt'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [threadId]);

  async function send() {
    const body = draft.trim();
    if (!body || !data || sending) return;
    setSending(true); setError(null);
    try {
      const result = await sendPortalMessage({ clientId: data.thread.clientId, threadId: data.thread.id, body });
      setData(prev => prev ? { ...prev, messages: [...prev.messages, result.message] } : prev);
      setDraft('');
      onSent();
      window.requestAnimationFrame(() => composerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bericht versturen mislukt');
    } finally {
      setSending(false);
    }
  }

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head">
      <button type="button" className="portal-back" onClick={onBack}>← Terug naar berichten</button>
    </div>
    {loading && !data && <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Gesprek laden…</span></div>}
    {error && <p className="error">{error}</p>}
    {data && <>
      <div className="portal-detail-title"><h2>{data.thread.subject}</h2></div>
      <p className="portal-muted">Gesprek met {supplierName} · {data.messages.length} bericht{data.messages.length === 1 ? '' : 'en'}</p>
      <div className="portal-thread">
        {data.messages.map(message => <PortalMessageBubble key={message.id} message={message} />)}
      </div>
      <div className="portal-thread-composer" ref={composerRef}>
        <Textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={submitOnCtrlEnter(send)} placeholder={`Antwoord aan ${supplierName}…`} rows={3} maxLength={5000} disabled={sending} />
        <div className="portal-thread-composer-actions">
          <span className="portal-composer-hint">Je antwoord komt meteen bij {supplierName} binnen.</span>
          <Button variant="primary" onClick={send} disabled={sending || !draft.trim()}>{sending ? 'Versturen…' : 'Antwoord versturen'}</Button>
        </div>
      </div>
    </>}
  </article>;
}

/**
 * Eén bericht in een mailgesprek. Van de leverancier: de opmaak zoals verstuurd, door
 * dezelfde sanering als inkomende mail in de app. Van de klantkant: platte
 * tekst, met de geciteerde eerdere mail ingeklapt — anders staat onder elk
 * antwoord de hele geschiedenis nog eens.
 */
function PortalMessageBubble({ message }: { message: PortalMessage }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const html = message.fromTeam && message.bodyHtml ? sanitizeEmailHtml(message.bodyHtml) : '';
  const parts = html ? null : splitQuotedReply(message.bodyText);
  const side = message.fromTeam ? 'is-team' : message.mine ? 'is-mine' : 'is-mine is-colleague';
  return <div className={`portal-thread-item ${side}`}>
    <div className="portal-thread-meta">
      <strong>{message.mine ? 'Jij' : message.authorName}</strong>
      <span>{formatThreadTime(message.at)}{message.viaPortal ? ' · via het portaal' : ' · per e-mail'}</span>
    </div>
    {html
      ? <div className="portal-msg-html" dangerouslySetInnerHTML={{ __html: html }} />
      : <>
          <p>{parts?.main}</p>
          {parts?.quoted && <>
            <button type="button" className="portal-quote-toggle" aria-expanded={showQuoted} onClick={() => setShowQuoted(v => !v)}>
              {showQuoted ? 'Eerdere berichten verbergen' : 'Eerdere berichten tonen'}
            </button>
            {showQuoted && <p className="portal-msg-quoted">{parts.quoted}</p>}
          </>}
        </>}
  </div>;
}

function PortalNewMessage({ account, email, supplierName, onCancel, onSent }: {
  account: PortalAccount;
  email: string;
  supplierName: string;
  onCancel: () => void;
  onSent: (threadId: string) => void;
}) {
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!subject.trim() || !body.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await sendPortalMessage({ clientId: account.id, subject: subject.trim(), body: body.trim() });
      onSent(result.threadId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bericht versturen mislukt');
      setBusy(false);
    }
  }

  return <article className="portal-card portal-detail">
    <div className="portal-detail-head">
      <button type="button" className="portal-back" onClick={onCancel}>← Terug naar berichten</button>
    </div>
    <div className="portal-detail-title"><h2>Nieuw bericht aan {supplierName}</h2></div>
    <p className="portal-muted">
      Je bericht komt meteen bij {supplierName} binnen.{' '}
      {/* Een antwoord van het team gaat per mail naar het hoofdadres van de klant;
          een extra contactpersoon ziet het hier. */}
      {account.actingContact
        ? 'Het antwoord zie je hier terug, onder Berichten.'
        : `Het antwoord krijg je per e-mail${email ? ` op ${email}` : ''}, en je ziet het hier terug.`}
    </p>
    <div className="portal-ticket-form portal-message-form">
      <label className="portal-field"><span>Onderwerp</span><Input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Waar gaat je bericht over?" maxLength={200} disabled={busy} /></label>
      <label className="portal-field"><span>Bericht</span><Textarea value={body} onChange={e => setBody(e.target.value)} onKeyDown={submitOnCtrlEnter(send)} placeholder="Typ je bericht…" rows={6} maxLength={5000} disabled={busy} /></label>
      <p className="portal-muted">Wil je de voortgang van een vraag of probleem kunnen volgen? Maak dan liever een ticket aan.</p>
      {error && <p className="error">{error}</p>}
      <div className="portal-ticket-form-actions">
        <Button variant="primary" onClick={send} disabled={busy || !subject.trim() || !body.trim()}>{busy ? 'Versturen…' : 'Bericht versturen'}</Button>
      </div>
    </div>
  </article>;
}

// ── Instellingen: eigen e-mailmeldingen ──────────────────────────────
//
// Iedereen die op het portaal kan, kiest dit zelf, per dossier. Het geldt
// alleen voor de ingelogde persoon; een collega op hetzelfde portaal houdt
// eigen keuzes. Elke wijziging wordt meteen opgeslagen.

function SettingsTab({ account, supplierName, onBack }: { account: PortalAccount; supplierName: string; onBack: () => void }) {
  const [state, setState] = useState<PortalNotificationState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    setState(null); setError(null);
    fetchPortalNotificationSettings(account.id)
      .then(result => { if (active) setState(result); })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : 'Instellingen laden mislukt'); });
    return () => { active = false; };
  }, [account.id]);

  async function change(patch: Partial<PortalNotificationSettings>) {
    if (!state) return;
    const previous = state.settings;
    const next = { ...previous, ...patch };
    setState({ ...state, settings: next });
    setSaving(true); setSaved(false); setError(null);
    try {
      const stored = await updatePortalNotificationSettings(account.id, next);
      setState(prev => prev ? { ...prev, settings: stored } : prev);
      setSaved(true);
    } catch (e) {
      setState(prev => prev ? { ...prev, settings: previous } : prev);
      setError(e instanceof Error ? e.message : 'Opslaan mislukt');
    } finally {
      setSaving(false);
    }
  }

  const clientName = account.client?.name || 'dit dossier';

  const back = <div className="portal-detail-head"><button type="button" className="portal-back" onClick={onBack}>← Terug naar overzicht</button></div>;

  if (!state) {
    return <article className="portal-card">
      {back}
      <div className="portal-card-head"><h2>Instellingen</h2></div>
      {error ? <p className="error">{error}</p> : <div className="portal-boot"><span className="boot-spinner" aria-hidden="true" /><span>Instellingen laden…</span></div>}
    </article>;
  }

  const s = state.settings;
  return <article className="portal-card portal-settings">
    {back}
    <div className="portal-card-head">
      <h2>Instellingen</h2>
      <span className="portal-settings-status" aria-live="polite">{saving ? 'Opslaan…' : saved ? 'Opgeslagen' : ''}</span>
    </div>

    <section className="portal-settings-section">
      <h3>E-mailmeldingen over tickets</h3>
      <p className="portal-muted">
        We sturen ze naar <strong>{state.email}</strong>. Wat je hier kiest geldt alleen voor jou
        {state.otherPortalUsers > 0 ? ', niet voor je collega’s op dit portaal' : ''}.
      </p>
      {!state.orgEnabled && <p className="portal-settings-note">
        {supplierName} verstuurt op dit moment geen e-mailmeldingen over tickets. Je keuzes blijven bewaard; nieuwe antwoorden zie je hier in het portaal.
      </p>}
      <div className="portal-toggle-list">
        <PortalToggleRow
          label="Nieuw ticket"
          description="Een bevestiging als je een ticket indient, en een bericht als er een ticket voor je wordt aangemaakt."
          checked={s.ticketCreated}
          onChange={value => void change({ ticketCreated: value })}
        />
        <PortalToggleRow
          label="Statuswijziging"
          description="Als de status van een ticket verandert, bijvoorbeeld naar ‘In behandeling’ of ‘Goedgekeurd’."
          checked={s.ticketStatus}
          onChange={value => void change({ ticketStatus: value })}
        />
        <PortalToggleRow
          label="Nieuw antwoord"
          description={`Als ${supplierName}${state.otherPortalUsers > 0 ? ' of een collega' : ''} reageert op een ticket. Het antwoord staat in de e-mail.`}
          checked={s.ticketReply}
          onChange={value => void change({ ticketReply: value })}
        />
      </div>
    </section>

    <section className="portal-settings-section">
      <h3>Over welke tickets?</h3>
      <div className="portal-choice-list" role="radiogroup" aria-label="Over welke tickets wil je e-mail krijgen?">
        <label className={`portal-choice${s.scope === 'all' ? ' is-selected' : ''}`}>
          <input type="radio" name={`portal-scope-${account.id}`} checked={s.scope === 'all'} onChange={() => void change({ scope: 'all' })} />
          <span>
            <strong>Alle tickets van {clientName}</strong>
            <small>Ook tickets die {supplierName}{state.otherPortalUsers > 0 ? ' of een collega' : ''} aanmaakt.</small>
          </span>
        </label>
        <label className={`portal-choice${s.scope === 'own' ? ' is-selected' : ''}`}>
          <input type="radio" name={`portal-scope-${account.id}`} checked={s.scope === 'own'} onChange={() => void change({ scope: 'own' })} />
          <span>
            <strong>Alleen tickets die ik zelf heb ingediend</strong>
            <small>Andere tickets zie je wel hier in het portaal, maar je krijgt er geen e-mail over.</small>
          </span>
        </label>
      </div>
    </section>

    <section className="portal-settings-section">
      <h3>Berichten</h3>
      <p className="portal-muted">
        {state.isPrimary
          ? `Berichten van ${supplierName} krijg je gewoon per e-mail, en ze staan ook onder Berichten. Daar zit geen schakelaar op: dat zijn geen meldingen, maar de berichten zelf.`
          : `Berichten van ${supplierName} staan onder Berichten. Per e-mail gaan ze naar het hoofdadres van ${clientName}.`}
      </p>
    </section>

    {error && <p className="error">{error}</p>}
  </article>;
}

function PortalToggleRow({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return <div className="portal-toggle-row">
    <span className="portal-toggle-text">
      <label htmlFor={id}>{label}</label>
      <small id={`${id}-hint`}>{description}</small>
    </span>
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={`${id}-hint`}
      className={`portal-switch${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="portal-switch-knob" aria-hidden="true" />
      <span className="portal-switch-text">{checked ? 'Aan' : 'Uit'}</span>
    </button>
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
        <span className="portal-project-dot" style={{ background: p.color || 'var(--accent)' }} />
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
        <h2><span className="portal-project-dot" style={{ background: project.color || 'var(--accent)' }} /> {project.name}</h2>
        {project.archived && <span className="portal-status">Afgerond</span>}
      </div>
      <p className="portal-muted">{project.start_date ? `Start ${dateNL(project.start_date)}` : 'Nog geen startdatum'}{project.end_date ? ` · Eind ${dateNL(project.end_date)}` : ''}</p>
      {project.description && <p className="portal-detail-desc">{project.description}</p>}

      <div className="portal-progress">
        <div className="portal-progress-head"><span>Voortgang</span><strong>{progress}%</strong></div>
        <div className="portal-progress-bar"><span style={{ '--fill': progress / 100 } as React.CSSProperties} /></div>
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
