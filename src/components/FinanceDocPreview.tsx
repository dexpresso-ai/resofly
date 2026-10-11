import { useEffect, useRef, useState } from 'react';
import type { Client, CompanySettings, Invoice, Quote } from '../types';
import { createFinancePDFBlob } from '../lib/pdf';

/**
 * De PDF zoals hij verstuurd is — bij een factuur de opgeslagen snapshot, die
 * ook in de e-factuur zit. Verandert `key` (bijvoorbeeld na een nieuwe
 * verzending), dan wordt hij opnieuw opgehaald.
 */
export type SentPdfSource = { key: string; label: string; load: () => Promise<Blob> };

// Herbruikbare live PDF-voorbeeldweergave. Genereert (gedebounced) de echte PDF via de
// gedeelde generator zodat het voorbeeld 1:1 gelijk is aan wat de klant ontvangt — inclusief
// bedrijfstemplate/achtergrond, accentkleur en lettergrootte. Wordt gebruikt door zowel de
// offerte-/factuur-editor als de detailweergave van verzonden documenten. Is het document al
// verstuurd (`sentPdf`), dan toont hij standaard díe PDF, met een knop naar het voorbeeld.
export function FinanceDocPreview({
  doc,
  kind,
  client,
  company,
  title,
  sentPdf,
}: {
  doc: Quote | Invoice;
  kind: 'quote' | 'invoice';
  client: Client | null;
  company: CompanySettings | null;
  title?: string;
  sentPdf?: SentPdfSource | null;
}) {
  const sentKey = sentPdf?.key ?? null;
  const [mode, setMode] = useState<'sent' | 'live'>(sentKey ? 'sent' : 'live');
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'rendering' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ key: string; url: string } | null>(null);
  const [sentStatus, setSentStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sentError, setSentError] = useState<string | null>(null);
  const loadSent = useRef(sentPdf?.load);
  loadSent.current = sentPdf?.load;

  // Net verstuurd (er komt een verzonden PDF bij) of juist niet: volg dat.
  useEffect(() => { setMode(sentKey ? 'sent' : 'live'); }, [sentKey]);

  useEffect(() => {
    if (mode !== 'live') return;
    let cancelled = false;
    setStatus('rendering');
    // Korte debounce: bij snel typen in de editor wordt alleen het laatste resultaat getoond.
    const handle = setTimeout(() => {
      createFinancePDFBlob(doc, kind, client, { company })
        .then(blob => {
          if (cancelled) return;
          setUrl(URL.createObjectURL(blob));
          setError(null);
          setStatus('ready');
        })
        .catch(err => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : 'Voorbeeld kon niet worden gegenereerd.');
          setStatus('error');
        });
    }, 350);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [doc, kind, client, company, mode]);

  // De verzonden PDF één keer per sleutel ophalen; terugschakelen haalt hem niet opnieuw op.
  useEffect(() => {
    if (mode !== 'sent' || !sentKey || sent?.key === sentKey || !loadSent.current) return;
    let cancelled = false;
    setSentStatus('loading');
    loadSent.current()
      .then(blob => {
        if (cancelled) return;
        setSent({ key: sentKey, url: URL.createObjectURL(blob) });
        setSentError(null);
        setSentStatus('ready');
      })
      .catch(err => {
        if (cancelled) return;
        setSentError(err instanceof Error ? err.message : 'De verzonden PDF kon niet worden opgehaald.');
        setSentStatus('error');
      });
    return () => { cancelled = true; };
  }, [mode, sentKey, sent?.key]);

  // Ruim de vorige object-URL op zodra een nieuwe is gezet en bij unmount (voorkomt lekken).
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);
  useEffect(() => {
    if (!sent) return;
    return () => URL.revokeObjectURL(sent.url);
  }, [sent]);

  const showSent = mode === 'sent' && Boolean(sentPdf);
  const frameUrl = showSent ? (sent?.key === sentKey ? sent.url : null) : url;
  const heading = showSent && sentPdf ? sentPdf.label : title ?? (kind === 'quote' ? 'Live offerte-voorbeeld' : 'Live factuur-voorbeeld');
  const failed = showSent ? sentStatus === 'error' : status === 'error';
  const failure = showSent ? (sentError ?? 'De verzonden PDF kon niet worden opgehaald.') : (error ?? 'Voorbeeld kon niet worden gegenereerd.');
  const stateLabel = showSent
    ? (sentStatus === 'loading' ? 'Ophalen…' : sentStatus === 'error' ? 'Fout' : 'Zoals verstuurd')
    : (status === 'rendering' ? 'Voorbeeld bijwerken…' : status === 'error' ? 'Fout' : 'Bijgewerkt');

  return <div className="finance-preview" aria-label={showSent ? 'De verzonden PDF' : 'Live voorbeeld van het document'}>
    <div className="finance-preview-head">
      <span>{heading}</span>
      {sentPdf
        ? <div className="client-view-toggle finance-preview-toggle" role="group" aria-label="Welke PDF">
          <button type="button" className={showSent ? 'active' : ''} aria-pressed={showSent} onClick={() => setMode('sent')} title="De PDF die de klant kreeg">Verzonden</button>
          <button type="button" className={!showSent ? 'active' : ''} aria-pressed={!showSent} onClick={() => setMode('live')} title="Opnieuw opgebouwd uit de huidige gegevens">Voorbeeld</button>
        </div>
        : <small>{stateLabel}</small>}
    </div>
    <div className="finance-preview-stage">
      {frameUrl && <iframe key={frameUrl} className="finance-preview-frame" src={`${frameUrl}#toolbar=0&navpanes=0&view=FitH`} title={showSent ? 'Verzonden PDF' : 'PDF-voorbeeld'} />}
      {!frameUrl && !failed && <div className="finance-preview-placeholder">{showSent ? 'Verzonden PDF wordt opgehaald…' : 'Voorbeeld wordt geladen…'}</div>}
      {!showSent && status === 'rendering' && url && <div className="finance-preview-overlay">Voorbeeld bijwerken…</div>}
      {failed && <div className="finance-preview-error">{failure}</div>}
    </div>
  </div>;
}
