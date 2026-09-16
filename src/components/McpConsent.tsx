import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from './Ui';
import { decideConsent, loadConsentRequest, type McpConsentRequest } from '../lib/mcp-api';
import type { UUID } from '../types';

/**
 * Het toestemmingsscherm: "mag deze AI bij je werkruimte?".
 *
 * Dit is het enige moment waarop een mens beslist of een programma van buiten
 * bij zijn administratie mag. Alles eromheen is techniek; dit scherm is de
 * beslissing. Daarom staat er geen marketingtaal op maar drie feiten: WIE het
 * vraagt, WAT hij te zien krijgt, en WAT hij niet kan. En de weigerknop staat
 * er even groot naast als de koppelknop — een toestemmingsscherm waarop "nee"
 * moeilijker is dan "ja" is geen toestemmingsscherm.
 *
 * De gebruiker is hier al ingelogd (App toont dit pas na de login), dus het
 * enige dat hij nog kiest is de organisatie.
 */

export function McpConsent({ request, organizations, defaultOrganizationId }: {
  request: string;
  organizations: Array<{ id: UUID; name: string }>;
  defaultOrganizationId: UUID | null;
}) {
  const [info, setInfo] = useState<McpConsentRequest | null>(null);
  const [organizationId, setOrganizationId] = useState<UUID | null>(defaultOrganizationId);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadConsentRequest(request)
      .then(result => {
        if (cancelled) return;
        setInfo(result);
        setLabel(result.clientName);
      })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Dit koppelverzoek is niet geldig.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request]);

  const organizationName = useMemo(
    () => organizations.find(o => o.id === organizationId)?.name ?? '',
    [organizations, organizationId],
  );

  async function decide(decision: 'allow' | 'deny') {
    if (decision === 'allow' && !organizationId) { setError('Kies eerst een organisatie.'); return; }
    setBusy(decision);
    setError(null);
    try {
      const redirect = await decideConsent(request, decision, (organizationId ?? '') as UUID, label.trim() || info?.clientName || 'AI-koppeling');
      // Terug naar de AI-client. Geen router: dit is een adres buiten onze app.
      window.location.href = redirect;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Er ging iets mis. Probeer het opnieuw vanuit je AI-app.');
      setBusy(null);
    }
  }

  if (loading) {
    return <main className="login"><div className="login-card"><p>Koppelverzoek controleren…</p></div></main>;
  }

  if (!info) {
    return (
      <main className="login">
        <div className="login-card">
          <div className="app-brand"><div className="brand-icon">R</div><span>ResoFly</span></div>
          <h1>Koppelen lukt niet</h1>
          <p className="error">{error ?? 'Dit koppelverzoek is niet geldig.'}</p>
          <p>Begin opnieuw vanuit je AI-app. Een koppelverzoek is een kwartier geldig; daarna moet je het opnieuw starten.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="login">
      <div className="login-card mcp-consent">
        <div className="app-brand"><div className="brand-icon">R</div><span>ResoFly</span></div>

        <h1>{info.clientName} koppelen?</h1>
        <p>
          {info.clientName} vraagt toegang tot je ResoFly-werkruimte. Daarna kun je die AI vragen stellen over je eigen
          klanten, projecten, uren en administratie.
        </p>

        <ul className="mcp-consent-list">
          <li>
            <span className="mcp-consent-icon" aria-hidden="true">👁</span>
            <span>
              <strong>Mag meelezen</strong>
              <small>Alles wat jij zelf in {organizationName || 'deze organisatie'} mag inzien — niet meer. Onderdelen die voor jou dichtstaan, blijven dicht.</small>
            </span>
          </li>
          <li>
            <span className="mcp-consent-icon" aria-hidden="true">🔒</span>
            <span>
              <strong>Kan niets wijzigen</strong>
              <small>Geen facturen versturen, niets aanmaken, niets verwijderen. Deze koppeling kan uitsluitend lezen.</small>
            </span>
          </li>
          <li>
            <span className="mcp-consent-icon" aria-hidden="true">↩</span>
            <span>
              <strong>Altijd in te trekken</strong>
              <small>Via Instellingen → AI-koppelingen. Intrekken werkt meteen.</small>
            </span>
          </li>
        </ul>

        {organizations.length > 1 && (
          <label className="mcp-consent-field">
            <span>Welke organisatie?</span>
            <Select value={organizationId ?? ''} onChange={e => setOrganizationId((e.target.value || null) as UUID | null)}>
              {organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}
            </Select>
          </label>
        )}

        <label className="mcp-consent-field">
          <span>Naam van deze koppeling</span>
          <Input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Claude op mijn laptop"
            maxLength={120}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <div className="mcp-consent-actions">
          <Button variant="ghost" onClick={() => void decide('deny')} disabled={busy !== null}>
            {busy === 'deny' ? 'Bezig…' : 'Weigeren'}
          </Button>
          <Button variant="primary" onClick={() => void decide('allow')} disabled={busy !== null || !organizationId}>
            {busy === 'allow' ? 'Koppelen…' : 'Koppelen'}
          </Button>
        </div>

        <p className="mcp-consent-fineprint">
          Let op: wat je hier goedkeurt, gaat naar de AI-dienst die je koppelt. Gegevens die je opvraagt worden daar
          verwerkt volgens de voorwaarden van die dienst — niet die van ResoFly.
        </p>
      </div>
    </main>
  );
}
