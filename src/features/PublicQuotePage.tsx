import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Textarea } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { dateNL, euro, total, lineGross } from '../lib/format';

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
import type { FinanceLine } from '../types';

type PublicQuote = {
  id: string;
  number: string;
  date: string;
  valid_until: string | null;
  lines: FinanceLine[];
  status: string;
  notes: string | null;
  public_token_expires_at: string | null;
  accepted_at: string | null;
  client_decision_at: string | null;
  client_decision_by_name: string | null;
  client_decision_by_email: string | null;
  client_decision_note: string | null;
};

type PublicClient = { name?: string; contact_name?: string | null; email?: string | null; phone?: string | null } | null;
type PublicProject = { name?: string; description?: string | null; start_date?: string | null; end_date?: string | null } | null;
type PublicCompany = { company_name?: string; trade_name?: string | null; email?: string | null; phone?: string | null; website?: string | null; city?: string | null; country?: string | null } | null;
type PublicEvent = { id: string; event_type: string; title: string; description: string | null; created_at: string };

type PublicQuotePayload = {
  quote: PublicQuote;
  client: PublicClient;
  project: PublicProject;
  company: PublicCompany;
  events: PublicEvent[];
};

export function PublicQuotePage({ token }: { token: string }) {
  const [payload, setPayload] = useState<PublicQuotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('quote-public', {
        body: { action: 'getQuote', token },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Offerte laden mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Offerte laden mislukt');
      setPayload(data as PublicQuotePayload & { ok: true });
      const contactName = data.client?.contact_name || data.client?.name || '';
      const contactEmail = data.client?.email || '';
      setName(prev => prev || contactName);
      setEmail(prev => prev || contactEmail);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Offerte laden mislukt');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [token]);

  async function decide(kind: 'accept' | 'reject') {
    setSubmitting(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('quote-public', {
        body: { action: kind === 'accept' ? 'acceptQuote' : 'rejectQuote', token, name, email, note },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Actie mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Actie mislukt');
      setPayload(data as PublicQuotePayload & { ok: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Actie mislukt');
    } finally {
      setSubmitting(false);
    }
  }

  const quote = payload?.quote;
  const companyName = payload?.company?.trade_name || payload?.company?.company_name || 'ResoFly';
  const totals = useMemo(() => total(quote?.lines || []), [quote?.lines]);
  const finalStatus = quote?.status === 'accepted' || quote?.status === 'rejected';

  if (loading) return <main className="public-quote-page"><div className="public-quote-card"><h1>Offerte laden…</h1></div></main>;

  if (error && !payload) return <main className="public-quote-page"><div className="public-quote-card"><p className="eyebrow">Offerte</p><h1>Deze link werkt niet meer</h1><p>{error}</p></div></main>;

  if (!quote) return <main className="public-quote-page"><div className="public-quote-card"><h1>Offerte niet gevonden</h1></div></main>;

  return <main className="public-quote-page">
    <section className="public-quote-card public-quote-hero">
      <div>
        <p className="eyebrow">{companyName}</p>
        <h1>Offerte {quote.number}</h1>
        <p>{payload?.project?.name ? `Project: ${payload.project.name}` : 'Bekijk de offerte en geef digitaal akkoord.'}</p>
      </div>
      <div className={`public-quote-status st-${quote.status}`}>{statusLabel(quote.status)}</div>
    </section>

    {error && <div className="public-quote-alert">{error}</div>}

    <section className="public-quote-grid">
      <article className="public-quote-card">
        <h2>Offertegegevens</h2>
        <div className="quote-facts">
          <span>Datum</span><strong>{dateNL(quote.date)}</strong>
          <span>Geldig tot</span><strong>{dateNL(quote.valid_until)}</strong>
          <span>Klant</span><strong>{payload?.client?.name || '—'}</strong>
          <span>Totaal incl. btw</span><strong>{euro(totals.total)}</strong>
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

    <section className="public-quote-card">
      <h2>Regels</h2>
      <div className="public-lines">
        {(quote.lines || []).map(line => {
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
      {quote.notes && <div className="public-notes"><strong>Toelichting</strong><p>{quote.notes}</p></div>}
    </section>

    <section className="public-quote-card">
      <h2>Goedkeuring</h2>
      {finalStatus ? <div className="public-decision-done">
        <h3>{quote.status === 'accepted' ? 'Offerte geaccepteerd' : 'Offerte geweigerd'}</h3>
        <p>Beslissing vastgelegd op {dateNL(quote.client_decision_at)} door {quote.client_decision_by_name || 'de klant'}.</p>
        {quote.client_decision_note && <p>Opmerking: {quote.client_decision_note}</p>}
      </div> : <div className="public-decision-form">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="Naam" />
        <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mailadres" />
        <Textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Opmerking, optioneel" />
        <div className="public-decision-actions">
          <Button variant="danger" onClick={() => decide('reject')} disabled={submitting || !name || !email}>Weigeren</Button>
          <Button variant="primary" onClick={() => decide('accept')} disabled={submitting || !name || !email}>Akkoord geven</Button>
        </div>
      </div>}
    </section>

    <section className="public-quote-card">
      <h2>Tijdlijn</h2>
      <div className="quote-timeline public">
        {(payload?.events || []).map(event => <div className="quote-timeline-item" key={event.id}>
          <span>{new Date(event.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <strong>{event.title}</strong>
          {event.description && <p>{event.description}</p>}
        </div>)}
      </div>
    </section>
  </main>;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    sent: 'Wacht op akkoord',
    accepted: 'Geaccepteerd',
    rejected: 'Geweigerd',
    expired: 'Verlopen',
    cancelled: 'Geannuleerd',
  };
  return labels[status] || status;
}
