import { useEffect, useRef, useState } from 'react';
import { Button, Input, Textarea } from '../components/Ui';
import { sanitizeRichText } from '../components/RichTextEditor';
import { supabase } from '../lib/supabase';
import { dateNL } from '../lib/format';

const CONSENT_TEXT =
  'Ik heb dit contract gelezen en ga ermee akkoord. Ik onderteken dit document rechtsgeldig met een elektronische handtekening.';

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

type PublicContract = {
  id: string;
  number: string;
  title: string;
  body: string;
  /**
   * 'pdf' = het contract is in Word opgesteld; de klant leest het echte document
   * (dan is `body` leeg). 'html' = de oude rich-text-contracten. Het veld is
   * optioneel omdat een nog niet bijgewerkte edge function het niet meestuurt —
   * dan valt de pagina terug op het HTML-pad, precies zoals vroeger.
   */
  content_kind?: 'html' | 'pdf';
  /** De PDF zelf, base64. Null als de documentserver even niet bereikbaar was. */
  document_pdf_base64?: string | null;
  date: string;
  valid_until: string | null;
  status: string;
  signed_at: string | null;
  public_token_expires_at: string | null;
};
type PublicClient = { name: string; contact_name: string | null; email: string | null } | null;
type PublicCompany = { company_name: string; trade_name: string | null; email: string | null; phone: string | null; website: string | null; invoice_accent_color: string | null } | null;
type PublicSigner = { name: string; email: string; status: string; signed_at: string | null; signature_method: string | null } | null;
type PublicEvent = { id: string; event_type: string; title: string; description: string | null; created_at: string };
type Payload = { contract: PublicContract; client: PublicClient; company: PublicCompany; signer: PublicSigner; events: PublicEvent[] };

