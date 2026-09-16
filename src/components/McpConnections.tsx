import { useCallback, useEffect, useState } from 'react';
import { Button } from './Ui';
import { listGrants, McpNotAvailableError, revokeGrant, type McpGrant } from '../lib/mcp-api';
import type { UUID } from '../types';

/**
 * "AI-koppelingen" in Instellingen: welke externe AI's mogen in deze organisatie
 * meelezen, en de knop om dat te stoppen.
 *
 * Eén ding is hier belangrijker dan mooi: de intrek-knop moet het altijd doen.
 * Daarom loopt hij niet langs een edge function maar rechtstreeks langs RLS —
 * een gebruiker mag `revoked_at` zetten op zijn eigen rij, en de database trekt
 * de tokens meteen mee in. Zo werkt "stop hiermee" ook als er verderop iets
 * stuk is.
 *
 * De lijst toont alleen de koppelingen van de ingelogde gebruiker: koppelen doe
 * je persoonlijk, met je eigen rechten, dus die van een collega gaan je niet aan
 * (en RLS geeft ze ook niet).
 */

export function McpConnections({ organizationId, connectUrl }: {
  organizationId: UUID;
  /** Waar de gebruiker leest hoe hij koppelt. Leeg = geen link tonen. */
  connectUrl?: string;
}) {
  const [grants, setGrants] = useState<McpGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // De database is nog niet bijgewerkt in deze omgeving. Geen fout, wel een
  // reden om het paneel stil te houden in plaats van rood te kleuren.
  const [unavailable, setUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setGrants(await listGrants(organizationId));
      setError(null);
      setUnavailable(false);
    } catch (err) {
      if (err instanceof McpNotAvailableError) { setUnavailable(true); setGrants([]); setError(null); return; }
      setError(err instanceof Error ? err.message : 'De AI-koppelingen konden niet worden opgehaald.');
    }
  }, [organizationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function revoke(grant: McpGrant) {
    if (!confirm(`"${grant.label}" loskoppelen? Die AI kan daarna niets meer opvragen uit deze werkruimte.`)) return;
    setBusyId(grant.id);
    try {
      await revokeGrant(grant.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Intrekken is niet gelukt.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="settings-card mcp-connections">
      <h3>AI-koppelingen</h3>
      <p className="mcp-connections-intro">
        Koppel je eigen AI — Claude, ChatGPT of een andere assistent die MCP spreekt — aan deze werkruimte. Die AI kan
        dan <strong>meelezen</strong> met alles wat jij zelf mag inzien. Wijzigen, versturen of verwijderen kan hij niet.
        {connectUrl && <> <a href={connectUrl} target="_blank" rel="noreferrer">Zo koppel je hem →</a></>}
      </p>

      {error && <p className="error">{error}</p>}

      {unavailable && (
        <p className="mcp-connections-empty">
          Nog niet beschikbaar in deze omgeving — de koppeling wordt binnenkort aangezet.
        </p>
      )}

      {grants === null && !unavailable && <p className="mcp-connections-empty">Laden…</p>}

      {grants !== null && !unavailable && grants.length === 0 && (
        <p className="mcp-connections-empty">
          Je hebt nog geen AI gekoppeld. Voeg ResoFly in je AI-app toe als connector; het koppelen begint daar.
        </p>
      )}

      {grants !== null && !unavailable && grants.length > 0 && (
        <ul className="mcp-connections-list">
          {grants.map(grant => (
            <li key={grant.id}>
              <div className="mcp-connection-info">
                <strong>{grant.label || grant.client_id}</strong>
                <small>
                  Gekoppeld op {formatDate(grant.created_at)}
                  {' · '}
                  {grant.last_used_at ? `laatst gebruikt ${formatDate(grant.last_used_at)}` : 'nog niet gebruikt'}
                  {' · '}
                  alleen lezen
                </small>
              </div>
              <Button variant="danger" onClick={() => void revoke(grant)} disabled={busyId === grant.id}>
                {busyId === grant.id ? 'Bezig…' : 'Loskoppelen'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}
