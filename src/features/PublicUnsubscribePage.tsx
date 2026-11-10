// Afmelden voor marketingmail: /afmelden?token=… — zonder login.
//
// De afmeldlink in een campagnemail ging rechtstreeks naar de edge function
// email-unsubscribe, die een HTML-pagina met een knop gaf. Supabase serveert een
// GET met text/html op *.supabase.co als platte tekst: wie op "Afmelden"
// klikte, zag code in plaats van een knop (de rooktest van 10 november stelde
// het vast). Daarom stuurt de functie een browser nu hierheen, en doet deze
// pagina hetzelfde met twee POST-verzoeken: wie is het (info), en afmelden.
//
// Bewust eerst een knop, niet meteen afmelden bij openen: virusscanners en
// mailprogramma's openen links vooraf, en dan was iemand afgemeld zonder het te
// willen. Afmelden met één klik vanuit het mailprogramma (RFC 8058) loopt niet
// langs hier, maar rechtstreeks naar de functie.
import { useEffect, useState } from 'react';
import { Button } from '../components/Ui';
import { supabase } from '../lib/supabase';
import { usePublicPageTitle } from '../components/PublicBrand';

type Info = { brandName: string; email: string; unsubscribed: boolean };

async function callUnsubscribe(token: string, action: 'info' | 'unsubscribe'): Promise<Info> {
  const { data, error } = await supabase.functions.invoke('email-unsubscribe', { body: { action, token } });
  if (error) {
    const context = (error as { context?: unknown }).context;
    const payload = context instanceof Response ? await context.clone().json().catch(() => null) as { error?: string } | null : null;
    throw new Error(payload?.error || 'Afmelden lukt nu niet. Probeer het later opnieuw.');
  }
  return data as Info;
}

export function PublicUnsubscribePage({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  usePublicPageTitle('Afmelden', info?.brandName ?? null);

  useEffect(() => {
    let active = true;
    callUnsubscribe(token, 'info')
      .then((result) => { if (active) setInfo(result); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      setInfo(await callUnsubscribe(token, 'unsubscribe'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="public-quote-page"><div className="public-quote-card"><h1>Even laden…</h1></div></main>;
  }
  if (!info) {
    return <main className="public-quote-page"><div className="public-quote-card">
      <p className="eyebrow">Afmelden</p>
      <h1>Deze afmeldlink werkt niet</h1>
      <p>{error || 'De link is ongeldig.'} Wil je geen mail meer ontvangen? Neem dan contact op met de afzender.</p>
    </div></main>;
  }

  return <main className="public-quote-page">
    {/* Wat lucht tussen tekst, knop en uitleg: de kaart zelf zet geen marges. */}
    <section className="public-quote-card" style={{ display: 'grid', gap: 14, justifyItems: 'start' }}>
      <p className="eyebrow">{info.brandName}</p>
      {info.unsubscribed
        ? <>
          <h1>Je bent afgemeld</h1>
          <p>Je ontvangt geen marketingmail meer van {info.brandName} op <strong>{info.email}</strong>.</p>
        </>
        : <>
          <h1>Afmelden voor marketingmail</h1>
          <p>Wil je je afmelden voor marketingmail van {info.brandName} op <strong>{info.email}</strong>?</p>
          {error && <div className="public-quote-alert">{error}</div>}
          <Button variant="primary" onClick={() => void confirm()} disabled={busy}>
            {busy ? 'Bezig…' : 'Ja, meld mij af'}
          </Button>
          <p className="muted">Berichten over lopende zaken, zoals facturen, kun je daarna nog steeds krijgen.</p>
        </>}
    </section>
  </main>;
}