export function PublicContractPage({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState<'typed' | 'drawn'>('typed');
  const [drawnImage, setDrawnImage] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);

  const [panel, setPanel] = useState<'none' | 'decline' | 'question'>('none');
  const [declineReason, setDeclineReason] = useState('');
  const [question, setQuestion] = useState('');
  const [questionSent, setQuestionSent] = useState(false);

  // Word-contract: de PDF komt als base64 mee en wordt hier een blob-URL.
  const [documentUrl, setDocumentUrl] = useState<string | null>(null);
  const [documentBroken, setDocumentBroken] = useState(false);

  async function load() {
    setLoading(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('contract-public', { body: { action: 'getContract', token } });
      if (error) throw new Error(await extractFunctionError(error, 'Contract laden mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Contract laden mislukt');
      setPayload(data as Payload & { ok: true });
      setName(prev => prev || data.signer?.name || data.client?.contact_name || data.client?.name || '');
      setEmail(prev => prev || data.signer?.email || data.client?.email || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Contract laden mislukt');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [token]);

  const documentBase64 = payload?.contract.content_kind === 'pdf' ? payload?.contract.document_pdf_base64 ?? null : null;
  useEffect(() => {
    if (!documentBase64) { setDocumentUrl(null); setDocumentBroken(false); return; }
    let url: string;
    try {
      url = URL.createObjectURL(base64ToPdfBlob(documentBase64));
    } catch {
      // Onleesbare base64 telt als "geen document": dan mag er ook niet getekend worden.
      setDocumentUrl(null); setDocumentBroken(true);
      return;
    }
    setDocumentUrl(url); setDocumentBroken(false);
    // Na tekenen of weigeren komt er een verse payload binnen met opnieuw de hele
    // PDF. Zonder revoke houdt de browser elke eerdere versie in het geheugen.
    return () => URL.revokeObjectURL(url);
  }, [documentBase64]);

  async function sign() {
    setSubmitting(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('contract-public', {
        body: {
          action: 'signContract', token,
          signerName: name, signerEmail: email,
          signatureMethod: method,
          signatureImage: method === 'drawn' ? drawnImage : '',
          consentText: CONSENT_TEXT,
        },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Ondertekenen mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Ondertekenen mislukt');
      setPayload(data as Payload & { ok: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ondertekenen mislukt');
    } finally {
      setSubmitting(false);
    }
  }

  async function decline() {
    setSubmitting(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('contract-public', {
        body: { action: 'declineContract', token, name, email, reason: declineReason },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Weigeren mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Weigeren mislukt');
      setPayload(data as Payload & { ok: true });
      setPanel('none');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Weigeren mislukt');
    } finally {
      setSubmitting(false);
    }
  }

  async function ask() {
    setSubmitting(true); setError(null);
    try {
      const { data, error } = await supabase.functions.invoke('contract-public', {
        body: { action: 'askQuestion', token, name, email, message: question },
      });
      if (error) throw new Error(await extractFunctionError(error, 'Versturen mislukt'));
      if (!data?.ok) throw new Error(data?.error || 'Versturen mislukt');
      setQuestionSent(true); setQuestion('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Versturen mislukt');
    } finally {
      setSubmitting(false);
    }
  }

  const contract = payload?.contract;
  const company = payload?.company;
  const companyName = company?.trade_name || company?.company_name || 'ResoFly';
  const accent = company?.invoice_accent_color && /^#[0-9a-f]{6}$/i.test(company.invoice_accent_color) ? company.invoice_accent_color : '#FFD966';
  const isFinal = contract && ['signed', 'declined', 'expired', 'voided'].includes(contract.status);
  const isPdfContract = contract?.content_kind === 'pdf';
  // Niemand tekent iets wat hij niet heeft kunnen lezen: zonder document geen
  // ondertekenmogelijkheid. Weigeren en een vraag stellen blijven wél gewoon werken.
  const documentUnavailable = Boolean(isPdfContract && (!contract?.document_pdf_base64 || documentBroken));
  const canSign = !documentUnavailable && Boolean(name.trim()) && isValidEmail(email) && consent && (method === 'typed' ? Boolean(name.trim()) : Boolean(drawnImage));

  function downloadDocument() {
    if (!documentUrl || !contract) return;
    const link = document.createElement('a');
    link.href = documentUrl;
    link.download = `contract-${(contract.number || 'document').replace(/[^\w.-]+/g, '-')}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Bewust géén revoke: deze object-URL is van de useEffect hierboven en voedt
    // ook het iframe — intrekken zou de weergave leegmaken.
  }

  if (loading) return <main className="public-quote-page"><div className="public-quote-card"><h1>Contract laden…</h1></div></main>;
  if (error && !payload) return <main className="public-quote-page"><div className="public-quote-card"><p className="eyebrow">Contract</p><h1>Deze link werkt niet meer</h1><p>{error}</p></div></main>;
  if (!contract) return <main className="public-quote-page"><div className="public-quote-card"><h1>Contract niet gevonden</h1></div></main>;

  return <main className="public-quote-page">
    <section className="public-quote-card public-quote-hero">
      <div>
        <p className="eyebrow">{companyName}</p>
        <h1>Contract {contract.number}</h1>
        <p>{contract.title || 'Bekijk je contract en onderteken het digitaal.'}</p>
      </div>
      <div className={`public-quote-status st-${contract.status}`}>{statusLabel(contract.status)}</div>
    </section>

    {error && <div className="public-quote-alert">{error}</div>}

    {/* Samenvatting (TL;DR) bovenaan, vóór de fijne lettertjes */}
    <section className="public-quote-card">
      <h2>In het kort</h2>
      <div className="quote-facts">
        <span>Onderwerp</span><strong>{contract.title || '—'}</strong>
        <span>Datum</span><strong>{dateNL(contract.date)}</strong>
        <span>Ondertekenen vóór</span><strong>{contract.valid_until ? dateNL(contract.valid_until) : 'Geen einddatum'}</strong>
        <span>Van</span><strong>{companyName}</strong>
      </div>
    </section>

    <section className="public-quote-card">
      <h2>Het contract</h2>
      {isPdfContract
        ? <ContractDocument url={documentUrl} unavailable={documentUnavailable} onDownload={downloadDocument} onRetry={() => void load()} />
        : <div className="contract-body" style={{ lineHeight: 1.6 }} dangerouslySetInnerHTML={{ __html: sanitizeRichText(contract.body) || '<p>(geen inhoud)</p>' }} />}
    </section>

    <section className="public-quote-card">
      <h2>Ondertekenen</h2>
      {isFinal ? <FinalState contract={contract} /> : <>
        <div className="public-decision-form">
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Volledige naam" />
            <Input value={email} onChange={e => setEmail(e.target.value)} placeholder="E-mailadres" />
          </div>

          {documentUnavailable
            ? <p style={{ marginTop: 14, color: '#d8d8df' }}>
                Ondertekenen kan pas zodra het contractdocument weer geladen kan worden — je hoort eerst te kunnen lezen wat je tekent. Je kunt hierboven opnieuw proberen, of ons nu al een vraag stellen of het contract weigeren.
              </p>
            : <>
                <div style={{ marginTop: 14 }}>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <MethodTab active={method === 'typed'} onClick={() => setMethod('typed')} accent={accent}>Typ je naam</MethodTab>
                    <MethodTab active={method === 'drawn'} onClick={() => setMethod('drawn')} accent={accent}>Teken handtekening</MethodTab>
                  </div>
                  {method === 'typed'
                    ? <div style={{ border: '1px solid #2a2a31', borderRadius: 14, padding: '18px 16px', background: '#0e0e11', minHeight: 72, display: 'flex', alignItems: 'center' }}>
                        <span style={{ fontFamily: '"Brush Script MT","Segoe Script",cursive', fontSize: 34, color: '#fff' }}>{name || 'Je naam'}</span>
                      </div>
                    : <SignaturePad onChange={setDrawnImage} />}
                </div>

                <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 14, cursor: 'pointer', color: '#d8d8df' }}>
                  <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>{CONSENT_TEXT}</span>
                </label>
              </>}

          <div className="public-decision-actions" style={{ marginTop: 14 }}>
            <Button variant="ghost" onClick={() => { setPanel(panel === 'question' ? 'none' : 'question'); setQuestionSent(false); }} disabled={submitting}>Stel een vraag</Button>
            <Button variant="danger" onClick={() => setPanel(panel === 'decline' ? 'none' : 'decline')} disabled={submitting}>Weigeren</Button>
            {!documentUnavailable && <Button variant="primary" onClick={sign} disabled={submitting || !canSign}>Onderteken contract</Button>}
          </div>
          {!documentUnavailable && <p style={{ marginTop: 10, color: '#9b9ba7', fontSize: 13 }}>🔒 Beveiligde ondertekening. Tijdstip, IP-adres en je akkoord worden vastgelegd als bewijs (eenvoudige elektronische handtekening, eIDAS).</p>}
        </div>

        {panel === 'decline' && <div style={{ marginTop: 14, borderTop: '1px solid #2a2a31', paddingTop: 14 }}>
          <Textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)} placeholder="Reden van weigering (optioneel)" rows={3} />
          <div className="public-decision-actions" style={{ marginTop: 10 }}>
            <Button variant="ghost" onClick={() => setPanel('none')} disabled={submitting}>Annuleren</Button>
            <Button variant="danger" onClick={decline} disabled={submitting || !name.trim()}>Bevestig weigering</Button>
          </div>
        </div>}

        {panel === 'question' && <div style={{ marginTop: 14, borderTop: '1px solid #2a2a31', paddingTop: 14 }}>
          {questionSent
            ? <p style={{ color: '#d8d8df' }}>Bedankt! Je vraag is verstuurd. We nemen zo snel mogelijk contact met je op.</p>
            : <>
                <Textarea value={question} onChange={e => setQuestion(e.target.value)} placeholder="Waar kunnen we je mee helpen?" rows={4} />
                <div className="public-decision-actions" style={{ marginTop: 10 }}>
                  <Button variant="ghost" onClick={() => setPanel('none')} disabled={submitting}>Annuleren</Button>
                  <Button variant="primary" onClick={ask} disabled={submitting || !question.trim()}>Verstuur vraag</Button>
                </div>
              </>}
        </div>}
      </>}
    </section>

    {payload?.events && payload.events.length > 0 && <section className="public-quote-card">
      <h2>Tijdlijn</h2>
      <div className="quote-timeline public">
        {payload.events.map(event => <div className="quote-timeline-item" key={event.id}>
          <span>{new Date(event.created_at).toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <strong>{event.title}</strong>
          {event.description && <p>{event.description}</p>}
        </div>)}
      </div>
    </section>}
  </main>;
}

/**
 * Word-contract: de klant krijgt het échte document te zien, niet een benadering
 * ervan in HTML. Het iframe is de comfortabele route; de downloadknop is het
 * vangnet, want een deel van de mobiele browsers weigert PDF's in een iframe te
 * tonen en dan moet de klant het contract alsnog kunnen lezen vóór hij tekent.
 */
function ContractDocument({ url, unavailable, onDownload, onRetry }: {
  url: string | null;
  unavailable: boolean;
  onDownload: () => void;
  onRetry: () => void;
}) {
  if (unavailable) {
    return <div className="public-decision-done">
      <h3>Het document kan nu niet worden geladen</h3>
      <p>Dit contract is als document opgesteld, maar we krijgen het op dit moment niet opgehaald. Dat ligt niet aan jou — probeer het over een paar minuten nog eens.</p>
      <p>Blijft het misgaan? Laat het ons weten via ‘Stel een vraag’ hieronder, dan sturen we je het contract per e-mail.</p>
      <div className="public-decision-actions" style={{ marginTop: 12 }}>
        <Button variant="primary" onClick={onRetry}>Opnieuw proberen</Button>
      </div>
    </div>;
  }

  return <div style={{ display: 'grid', gap: 12 }}>
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
      {/* flex-basis 240px: op een telefoon zakt de downloadknop netjes onder de tekst i.p.v. hem plat te drukken. */}
      <span style={{ color: '#9b9ba7', fontSize: 13, flex: '1 1 240px', minWidth: 0 }}>Lees het contract hieronder. Zie je het niet (dat gebeurt op sommige telefoons)? Download dan de PDF.</span>
      <Button variant="ghost" onClick={onDownload} disabled={!url}>Download PDF</Button>
    </div>
    {url
      ? <iframe
          key={url}
          src={`${url}#view=FitH`}
          title="Contractdocument (PDF)"
          style={{ width: '100%', height: 'min(80vh, 900px)', minHeight: 360, display: 'block', border: '1px solid #2a2a31', borderRadius: 14, background: '#fff' }}
        />
      : <div style={{ padding: 24, textAlign: 'center', color: '#9b9ba7', border: '1px solid #2a2a31', borderRadius: 14 }}>Document wordt geladen…</div>}
  </div>;
}

/** Base64 uit de edge function → blob, zodat het iframe en de download dezelfde PDF gebruiken. */
function base64ToPdfBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}

function FinalState({ contract }: { contract: PublicContract }) {
  if (contract.status === 'signed') {
    return <div className="public-decision-done">
      <h3>✅ Contract ondertekend</h3>
      <p>Bedankt! Je hebt dit contract ondertekend op {contract.signed_at ? new Date(contract.signed_at).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' }) : 'zojuist'}.</p>
      <p>Een ondertekend exemplaar is naar je e-mailadres verstuurd. Je kunt het ook terugvinden in je klantportaal.</p>
    </div>;
  }
  if (contract.status === 'declined') {
    return <div className="public-decision-done"><h3>Contract geweigerd</h3><p>Je hebt dit contract geweigerd. Neem gerust contact op als je vragen hebt.</p></div>;
  }
  return <div className="public-decision-done"><h3>Niet meer beschikbaar</h3><p>Dit contract kan niet meer worden ondertekend.</p></div>;
}

function MethodTab({ active, onClick, accent, children }: { active: boolean; onClick: () => void; accent: string; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} style={{
    flex: 1, padding: '9px 12px', borderRadius: 12, cursor: 'pointer', fontWeight: 600, fontSize: 14,
    border: `1px solid ${active ? accent : '#2a2a31'}`,
    background: active ? accent : 'transparent',
    color: active ? '#111' : '#d8d8df',
  }}>{children}</button>;
}

/** Mobiel-vriendelijk handtekeningveld op basis van pointer events (muis + touch). */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const setup = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ratio = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      canvas.width = Math.round(rect.width * ratio);
      canvas.height = Math.round(rect.height * ratio);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111';
      // canvas.width zetten wist de tekening. Reset daarom ook de bewijs-state,
      // zodat de klant nooit ondertekent met een handtekening die door een resize
      // onzichtbaar is geworden (of met een oude tekening na remount).
      inked.current = false;
      onChangeRef.current(null);
    };
    setup();
    window.addEventListener('resize', setup);
    return () => window.removeEventListener('resize', setup);
  }, []);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext('2d'); if (!ctx) return;
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext('2d'); if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
    inked.current = true;
  }
  function up() {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current && canvasRef.current) onChange(canvasRef.current.toDataURL('image/png'));
  }
  function clear() {
    const canvas = canvasRef.current; const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    inked.current = false;
    onChange(null);
  }

  return <div>
    <canvas
      ref={canvasRef}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}
      style={{ width: '100%', height: 160, background: '#fff', borderRadius: 14, border: '1px solid #2a2a31', touchAction: 'none', cursor: 'crosshair', display: 'block' }}
    />
    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
      <span style={{ color: '#9b9ba7', fontSize: 13 }}>Teken je handtekening met je muis of vinger.</span>
      <button type="button" onClick={clear} style={{ background: 'none', border: 'none', color: '#9b9ba7', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}>Wissen</button>
    </div>
  </div>;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    sent: 'Wacht op ondertekening',
    signed: 'Ondertekend',
    declined: 'Geweigerd',
    expired: 'Verlopen',
    voided: 'Ingetrokken',
  };
  return labels[status] || status;
}
