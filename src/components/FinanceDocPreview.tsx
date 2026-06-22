import { useEffect, useState } from 'react';
import type { Client, CompanySettings, Invoice, Quote } from '../types';
import { createFinancePDFBlob } from '../lib/pdf';

// Herbruikbare live PDF-voorbeeldweergave. Genereert (gedebounced) de echte PDF via de
// gedeelde generator zodat het voorbeeld 1:1 gelijk is aan wat de klant ontvangt — inclusief
// bedrijfstemplate/achtergrond, accentkleur en lettergrootte. Wordt gebruikt door zowel de
// offerte-/factuur-editor als de detailweergave van verzonden documenten.
export function FinanceDocPreview({
  doc,
  kind,
  client,
  company,
  title,
}: {
  doc: Quote | Invoice;
  kind: 'quote' | 'invoice';
  client: Client | null;
  company: CompanySettings | null;
  title?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'rendering' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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
  }, [doc, kind, client, company]);

  // Ruim de vorige object-URL op zodra een nieuwe is gezet en bij unmount (voorkomt lekken).
  useEffect(() => {
    if (!url) return;
    return () => URL.revokeObjectURL(url);
  }, [url]);

  const heading = title ?? (kind === 'quote' ? 'Live offerte-voorbeeld' : 'Live factuur-voorbeeld');

  return <div className="finance-preview" aria-label="Live voorbeeld van het document">
    <div className="finance-preview-head">
      <span>{heading}</span>
      <small>{status === 'rendering' ? 'Voorbeeld bijwerken…' : status === 'error' ? 'Fout' : 'Bijgewerkt'}</small>
    </div>
    <div className="finance-preview-stage">
      {url && <iframe key={url} className="finance-preview-frame" src={`${url}#toolbar=0&navpanes=0&view=FitH`} title="PDF-voorbeeld" />}
      {!url && status !== 'error' && <div className="finance-preview-placeholder">Voorbeeld wordt geladen…</div>}
      {status === 'rendering' && url && <div className="finance-preview-overlay">Voorbeeld bijwerken…</div>}
      {status === 'error' && <div className="finance-preview-error">{error ?? 'Voorbeeld kon niet worden gegenereerd.'}</div>}
    </div>
  </div>;
}
