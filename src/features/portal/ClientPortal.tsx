import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select, Textarea } from '../../components/Ui';
import { isSupabaseConfigured } from '../../lib/supabase';
import { supabasePortalAuth } from '../../lib/supabasePortal';
import {
  createPortalTicket,
  downloadPortalInvoicePdf,
  fetchPortalData,
  requestPortalLogin,
  type PortalAccount,
  type PortalInvoice,
  type PortalQuote,
  type PortalTicket,
} from '../../lib/portalApi';
import { dateNL, euro, lineGross, priorityLabel, total } from '../../lib/format';
import type { Priority } from '../../types';

type PortalTab = 'overview' | 'invoices' | 'quotes' | 'tickets' | 'projects';

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
          <div className="portal-brand-sub">{email || 'Klantportaal'}</div>
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
    { id: 'tickets', label: 'Tickets', count: account.tickets.length },
    { id: 'projects', label: 'Projecten', count: ongoingProjects.length },
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
        <div className="portal-rows">{account.invoices.slice(0, 4).map(inv => <InvoiceRow key={inv.id} invoice={inv} />)}</div>
      </article>

      <article className="portal-card">
        <div className="portal-card-head"><h2>Recente offertes</h2>{account.quotes.length > 0 && <button type="button" className="portal-more" onClick={() => setTab('quotes')}>Alle offertes →</button>}</div>
        {account.quotes.length === 0 && <p className="portal-muted">Nog geen offertes.</p>}
        <div className="portal-rows">{account.quotes.slice(0, 4).map(q => <QuoteRow key={q.id} quote={q} />)}</div>
      </article>

      {account.company && <PortalContactCard account={account} />}
    </div>}

    {tab === 'invoices' && <article className="portal-card">
      <div className="portal-card-head"><h2>Facturen</h2><span>{account.invoices.length}</span></div>
      {account.invoices.length === 0 && <p className="portal-muted">Er zijn nog geen facturen voor je.</p>}
      <div className="portal-rows">{account.invoices.map(inv => <InvoiceRow key={inv.id} invoice={inv} downloadable />)}</div>
    </article>}

    {tab === 'quotes' && <article className="portal-card">
      <div className="portal-card-head"><h2>Offertes</h2><span>{account.quotes.length}</span></div>
      {account.quotes.length === 0 && <p className="portal-muted">Er zijn nog geen offertes voor je.</p>}
      <div className="portal-rows">{account.quotes.map(q => <QuoteRow key={q.id} quote={q} />)}</div>
    </article>}

    {tab === 'tickets' && <TicketsTab account={account} onTicketCreated={onTicketCreated} />}

    {tab === 'projects' && <article className="portal-card">
      <div className="portal-card-head"><h2>Projecten</h2><span>{account.projects.length}</span></div>
      {account.projects.length === 0 && <p className="portal-muted">Er zijn nog geen projecten voor je.</p>}
      <div className="portal-project-list">
        {account.projects.map(p => <div key={p.id} className="portal-project">
          <span className="portal-project-dot" style={{ background: p.color || '#FFD966' }} />
          <div className="portal-project-body">
            <strong>{p.name}{p.archived && <em className="portal-archived"> · Afgerond</em>}</strong>
            {p.description && <p>{p.description}</p>}
            <span className="portal-muted">{p.start_date ? `Start ${dateNL(p.start_date)}` : 'Nog geen startdatum'}{p.end_date ? ` · Eind ${dateNL(p.end_date)}` : ''}</span>
          </div>
        </div>)}
      </div>
    </article>}
  </div>;
}

function PortalKpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'warning' | 'danger' }) {
  return <div className={`portal-kpi${tone ? ` ${tone}` : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{sub}</small>
  </div>;
}

function InvoiceRow({ invoice, downloadable }: { invoice: PortalInvoice; downloadable?: boolean }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overdue = isInvoiceOverdue(invoice);
  const amount = total(invoice.lines).total;

  async function download() {
    setDownloading(true); setError(null);
    try {
      const pdf = await downloadPortalInvoicePdf(invoice.id);
      downloadBase64File(pdf.base64, pdf.fileName, pdf.mimeType);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Downloaden mislukt');
    } finally {
      setDownloading(false);
    }
  }

  return <div className={`portal-row${overdue ? ' is-overdue' : ''}`}>
    <div className="portal-row-main">
      <span className="portal-row-number">{invoice.number}</span>
      <span className="portal-muted">{dateNL(invoice.date)} · Vervalt {dateNL(invoice.due_date)}</span>
    </div>
    <span className="portal-row-amount">{euro(amount)}</span>
    <span className={`portal-status ${overdue ? 'overdue' : invoice.status}`}>{overdue ? 'Vervallen' : (invoiceStatusLabels[invoice.status] ?? invoice.status)}</span>
    {downloadable && <div className="portal-row-actions">
      <Button onClick={download} disabled={downloading}>{downloading ? 'PDF…' : 'PDF'}</Button>
      {error && <span className="portal-row-error">{error}</span>}
    </div>}
  </div>;
}

function QuoteRow({ quote }: { quote: PortalQuote }) {
  const amount = total(quote.lines).total;
  return <div className="portal-row">
    <div className="portal-row-main">
      <span className="portal-row-number">{quote.number}</span>
      <span className="portal-muted">{dateNL(quote.date)} · Geldig tot {dateNL(quote.valid_until)}</span>
    </div>
    <span className="portal-row-amount">{euro(amount)}</span>
    <span className={`portal-status ${quote.status}`}>{quoteStatusLabels[quote.status] ?? quote.status}</span>
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
      {account.tickets.map(t => <TicketRow key={t.id} ticket={t} highlight={t.id === createdId} />)}
    </div>
  </article>;
}

function TicketRow({ ticket, highlight }: { ticket: PortalTicket; highlight?: boolean }) {
  return <div className={`portal-row portal-ticket${highlight ? ' is-new' : ''}`}>
    <div className="portal-row-main">
      <span className="portal-row-number">{ticket.title}</span>
      <span className="portal-muted">{dateNL(ticket.created_at)} · Prioriteit {priorityLabel(ticket.priority)}</span>
      {ticket.description && <p className="portal-ticket-desc">{ticket.description}</p>}
    </div>
    <span className={`portal-status ticket-${ticket.status}`}>{ticketStatusLabels[ticket.status] ?? ticket.status}</span>
  </div>;
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

const ticketStatusLabels: Record<string, string> = {
  new: 'Nieuw',
  review: 'In behandeling',
  approved: 'Goedgekeurd',
  rejected: 'Afgewezen',
  converted: 'Omgezet naar project',
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
