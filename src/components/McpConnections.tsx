import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Select } from './Ui';
import {
  buildScope, grantCanEnable, grantChosePropose, grantMayExecute, grantMayExecuteHigh, grantMayPropose, listGrants,
  MCP_SERVER_URL, McpNotAvailableError, revokeGrant, setGrantScope, type McpGrant,
} from '../lib/mcp-api';
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
 * DE SCHAKELAARS staan alleen bij je EIGEN koppelingen, en dat is met opzet.
 * Een owner ziet de koppelingen van zijn team en kan ze stoppen — dat is
 * toezicht. Maar iemand anders méér laten doen met zijn AI is geen toezicht;
 * dat is namens hem een keuze maken die zíjn rechten gebruikt. Stoppen kan
 * altijd, verruimen alleen zelf — en de database zegt hetzelfde nog een keer.
 *
 * Eén ding is hier belangrijker dan mooi: de intrek-knop moet het altijd doen.
 * Daarom loopt hij niet langs een edge function maar rechtstreeks langs RLS —
 * een update op `revoked_at`, en de database trekt de tokens mee in en
 * annuleert wat er nog klaarstond. Zo werkt "stop hiermee" ook als er verderop
 * iets stuk is.
 */

type ConnectApp = 'claude' | 'claude-code' | 'chatgpt';

const CONNECT_APPS: { id: ConnectApp; label: string }[] = [
  { id: 'claude', label: 'Claude (web, desktop, telefoon)' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'chatgpt', label: 'ChatGPT' },
];

const CLAUDE_CODE_COMMAND = `claude mcp add --transport http resofly ${MCP_SERVER_URL}`;

/**
 * De stappen tot aan het toestemmingsscherm, per AI-app. Menunamen in het
 * Engels omdat de apps ze zo tonen. Die namen veranderen af en toe, dus niet
 * meer stappen dan nodig om het adres op de goede plek te krijgen: vanaf het
 * toestemmingsscherm is het weer ons scherm.
 */
const CONNECT_STEPS: Record<ConnectApp, ReactNode[]> = {
  claude: [
    <>Ga in Claude naar <strong>Customize → Connectors</strong> en kies <strong>+ → Add custom connector</strong>.</>,
    <>Plak het adres hierboven en klik op <strong>Add</strong>. Vraagt Claude hoe hij zich aanmeldt, laat dan staan wat hij zelf vond.</>,
    <>Klik op <strong>Connect</strong>. Je komt in ResoFly: log in, kies de organisatie en geef akkoord.</>,
    <>Zet ResoFly in een gesprek aan via <strong>+ → Connectors</strong> en vraag bijvoorbeeld welke facturen er openstaan.</>,
  ],
  'claude-code': [
    <>Voer de opdracht hierboven uit in je terminal.</>,
    <>Start Claude Code, typ <strong>/mcp</strong>, kies <strong>resofly</strong> en daarna <strong>Authenticate</strong>.</>,
    <>Je browser opent ResoFly: log in, kies de organisatie en geef akkoord.</>,
  ],
  chatgpt: [
    <>Zet in de instellingen van ChatGPT de <strong>Developer mode</strong> aan. Dat kan op het web met Plus, Pro, Business, Enterprise of Education; bij een zakelijk account zet een beheerder hem eerst aan.</>,
    <>Maak een nieuwe app aan met het adres hierboven en kies <strong>OAuth</strong> als aanmelding.</>,
    <>ChatGPT stuurt je naar ResoFly: log in, kies de organisatie en geef akkoord.</>,
    <>Kies in een gesprek via <strong>+</strong> de Developer mode en zet ResoFly aan.</>,
  ],
};

