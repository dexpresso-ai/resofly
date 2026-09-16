import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from './Ui';
import { grantMayPropose, listGrants, McpNotAvailableError, revokeGrant, type McpGrant } from '../lib/mcp-api';
import type { OrganizationMember, UUID } from '../types';

/**
 * "AI-koppelingen" in Instellingen: welke externe AI's mogen in deze organisatie
 * meelezen of klaarzetten, en de knop om dat te stoppen.
 *
 * Twee lijsten, met een verschillende reden om te bestaan:
 *
 *   MIJN KOPPELINGEN — wat ik zelf gekoppeld heb. Ieder teamlid ziet dit; je
 *     koppelt persoonlijk, met je eigen rechten, dus je hoort ook zelf te
 *     kunnen loskoppelen.
 *
 *   KOPPELINGEN VAN HET TEAM — alleen voor owners en admins. Een medewerker die
 *     zijn ChatGPT aan de bedrijfsadministratie hangt is iets wat een owner
 *     hoort te weten, en hoort te kunnen stoppen zonder eerst die medewerker te
 *     hoeven vinden. Zeker als die net uit dienst is. Welke rijen iemand te
 *     zien krijgt beslist RLS; dit scherm splitst alleen op `user_id`.
 *
 * Eén ding is hier belangrijker dan mooi: de intrek-knop moet het altijd doen.
 * Daarom loopt hij niet langs een edge function maar rechtstreeks langs RLS —
 * een update op `revoked_at`, en de database trekt de tokens mee in en
 * annuleert wat er nog klaarstond. Zo werkt "stop hiermee" ook als er verderop
 * iets stuk is.
 */

export function McpConnections({ organizationId, currentUserId, canAdmin, teamMembers, connectUrl }: {
  organizationId: UUID;
  currentUserId: UUID | null;
  /** Owner of admin: ziet en stopt ook de koppelingen van collega's. */
  canAdmin: boolean;
  /** Om bij een koppeling van een collega te kunnen zeggen wie het is. */
  teamMembers: OrganizationMember[];
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

  const mine = useMemo(() => (grants ?? []).filter(g => g.user_id === currentUserId), [grants, currentUserId]);
  // Wat RLS náást de eigen rijen teruggeeft, kan alleen van collega's zijn — en
  // alleen een owner/admin krijgt die. Voor een gewoon teamlid is dit dus leeg.
  const team = useMemo(() => (grants ?? []).filter(g => g.user_id !== currentUserId), [grants, currentUserId]);
  const emailByUser = useMemo(() => new Map(teamMembers.map(m => [m.user_id, m.email || null])), [teamMembers]);

  async function revoke(grant: McpGrant, ofColleague: boolean) {
    const who = ofColleague ? (emailByUser.get(grant.user_id) ?? 'een collega') : null;
    const question = ofColleague
      ? `De koppeling "${grant.label}" van ${who} stoppen? Die AI kan daarna niets meer opvragen of klaarzetten in deze werkruimte. ${who} krijgt hier geen bericht van.`
      : `"${grant.label}" loskoppelen? Die AI kan daarna niets meer opvragen of klaarzetten in deze werkruimte.`;
    if (!confirm(question)) return;
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
        dan <strong>meelezen</strong> met alles wat jij zelf mag inzien, en desgewenst wijzigingen <strong>klaarzetten</strong>
        in je goedkeurwachtrij. Zelf uitvoeren kan hij nooit: dat blijft een klik van jou.
        {connectUrl && <> <a href={connectUrl} target="_blank" rel="noreferrer">Zo koppel je hem →</a></>}
      </p>

      {error && <p className="error">{error}</p>}

      {unavailable && (
        <p className="mcp-connections-empty">
          Nog niet beschikbaar in deze omgeving — de koppeling wordt binnenkort aangezet.
        </p>
      )}

      {grants === null && !unavailable && <p className="mcp-connections-empty">Laden…</p>}

      {grants !== null && !unavailable && (
        <>
          {canAdmin && <h4 className="mcp-connections-heading">Mijn koppelingen</h4>}

          {mine.length === 0 && (
            <p className="mcp-connections-empty">
              Je hebt nog geen AI gekoppeld. Voeg ResoFly in je AI-app toe als connector; het koppelen begint daar.
            </p>
          )}

          {mine.length > 0 && (
            <ul className="mcp-connections-list">
              {mine.map(grant => <GrantRow key={grant.id} grant={grant} busy={busyId === grant.id} onRevoke={() => void revoke(grant, false)} />)}
            </ul>
          )}

          {canAdmin && (
            <>
              <h4 className="mcp-connections-heading">Koppelingen van het team</h4>
              <p className="mcp-connections-hint">
                Alles wat collega's aan deze organisatie hebben gekoppeld. Als owner of admin kun je elke koppeling
                stoppen — bijvoorbeeld als iemand uit dienst gaat.
              </p>
              {team.length === 0 && <p className="mcp-connections-empty">Geen collega heeft op dit moment een AI gekoppeld.</p>}
              {team.length > 0 && (
                <ul className="mcp-connections-list">
                  {team.map(grant => (
                    <GrantRow
                      key={grant.id}
                      grant={grant}
                      owner={emailByUser.get(grant.user_id) ?? 'onbekend teamlid'}
                      busy={busyId === grant.id}
                      onRevoke={() => void revoke(grant, true)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function GrantRow({ grant, owner, busy, onRevoke }: { grant: McpGrant; owner?: string; busy: boolean; onRevoke: () => void }) {
  return (
    <li>
      <div className="mcp-connection-info">
        <strong>{grant.label || grant.client_id}</strong>
        <small>
          {owner && <>{owner}{' · '}</>}
          Gekoppeld op {formatDate(grant.created_at)}
          {' · '}
          {grant.last_used_at ? `laatst gebruikt ${formatDate(grant.last_used_at)}` : 'nog niet gebruikt'}
        </small>
      </div>
      <span className={`mcp-connection-scope${grantMayPropose(grant) ? ' is-propose' : ''}`}>
        {grantMayPropose(grant) ? 'Leest mee · zet klaar' : 'Leest alleen mee'}
      </span>
      <Button variant="danger" onClick={onRevoke} disabled={busy}>
        {busy ? 'Bezig…' : owner ? 'Stoppen' : 'Loskoppelen'}
      </Button>
    </li>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}
