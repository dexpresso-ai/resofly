import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Input, Select } from './Ui';
import {
  accessLevelOf, API_ACCESS_LABEL, API_ACCESS_LEVELS, API_BASE_URL, API_OPENAPI_URL, createApiKey, listApiKeys,
  listApiRequests, PublicApiNotAvailableError, revokeApiKey,
  type ApiAccessLevel, type ApiKey, type ApiRequestLogEntry,
} from '../lib/public-api';
import { WebhookEndpoints } from './WebhookEndpoints';
import type { OrganizationMember, UUID } from '../types';

/**
 * "API-sleutels" in Instellingen → API & webhooks: andere software koppelen aan
 * deze werkruimte.
 *
 * Een sleutel is van de ORGANISATIE en niet van één persoon: owners en admins
 * zien ze allemaal en kunnen elke sleutel intrekken — ook die van een collega
 * die uit dienst ging. Hij werkt wel namens het teamlid dat hem aanmaakte, met
 * diens rechten; dat staat er daarom bij.
 *
 * WAT EEN SLEUTEL MAG kies je bij het aanmaken, en daarna niet meer ruimer. Een
 * sleutel die al in een webshop staat, hoort niet ineens meer te kunnen omdat
 * iemand hier een knop omzet; wie meer wil, maakt een nieuwe en trekt de oude in.
 * De database zegt hetzelfde nog een keer (api_keys_guard_client_update).
 *
 * De intrek-knop loopt rechtstreeks langs RLS en niet langs een edge function,
 * net als bij de AI-koppelingen: "stop hiermee" moet het ook doen als er
 * verderop iets stuk is.
 */

const MODULES: Array<{ key: string; label: string }> = [
  { key: 'clients', label: 'Klanten' },
  { key: 'projects', label: 'Projecten' },
  { key: 'time', label: 'Uren' },
  { key: 'calendar', label: 'Agenda' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'content', label: 'Inhoud' },
  { key: 'stats', label: 'Statistieken' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'finance', label: 'Financiën' },
  { key: 'chat', label: 'Teamchat' },
  { key: 'gerrie', label: 'Gerrie' },
];

const EXPIRY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Verloopt niet' },
  { value: '30', label: 'Over 30 dagen' },
  { value: '90', label: 'Over 90 dagen' },
  { value: '365', label: 'Over een jaar' },
];

type ModuleChoice = 'write' | 'read' | 'none';

