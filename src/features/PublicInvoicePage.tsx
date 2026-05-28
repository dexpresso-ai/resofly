import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { dateNL, euro, total, lineGross } from '../lib/format';
import type { FinanceLine } from '../types';

// Supabase functions.invoke geeft een non-2xx terug als FunctionsHttpError, waarvan
// .message altijd de generieke "Edge Function returned a non-2xx status code" is.
// De echte foutreden zit in de response-body (error.context). Deze helper haalt die
// op, zodat de gebruiker ziet WAAROM een link niet werkt (verlopen, origin geblokkeerd, etc.).
async function extractFunctionError(error: unknown, fallback: string): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    try {
      const payload = await context.clone().json().catch(() => null) as { error?: string } | null;
      if (payload?.error) return payload.error;
      const text = await context.text().catch(() => '');
      if (text) return text;
    } catch {
      // val terug op message hieronder
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

type PublicInvoice = {
  number: string;
  date: string;
  due_date: string | null;
  lines: FinanceLine[];
  status: string;
  notes: string | null;
  sent_at: string | null;
  paid_at: string | null;
  public_token_expires_at: string | null;
};

type PublicClient = { name?: string; contact_name?: string | null; email?: string | null; phone?: string | null } | null;
type PublicProject = { name?: string; description?: string | null; start_date?: string | null; end_date?: string | null } | null;
type PublicQuote = { id?: string; number?: string | null; status?: string | null; date?: string | null; total_amount?: number | null } | null;
type PublicCompany = { company_name?: string; trade_name?: string | null; email?: string | null; phone?: string | null; website?: string | null; city?: string | null; country?: string | null; iban?: string | null; vat_number?: string | null; kvk_number?: string | null } | null;
type PublicEvent = { event_type: string; title: string; description: string | null; created_at: string };
type PublicPayment = { status: string; amount_cents: number; currency: string; checkout_url: string | null; paid_at: string | null; checkout_expires_at: string | null; created_at: string };
type PublicVersion = { version_number: number; snapshot_reason: string; pdf_file_name: string | null; created_at: string };

type PublicInvoicePayload = {
  invoice: PublicInvoice;
  client: PublicClient;
  project: PublicProject;
  quote: PublicQuote;
  company: PublicCompany;
  events: PublicEvent[];
  payments: PublicPayment[];
  versions: PublicVersion[];
};

export function PublicInvoicePage({ token }: { token: string }) {
  const [payload, setPayload] = useState<PublicInvoicePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams(window.location.search);
      const mockPaymentId = params.get('mock_payment') || undefined;
      const { data, error } = await supabase.functions.invoke('invoice-public', {
        body: { action: 'getInvoice', token, mockPaymentId },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Factuur laden mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Factuur laden mislukt');
      setPayload(data as PublicInvoicePayload & { ok: true });
      if (mockPaymentId) {
        const cleanUrl = `${window.location.origin}${window.location.pathname}`;
        window.history.replaceState({}, document.title, cleanUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Factuur laden mislukt');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [token]);

  const invoice = payload?.invoice;
  const companyName = payload?.company?.trade_name || payload?.company?.company_name || 'ResoFly';
  const totals = useMemo(() => total(invoice?.lines || []), [invoice?.lines]);
  const payment = useMemo(() => {
    const records = payload?.payments || [];
    return records.find(record => record.status === 'open' && record.checkout_url) || records.find(record => record.checkout_url) || null;
  }, [payload?.payments]);
  const isPaid = invoice?.status === 'paid' || Boolean(invoice?.paid_at);

  async function downloadPdf() {
    if (!payload?.invoice) return;
    setDownloading(true);
    try {
      const { data, error } = await supabase.functions.invoke('invoice-public', {
        body: { action: 'getInvoicePdf', token },
      });
      if (error) throw new Error(await extractFunctionError(error, 'PDF-snapshot downloaden mislukt'));
      if (!data?.ok || !data.pdf?.base64) throw new Error(data?.error || 'PDF-snapshot downloaden mislukt');
      downloadBase64File(data.pdf.base64, data.pdf.fileName || `factuur-${payload.invoice.number}.pdf`, data.pdf.mimeType || 'application/pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PDF downloaden mislukt');
    } finally {
      setDownloading(false);
    }
  }

  if (loading) return <main className="public-quote-page"><div className="public-quote-card"><h1>Factuur laden…</h1></div></main>;

  if (error && !payload) return <main className="public-quote-page"><div className="public-quote-card"><p className="eyebrow">Factuur</p><h1>Deze link werkt niet meer</h1><p>{error}</p></div></main>;

  if (!invoice) return <main className="public-quote-page"><div className="public-quote-card"><h1>Factuur niet gevonden</h1></div></main>;

  return <main className="public-quote-page public-invoice-page">
    <section className="public-quote-card public-quote-hero">
      <div>
        <p className="eyebrow">{companyName}</p>
        <h1>Factuur {invoice.number}</h1>
        <p>{payload?.project?.name ? `Project: ${payload.project.name}` : 'Bekijk en betaal deze factuur veilig online.'}</p>
      </div>
      <div className={`public-quote-status st-${invoice.status}`}>{statusLabel(invoice.status, invoice.paid_at)}</div>
    </section>

    {error && <div className="public-quote-alert">{error}</div>}

    <section className="public-quote-grid">
      <article className="public-quote-card public-payment-card">
        <h2>Te betalen</h2>
        <strong className="public-invoice-amount">{euro(totals.total)}</strong>
        <div className="public-decision-actions public-invoice-actions">
          <Button onClick={downloadPdf} disabled={downloading}>{downloading ? 'PDF maken…' : 'PDF downloaden'}</Button>
          <Button variant="primary" disabled={isPaid || !payment?.checkout_url} onClick={() => payment?.checkout_url && window.open(payment.checkout_url, '_blank', 'noopener,noreferrer')}>{isPaid ? 'Betaald' : 'Betaal nu'}</Button>
        </div>
        {!payment?.checkout_url && !isPaid && <p className="muted">Er is nog geen actieve betaallink beschikbaar. Neem contact op met {companyName}.</p>}
      </article>
      <article className="public-quote-card">
        <h2>Factuurgegevens</h2>
        <div className="quote-facts">
          <span>Datum</span><strong>{dateNL(invoice.date)}</strong>
          <span>Vervaldatum</span><strong>{dateNL(invoice.due_date)}</strong>
          <span>Klant</span><strong>{payload?.client?.name || '—'}</strong>
          <span>Gekoppelde offerte</span><strong>{payload?.quote?.number || '—'}</strong>
        </div>
      </article>
    </section>

    <section className="public-quote-card">
      <h2>Regels</h2>
      <div className="public-lines">
        {(invoice.lines || []).map(line => {
          return <div className="public-line" key={line.id || line.description}>
            <div><strong>{line.description}</strong><span>{line.quantity} × {euro(line.unit_price)} · btw {line.vat ?? 0}%</span></div>
            <strong>{euro(lineGross(line))}</strong>
          </div>;
        })}
      </div>
      <div className="public-total-row"><span>Totaal excl. btw</span><strong>{euro(totals.subtotal)}</strong></div>
      {totals.vatBreakdown.length > 1
        ? totals.vatBreakdown.map(row => <div className="public-total-row" key={row.rate}><span>Btw {row.rate}% over {euro(row.base)}</span><strong>{euro(row.vat)}</strong></div>)
        : <div className="public-total-row"><span>Btw</span><strong>{euro(totals.vat)}</strong></div>}
      <div className="public-total-row grand"><span>Totaal incl. btw</span><strong>{euro(totals.total)}</strong></div>
      {invoice.notes && <div className="public-notes"><strong>Toelichting</strong><p>{invoice.notes}</p></div>}
    </section>

    <section className="public-quote-grid">
      <article className="public-quote-card">
        <h2>Betaling</h2>
        <div className="quote-facts">
          <span>Status</span><strong>{statusLabel(invoice.status, invoice.paid_at)}</strong>
          <span>Verzonden</span><strong>{dateNL(invoice.sent_at)}</strong>
          <span>Betaald op</span><strong>{dateNL(invoice.paid_at)}</strong>
          <span>IBAN</span><strong>{payload?.company?.iban || '—'}</strong>
        </div>
      </article>
      <article className="public-quote-card">
        <h2>Contact</h2>
        <p>{companyName}</p>
        {payload?.company?.email && <p>{payload.company.email}</p>}
        {payload?.company?.phone && <p>{payload.company.phone}</p>}
        {payload?.company?.website && <p>{payload.company.website}</p>}
      </article>
    </section>

    {payload.versions?.length > 0 && <section className="public-quote-card">
      <h2>PDF-snapshot</h2>
      <div className="quote-timeline public">
        {payload.versions.slice(0, 3).map(version => <div className="quote-timeline-item" key={`${version.version_number}-${version.created_at}`}>
          <span>v{version.version_number} · {dateNL(version.created_at)}</span>
          <strong>{version.pdf_file_name || 'Factuur PDF'}</strong>
          <p>{version.snapshot_reason}</p>
        </div>)}
      </div>
    </section>}

    <section className="public-quote-card">
      <h2>Tijdlijn</h2>
      <div className="quote-timeline public">
        {(payload?.events || []).map(event => <div className="quote-timeline-item" key={`${event.event_type}-${event.created_at}-${event.title}`}>
          <span>{new Date(event.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <strong>{event.title}</strong>
          {event.description && <p>{event.description}</p>}
        </div>)}
      </div>
    </section>
  </main>;
}


function downloadBase64File(base64: string, fileName: string, mimeType: string) {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i += 1) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
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

function statusLabel(status: string, paidAt?: string | null): string {
  if (paidAt) return 'Betaald';
  const labels: Record<string, string> = {
    draft: 'Concept',
    sent: 'Open',
    overdue: 'Verlopen',
    paid: 'Betaald',
    cancelled: 'Geannuleerd',
    void: 'Ongeldig gemaakt',
    written_off: 'Afgeboekt',
  };
  return labels[status] || status;
}