export function McpConnections({ organizationId, currentUserId, canAdmin, teamMembers }: {
  organizationId: UUID;
  currentUserId: UUID | null;
  /** Owner of admin: ziet en stopt ook de koppelingen van collega's. */
  canAdmin: boolean;
  /** Om bij een koppeling van een collega te kunnen zeggen wie het is. */
  teamMembers: OrganizationMember[];
}) {
  const [grants, setGrants] = useState<McpGrant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [app, setApp] = useState<ConnectApp>('claude');
  const [copied, setCopied] = useState<'url' | 'command' | null>(null);
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

  async function copy(value: string, what: 'url' | 'command') {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(current => (current === what ? null : current)), 2000);
    } catch {
      setError('Kopiëren lukte niet. Selecteer de tekst en kopieer hem handmatig.');
    }
  }

  /**
   * De twee schakelaars onder een eigen koppeling.
   *
   * Het aanzetten van iets krijgt een vraag vooraf, het uitzetten niet: minder
   * mogen is nooit de verrassing waar iemand spijt van krijgt. Bij de
   * onomkeerbare handelingen staat er wél precies wat dat betekent — "post naar
   * je klanten" is concreter dan "onomkeerbaar", en het is wat er misgaat.
   */
  async function changeScope(grant: McpGrant, change: { execute?: boolean; executeHigh?: boolean }) {
    const execute = change.execute ?? grantMayExecute(grant);
    const executeHigh = execute && (change.executeHigh ?? grantMayExecuteHigh(grant));

    if (change.execute === true && !grantMayExecute(grant) && !confirm(
      `"${grant.label}" mag daarna wijzigingen meteen doorvoeren in deze werkruimte, zonder dat jij ze eerst goedkeurt. `
      + 'Het blijft binnen jouw eigen rechten, en je krijgt er een melding van. Doorgaan?')) return;

    if (change.executeHigh === true && !grantMayExecuteHigh(grant) && !confirm(
      `"${grant.label}" mag daarna ook onomkeerbare handelingen zelf uitvoeren: post naar je klanten, aangiftes, `
      + 'publieke links. Die kun je niet terugdraaien en je krijgt ze niet eerst te zien. Zeker weten?')) return;

    setBusyId(grant.id);
    try {
      await setGrantScope(grant.id, buildScope({ propose: grantChosePropose(grant), execute, executeHigh }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Het wijzigen van deze koppeling is niet gelukt.');
    } finally {
      setBusyId(null);
    }
  }

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
        dan <strong>meelezen</strong> met alles wat jij zelf mag inzien, en wijzigingen <strong>klaarzetten</strong> in
        je goedkeurwachtrij. Wil je niet elke keer zelf op Uitvoeren klikken, dan zet je per koppeling hieronder{' '}
        <strong>rechtstreeks uitvoeren</strong> aan. Wat die AI mag blijft hoe dan ook binnen jouw eigen rechten.
      </p>

      {error && <p className="error">{error}</p>}

      {unavailable && (
        <p className="mcp-connections-empty">
          Nog niet beschikbaar in deze omgeving — de koppeling wordt binnenkort aangezet.
        </p>
      )}

      {!unavailable && (
        <>
          <h4 className="mcp-connections-heading">Koppelen</h4>
          <div className="dns-record">
            <div className="dns-record-field grow">
              <span className="dns-record-label">Adres van de connector</span>
              <code className="dns-record-value">{MCP_SERVER_URL}</code>
            </div>
            <Button onClick={() => void copy(MCP_SERVER_URL, 'url')}>{copied === 'url' ? 'Gekopieerd' : 'Kopieer'}</Button>
          </div>

          <div className="settings-grid compact">
            <label>Welke AI gebruik je?
              <Select value={app} onChange={e => setApp(e.target.value as ConnectApp)}>
                {CONNECT_APPS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </Select>
            </label>
          </div>

          {app === 'claude-code' && (
            <div className="dns-record">
              <div className="dns-record-field grow">
                <span className="dns-record-label">Opdracht voor je terminal</span>
                <code className="dns-record-value">{CLAUDE_CODE_COMMAND}</code>
              </div>
              <Button onClick={() => void copy(CLAUDE_CODE_COMMAND, 'command')}>{copied === 'command' ? 'Gekopieerd' : 'Kopieer'}</Button>
            </div>
          )}

          <ol className="inbound-steps">
            {CONNECT_STEPS[app].map((step, index) => <li key={index}>{step}</li>)}
          </ol>

          {app === 'claude' && (
            <p className="mcp-connections-hint">
              Werk je met Claude Team of Enterprise? Dan zet een owner van dat Claude-account het adres eerst klaar
              onder <strong>Organization settings → Connectors</strong>; daarna klik jij op Connect.
            </p>
          )}
        </>
      )}

      {grants === null && !unavailable && <p className="mcp-connections-empty">Laden…</p>}

      {grants !== null && !unavailable && (
        <>
          <h4 className="mcp-connections-heading">Mijn koppelingen</h4>

          {mine.length === 0 && (
            <p className="mcp-connections-empty">
              Je hebt nog geen AI gekoppeld. Na het akkoord in ResoFly staat hij hier.
            </p>
          )}

          {mine.length > 0 && (
            <ul className="mcp-connections-list">
              {mine.map(grant => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  busy={busyId === grant.id}
                  onRevoke={() => void revoke(grant, false)}
                  onScope={change => void changeScope(grant, change)}
                />
              ))}
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

function GrantRow({ grant, owner, busy, onRevoke, onScope }: {
  grant: McpGrant;
  owner?: string;
  busy: boolean;
  onRevoke: () => void;
  /** Alleen bij je eigen koppelingen; bij die van een collega ontbreekt hij. */
  onScope?: (change: { execute?: boolean; executeHigh?: boolean }) => void;
}) {
  const executes = grantMayExecute(grant);
  return (
    <li>
      <div className="mcp-connection-main">
        <div className="mcp-connection-info">
          <strong>{grant.label || grant.client_id}</strong>
          <small>
            {owner && <>{owner}{' · '}</>}
            Gekoppeld op {formatDate(grant.created_at)}
            {' · '}
            {grant.last_used_at ? `laatst gebruikt ${formatDate(grant.last_used_at)}` : 'nog niet gebruikt'}
          </small>
        </div>
        <span className={`mcp-connection-scope${scopeTone(grant)}`}>{scopeLabel(grant)}</span>
        <Button variant="danger" onClick={onRevoke} disabled={busy}>
          {busy ? 'Bezig…' : owner ? 'Stoppen' : 'Loskoppelen'}
        </Button>
      </div>

      {onScope && grantCanEnable(grant, 'execute') && (
        <div className="mcp-connection-switches">
          <label className="mcp-connection-switch">
            <input
              type="checkbox"
              checked={executes}
              disabled={busy}
              onChange={e => onScope({ execute: e.target.checked })}
            />
            <span>
              <strong>Mag rechtstreeks uitvoeren</strong>
              <small>
                Wijzigingen gebeuren meteen, zonder dat jij ze eerst goedkeurt. Wat ResoFly niet rechtstreeks kan,
                komt alsnog in je goedkeurwachtrij — je AI hoort je dat dan ook zo te vertellen.
              </small>
            </span>
          </label>

          {grantCanEnable(grant, 'execute_high') && (
            <label className={`mcp-connection-switch is-risky${executes ? '' : ' is-off'}`}>
              <input
                type="checkbox"
                checked={grantMayExecuteHigh(grant)}
                disabled={busy || !executes}
                onChange={e => onScope({ executeHigh: e.target.checked })}
              />
              <span>
                <strong>Ook onomkeerbare handelingen</strong>
                <small>
                  Post naar je klanten, aangiftes, boekingen, publieke links. Laat dit uit staan als je die liever
                  zelf nog ziet voordat ze de deur uit gaan.
                </small>
              </span>
            </label>
          )}
        </div>
      )}
    </li>
  );
}

/** Wat deze koppeling mag, in twee woorden op de badge. */
function scopeLabel(grant: McpGrant): string {
  if (grantMayExecuteHigh(grant)) return 'Leest mee · voert alles uit';
  if (grantMayExecute(grant)) return 'Leest mee · voert uit';
  if (grantMayPropose(grant)) return 'Leest mee · zet klaar';
  return 'Leest alleen mee';
}

/** Hoe zwaarder de koppeling mag ingrijpen, hoe meer de badge opvalt. */
function scopeTone(grant: McpGrant): string {
  if (grantMayExecute(grant)) return ' is-execute';
  if (grantMayPropose(grant)) return ' is-propose';
  return '';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}