export function ApiIntegrations({ organizationId, canAdmin, teamMembers }: {
  organizationId: UUID;
  canAdmin: boolean;
  /** Om bij een sleutel te kunnen zeggen namens wie hij werkt. */
  teamMembers: OrganizationMember[];
}) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [requests, setRequests] = useState<ApiRequestLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Het formulier voor een nieuwe sleutel.
  const [name, setName] = useState('');
  const [access, setAccess] = useState<ApiAccessLevel>('read');
  const [expiry, setExpiry] = useState('');
  const [restrict, setRestrict] = useState(false);
  const [modules, setModules] = useState<Record<string, ModuleChoice>>({});
  const [creating, setCreating] = useState(false);
  // De platte sleutel van de net aangemaakte. Bestaat alleen in dit scherm, tot
  // de gebruiker op "Ik heb hem bewaard" klikt.
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);
  const [showLog, setShowLog] = useState(false);

  const refresh = useCallback(async () => {
    if (!canAdmin) return;
    try {
      setKeys(await listApiKeys(organizationId));
      setError(null);
      setUnavailable(false);
    } catch (err) {
      if (err instanceof PublicApiNotAvailableError) { setUnavailable(true); setKeys([]); setError(null); return; }
      setError(err instanceof Error ? err.message : 'De API-sleutels konden niet worden opgehaald.');
    }
  }, [organizationId, canAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);

  const loadLog = useCallback(async () => {
    try {
      setRequests(await listApiRequests(organizationId, 50));
    } catch (err) {
      if (err instanceof PublicApiNotAvailableError) { setRequests([]); return; }
      setError(err instanceof Error ? err.message : 'Het verzoeklog kon niet worden opgehaald.');
    }
  }, [organizationId]);

  useEffect(() => { if (showLog) void loadLog(); }, [showLog, loadLog]);

  const emailByUser = useMemo(() => new Map(teamMembers.map(m => [m.user_id, m.email || null])), [teamMembers]);
  const nameByKey = useMemo(() => new Map((keys ?? []).map(k => [k.id, k.name])), [keys]);

  async function copy(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      window.setTimeout(() => setCopied(current => (current === what ? null : current)), 2000);
    } catch {
      setError('Kopiëren lukte niet. Selecteer de tekst en kopieer hem handmatig.');
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError('Geef de sleutel een naam, bijvoorbeeld "Webshop".'); return; }
    // Bij de ruimste trede een vraag vooraf: daar gaat post naar klanten zonder
    // dat iemand het eerst ziet, en dat hoort een bewuste keuze te zijn.
    if (access === 'execute_high' && !confirm(
      'Deze sleutel mag daarna ook onomkeerbare handelingen zelf uitvoeren: post naar je klanten, boekingen, aangiftes, '
      + 'publieke links. Die kun je niet terugdraaien en je krijgt ze niet eerst te zien. Zeker weten?')) return;

    const moduleAccess: Record<string, 'none' | 'read'> = {};
    if (restrict) {
      for (const [module, choice] of Object.entries(modules)) {
        if (choice === 'none' || choice === 'read') moduleAccess[module] = choice;
      }
    }

    setCreating(true);
    try {
      const created = await createApiKey(organizationId, {
        name: name.trim(),
        access,
        moduleAccess,
        expiresInDays: expiry ? Number(expiry) : null,
      });
      setFresh({ name: created.key.name, secret: created.secret });
      setName(''); setAccess('read'); setExpiry(''); setRestrict(false); setModules({});
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'De API-sleutel kon niet worden aangemaakt.');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`De sleutel "${key.name}" intrekken? Software die hem gebruikt, krijgt daarna meteen geen toegang meer, en wat hij nog in de goedkeurwachtrij had staan wordt geannuleerd. Dit kun je niet terugdraaien.`)) return;
    setBusyId(key.id);
    try {
      await revokeApiKey(key.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Intrekken is niet gelukt.');
    } finally {
      setBusyId(null);
    }
  }

  if (!canAdmin) {
    return (
      <div className="settings-card api-integrations">
        <h3>API-sleutels</h3>
        <p className="settings-help">Alleen owners en admins kunnen API-sleutels aanmaken en beheren.</p>
      </div>
    );
  }

  return (
    <>
    <div className="settings-card api-integrations">
      <h3>API-sleutels</h3>
      <p className="mcp-connections-intro">
        Koppel andere software aan deze werkruimte — een webshop, een urenapp, je boekhouding, of een koppelplatform
        als <strong>Zapier</strong>, <strong>Make</strong> of <strong>n8n</strong>. Via de API kan zo'n koppeling alles
        wat de app kan: gegevens ophalen, en wijzigingen <strong>klaarzetten</strong> in je goedkeurwachtrij of — als je
        dat bij de sleutel toestaat — <strong>rechtstreeks uitvoeren</strong>. Een sleutel werkt namens jou, met jouw
        rechten, en nooit ruimer.
      </p>

      {error && <p className="error">{error}</p>}

      {unavailable && (
        <p className="mcp-connections-empty">Nog niet beschikbaar in deze omgeving — de API wordt binnenkort aangezet.</p>
      )}

      {!unavailable && (
        <>
          <h4 className="mcp-connections-heading">Adres</h4>
          <div className="dns-record">
            <div className="dns-record-field grow">
              <span className="dns-record-label">Adres van de API</span>
              <code className="dns-record-value">{API_BASE_URL}</code>
            </div>
            <Button onClick={() => void copy(API_BASE_URL, 'base')}>{copied === 'base' ? 'Gekopieerd' : 'Kopieer'}</Button>
          </div>
          <div className="dns-record">
            <div className="dns-record-field grow">
              <span className="dns-record-label">Beschrijving voor ontwikkelaars (OpenAPI)</span>
              <code className="dns-record-value">{API_OPENAPI_URL}</code>
            </div>
            <Button onClick={() => void copy(API_OPENAPI_URL, 'openapi')}>{copied === 'openapi' ? 'Gekopieerd' : 'Kopieer'}</Button>
          </div>
          <p className="mcp-connections-hint">
            Stuur de sleutel mee als <code>Authorization: Bearer rsfapi.…</code>. Begin met <code>GET /v1/me</code> om te zien
            wat een sleutel mag, en <code>GET /v1/actions</code> voor alles wat hij kan aanroepen.
          </p>

          {fresh && (
            <div className="success api-key-fresh">
              <strong>Sleutel "{fresh.name}" is aangemaakt — kopieer hem nu, je ziet hem maar één keer.</strong>
              <div className="dns-record">
                <div className="dns-record-field grow">
                  <span className="dns-record-label">API-sleutel</span>
                  <code className="dns-record-value">{fresh.secret}</code>
                </div>
                <Button onClick={() => void copy(fresh.secret, 'secret')}>{copied === 'secret' ? 'Gekopieerd' : 'Kopieer'}</Button>
              </div>
              <p className="mcp-connections-hint">
                Bewaar hem waar ook je andere wachtwoorden staan. Kwijt? Trek hem in en maak een nieuwe aan.
              </p>
              <div><Button onClick={() => setFresh(null)}>Ik heb hem bewaard</Button></div>
            </div>
          )}

          <h4 className="mcp-connections-heading">Nieuwe sleutel</h4>
          <form className="api-key-form" onSubmit={create}>
            <div className="settings-grid compact">
              <label>Naam
                <Input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Bijvoorbeeld: Webshop, Toggl, Zapier" />
              </label>
              <label>Vervalt
                <Select value={expiry} onChange={e => setExpiry(e.target.value)}>
                  {EXPIRY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              </label>
            </div>

            <fieldset className="api-key-access">
              <legend>Wat mag deze sleutel?</legend>
              {API_ACCESS_LEVELS.map(level => (
                <label key={level} className={`mcp-connection-switch${level === 'execute_high' ? ' is-risky' : ''}`}>
                  <input type="radio" name="api-access" value={level} checked={access === level} onChange={() => setAccess(level)} />
                  <span>
                    <strong>{API_ACCESS_LABEL[level].label}</strong>
                    <small>{API_ACCESS_LABEL[level].help}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            <label className="mcp-connection-switch">
              <input type="checkbox" checked={restrict} onChange={e => setRestrict(e.target.checked)} />
              <span>
                <strong>Alleen bepaalde onderdelen</strong>
                <small>Knijp de sleutel af tot wat de koppeling nodig heeft — een webshop hoeft niet in je boekhouding te kijken.</small>
              </span>
            </label>

            {restrict && (
              <div className="api-key-modules">
                {MODULES.map(module => (
                  <label key={module.key}>{module.label}
                    <Select
                      value={modules[module.key] ?? 'write'}
                      onChange={e => setModules(current => ({ ...current, [module.key]: e.target.value as ModuleChoice }))}
                    >
                      <option value="write">Zoals mijn eigen rechten</option>
                      <option value="read">Alleen lezen</option>
                      <option value="none">Geen toegang</option>
                    </Select>
                  </label>
                ))}
              </div>
            )}

            <div><Button variant="primary" disabled={creating || !name.trim()}>{creating ? 'Bezig…' : 'Sleutel aanmaken'}</Button></div>
          </form>

          <h4 className="mcp-connections-heading">Actieve sleutels</h4>
          {keys === null && <p className="mcp-connections-empty">Laden…</p>}
          {keys !== null && keys.length === 0 && (
            <p className="mcp-connections-empty">Er zijn nog geen sleutels. Maak er hierboven een aan voor je eerste koppeling.</p>
          )}
          {keys !== null && keys.length > 0 && (
            <ul className="mcp-connections-list">
              {keys.map(key => (
                <KeyRow
                  key={key.id}
                  apiKey={key}
                  owner={emailByUser.get(key.user_id) ?? 'onbekend teamlid'}
                  busy={busyId === key.id}
                  onRevoke={() => void revoke(key)}
                />
              ))}
            </ul>
          )}

          <h4 className="mcp-connections-heading">Recente aanroepen</h4>
          {!showLog && (
            <p className="mcp-connections-hint">
              Elke aanroep met een geldige sleutel wordt 30 dagen bewaard: wanneer, welk adres of welke handeling, en de uitkomst.{' '}
              <button type="button" className="api-link-button" onClick={() => setShowLog(true)}>Toon de laatste 50</button>
            </p>
          )}
          {showLog && (
            <div className="api-request-log">
              {requests === null && <p className="mcp-connections-empty">Laden…</p>}
              {requests !== null && requests.length === 0 && <p className="mcp-connections-empty">Nog geen aanroepen.</p>}
              {requests !== null && requests.length > 0 && (
                <table>
                  <thead>
                    <tr><th>Wanneer</th><th>Sleutel</th><th>Aanroep</th><th>Uitkomst</th></tr>
                  </thead>
                  <tbody>
                    {requests.map(entry => (
                      <tr key={entry.id} className={entry.status >= 400 ? 'is-error' : ''}>
                        <td>{formatDateTime(entry.created_at)}</td>
                        <td>{(entry.api_key_id && nameByKey.get(entry.api_key_id)) || 'ingetrokken sleutel'}</td>
                        <td><code>{entry.method} {entry.path}</code></td>
                        <td>{entry.status}{entry.error_code ? ` · ${entry.error_code}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="api-request-log-actions">
                <Button onClick={() => void loadLog()}>Vernieuwen</Button>
                <Button variant="ghost" onClick={() => setShowLog(false)}>Verbergen</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
    <WebhookEndpoints organizationId={organizationId} canAdmin={canAdmin} apiKeys={keys} />
    </>
  );
}

function KeyRow({ apiKey, owner, busy, onRevoke }: {
  apiKey: ApiKey;
  owner: string;
  busy: boolean;
  onRevoke: () => void;
}) {
  const level = accessLevelOf(apiKey.scope);
  const restrictions = Object.entries(apiKey.module_access ?? {});
  const expired = apiKey.expires_at ? new Date(apiKey.expires_at).getTime() < Date.now() : false;
  return (
    <li>
      <div className="mcp-connection-main">
        <div className="mcp-connection-info">
          <strong>{apiKey.name}</strong>
          <small>
            <code>{apiKey.key_hint}</code>
            {' · '}namens {owner}
            {' · '}aangemaakt {formatDate(apiKey.created_at)}
            {' · '}{apiKey.last_used_at ? `laatst gebruikt ${formatDateTime(apiKey.last_used_at)}` : 'nog niet gebruikt'}
            {apiKey.expires_at && <>{' · '}{expired ? <strong>verlopen</strong> : `verloopt ${formatDate(apiKey.expires_at)}`}</>}
          </small>
          {restrictions.length > 0 && (
            <small>
              Beperkt: {restrictions.map(([module, value]) => `${moduleLabel(module)} ${value === 'none' ? 'geen toegang' : 'alleen lezen'}`).join(' · ')}
            </small>
          )}
        </div>
        <span className={`mcp-connection-scope${scopeTone(level)}`}>{API_ACCESS_LABEL[level].badge}</span>
        <Button variant="danger" onClick={onRevoke} disabled={busy}>{busy ? 'Bezig…' : 'Intrekken'}</Button>
      </div>
    </li>
  );
}

/** Hoe zwaarder de sleutel mag ingrijpen, hoe meer de badge opvalt — zelfde tonen als bij de AI-koppelingen. */
function scopeTone(level: ApiAccessLevel): string {
  if (level === 'execute' || level === 'execute_high') return ' is-execute';
  if (level === 'propose') return ' is-propose';
  return '';
}

function moduleLabel(key: string): string {
  return MODULES.find(m => m.key === key)?.label ?? key;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return date.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
