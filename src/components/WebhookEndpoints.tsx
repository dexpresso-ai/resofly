import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Button, Input } from './Ui';
import {
  createWebhook, deleteWebhook, listWebhookDeliveries, listWebhooks, loadWebhookCatalog, PublicApiNotAvailableError,
  rotateWebhookSecret, setWebhookActive, testWebhook,
  type ApiKey, type WebhookDelivery, type WebhookEndpoint, type WebhookEventInfo, type WebhookTestResult,
} from '../lib/public-api';
import type { UUID } from '../types';

/**
 * "Webhooks" in Instellingen → API & webhooks: ResoFly geeft zelf een seintje
 * als er iets gebeurt — een factuur betaald, een nieuwe klant, een ticket uit
 * het portaal — aan een adres dat jij opgeeft.
 *
 * Een webhook die hier wordt aangemaakt is van de ORGANISATIE en krijgt alles
 * waarop hij geabonneerd is. Een koppeling kan ook zelf een webhook aanmelden
 * via de API; die staat hier ook, met de sleutel erbij, en verdwijnt als die
 * sleutel wordt ingetrokken.
 *
 * Aan/uit en verwijderen lopen rechtstreeks langs RLS — "stop hiermee" moet het
 * altijd doen. Aanmaken, het geheim vernieuwen en testen lopen via api-admin,
 * omdat daar het adres gecontroleerd en het geheim versleuteld wordt.
 */

const MODULE_LABEL: Record<string, string> = {
  clients: 'Klanten', projects: 'Projecten en taken', tickets: 'Tickets', time: 'Uren',
  finance: 'Financiën', calendar: 'Agenda',
};

export function WebhookEndpoints({ organizationId, canAdmin, apiKeys }: {
  organizationId: UUID;
  canAdmin: boolean;
  /** Om bij een webhook van een koppeling de naam van de sleutel te tonen. */
  apiKeys: ApiKey[] | null;
}) {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [catalog, setCatalog] = useState<WebhookEventInfo[]>([]);
  const [ready, setReady] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fresh, setFresh] = useState<{ url: string; secret: string; rotated: boolean } | null>(null);
  const [tests, setTests] = useState<Record<string, WebhookTestResult>>({});
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);

  // Het formulier.
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [everything, setEverything] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set(['invoice.paid']));
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    if (!canAdmin) return;
    try {
      setEndpoints(await listWebhooks(organizationId));
      setUnavailable(false);
    } catch (err) {
      if (err instanceof PublicApiNotAvailableError) { setUnavailable(true); setEndpoints([]); return; }
      setError(err instanceof Error ? err.message : 'De webhooks konden niet worden opgehaald.');
    }
  }, [organizationId, canAdmin]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!canAdmin) return;
    let cancelled = false;
    loadWebhookCatalog(organizationId)
      .then(result => { if (!cancelled) { setCatalog(result.events); setReady(result.ready); } })
      .catch(() => { /* de lijst blijft leeg; het formulier zegt dat dan zelf */ });
    return () => { cancelled = true; };
  }, [organizationId, canAdmin]);

  const groups = useMemo(() => {
    const byModule = new Map<string, WebhookEventInfo[]>();
    for (const event of catalog) byModule.set(event.module, [...(byModule.get(event.module) ?? []), event]);
    return [...byModule.entries()];
  }, [catalog]);
  const labelOf = useMemo(() => new Map(catalog.map(e => [e.type, e.label])), [catalog]);
  const keyName = useMemo(() => new Map((apiKeys ?? []).map(k => [k.id, k.name])), [apiKeys]);

  function toggle(type: string) {
    setChosen(current => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    const events = everything ? ['*'] : [...chosen];
    if (events.length === 0) { setError('Kies minstens één gebeurtenis.'); return; }
    setCreating(true);
    try {
      const created = await createWebhook(organizationId, { url: url.trim(), events, description: description.trim() });
      setFresh({ url: created.endpoint.url, secret: created.secret, rotated: false });
      setUrl(''); setDescription(''); setEverything(false); setChosen(new Set(['invoice.paid']));
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'De webhook kon niet worden aangemaakt.');
    } finally {
      setCreating(false);
    }
  }

  async function run(endpoint: WebhookEndpoint, what: () => Promise<void>) {
    setBusyId(endpoint.id);
    try {
      await what();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dat is niet gelukt.');
    } finally {
      setBusyId(null);
    }
  }

  const test = (endpoint: WebhookEndpoint) => run(endpoint, async () => {
    const result = await testWebhook(organizationId, endpoint.id);
    setTests(current => ({ ...current, [endpoint.id]: result }));
    await refresh();
    if (openLog === endpoint.id) setDeliveries(await listWebhookDeliveries(organizationId, endpoint.id));
  });

  const toggleActive = (endpoint: WebhookEndpoint) => run(endpoint, async () => {
    await setWebhookActive(endpoint.id, !endpoint.active);
    await refresh();
  });

  const rotate = (endpoint: WebhookEndpoint) => {
    if (!confirm('Een nieuw geheim aanmaken? Het oude werkt meteen niet meer: werk het geheim bij de ontvanger direct bij, anders keurt die onze berichten af.')) return;
    void run(endpoint, async () => {
      const secret = await rotateWebhookSecret(organizationId, endpoint.id);
      setFresh({ url: endpoint.url, secret, rotated: true });
    });
  };

  const remove = (endpoint: WebhookEndpoint) => {
    if (!confirm(`De webhook naar ${endpoint.url} verwijderen? Er gaan daarna geen berichten meer naartoe.`)) return;
    void run(endpoint, async () => {
      await deleteWebhook(endpoint.id);
      if (openLog === endpoint.id) setOpenLog(null);
      await refresh();
    });
  };

  async function showLog(endpoint: WebhookEndpoint) {
    if (openLog === endpoint.id) { setOpenLog(null); return; }
    setOpenLog(endpoint.id);
    setDeliveries(null);
    try {
      setDeliveries(await listWebhookDeliveries(organizationId, endpoint.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'De bezorgingen konden niet worden opgehaald.');
    }
  }

  async function copySecret(secret: string) {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Kopiëren lukte niet. Selecteer het geheim en kopieer het handmatig.');
    }
  }

  if (!canAdmin) return null;

  return (
    <div className="settings-card api-integrations api-webhooks">
      <h3>Webhooks</h3>
      <p className="mcp-connections-intro">
        Laat ResoFly zelf een seintje geven als er iets gebeurt — een factuur betaald, een nieuwe klant, een ticket vanuit
        het portaal. Elk bericht gaat als JSON naar het adres dat je opgeeft, ondertekend met een geheim dat alleen jij en
        ResoFly kennen. Antwoordt je eindpunt niet, dan proberen we het bijna drie dagen lang opnieuw.
      </p>

      {error && <p className="error">{error}</p>}
      {unavailable && <p className="mcp-connections-empty">Nog niet beschikbaar in deze omgeving — webhooks worden binnenkort aangezet.</p>}
      {!unavailable && !ready && (
        <p className="mcp-connections-empty">Webhooks staan in deze omgeving nog niet aan: de beheerder moet eerst de versleutelsleutel instellen.</p>
      )}

      {!unavailable && (
        <>
          {fresh && (
            <div className="success api-key-fresh">
              <strong>{fresh.rotated ? 'Nieuw geheim' : 'Webhook aangemaakt'} voor {fresh.url} — kopieer het geheim nu, je ziet het maar één keer.</strong>
              <div className="dns-record">
                <div className="dns-record-field grow">
                  <span className="dns-record-label">Ondertekengeheim</span>
                  <code className="dns-record-value">{fresh.secret}</code>
                </div>
                <Button onClick={() => void copySecret(fresh.secret)}>{copied ? 'Gekopieerd' : 'Kopieer'}</Button>
              </div>
              <p className="mcp-connections-hint">
                Elk bericht draagt de header <code>ResoFly-Signature: t=…,v1=…</code>: een HMAC-SHA256 van <code>&lt;t&gt;.&lt;body&gt;</code> met
                dit geheim. Reken die na en weiger berichten die niet kloppen of ouder zijn dan vijf minuten.
              </p>
              <div><Button onClick={() => setFresh(null)}>Ik heb het bewaard</Button></div>
            </div>
          )}

          <h4 className="mcp-connections-heading">Nieuwe webhook</h4>
          <form className="api-key-form" onSubmit={create}>
            <div className="settings-grid compact">
              <label>Adres
                <Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.jouwdomein.nl/resofly" inputMode="url" />
              </label>
              <label>Omschrijving
                <Input value={description} maxLength={200} onChange={e => setDescription(e.target.value)} placeholder="Bijvoorbeeld: Boekhouding, Zapier" />
              </label>
            </div>

            <fieldset className="api-key-access">
              <legend>Waarover wil je een bericht?</legend>
              <label className="mcp-connection-switch">
                <input type="checkbox" checked={everything} onChange={e => setEverything(e.target.checked)} />
                <span>
                  <strong>Alles</strong>
                  <small>Elke gebeurtenis hieronder, ook die er later bij komen.</small>
                </span>
              </label>
              {!everything && (
                <div className="api-webhook-events">
                  {groups.length === 0 && <p className="mcp-connections-empty">De lijst met gebeurtenissen laadt…</p>}
                  {groups.map(([module, events]) => (
                    <div key={module} className="api-webhook-group">
                      <strong>{MODULE_LABEL[module] ?? module}</strong>
                      {events.map(event => (
                        <label key={event.type}>
                          <input type="checkbox" checked={chosen.has(event.type)} onChange={() => toggle(event.type)} />
                          <span>{event.label} <code>{event.type}</code></span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </fieldset>

            <div><Button variant="primary" disabled={creating || !url.trim() || !ready}>{creating ? 'Bezig…' : 'Webhook toevoegen'}</Button></div>
          </form>

          <h4 className="mcp-connections-heading">Webhooks</h4>
          {endpoints === null && <p className="mcp-connections-empty">Laden…</p>}
          {endpoints !== null && endpoints.length === 0 && <p className="mcp-connections-empty">Nog geen webhooks.</p>}
          {endpoints !== null && endpoints.length > 0 && (
            <ul className="mcp-connections-list">
              {endpoints.map(endpoint => {
                const busy = busyId === endpoint.id;
                const result = tests[endpoint.id];
                return (
                  <li key={endpoint.id}>
                    <div className="mcp-connection-main">
                      <div className="mcp-connection-info">
                        <strong title={endpoint.url}>{endpoint.description || endpoint.url}</strong>
                        <small>
                          {endpoint.description && <><code>{endpoint.url}</code>{' · '}</>}
                          {describeEvents(endpoint.events, labelOf)}
                          {endpoint.api_key_id && <>{' · '}via API-sleutel "{keyName.get(endpoint.api_key_id) ?? 'onbekend'}"</>}
                        </small>
                        <small>
                          {endpoint.last_success_at ? `laatst bezorgd ${formatDateTime(endpoint.last_success_at)}` : 'nog niets bezorgd'}
                          {endpoint.consecutive_failures > 0 && <>{' · '}{endpoint.consecutive_failures} keer op rij mislukt</>}
                        </small>
                        {!endpoint.active && endpoint.disabled_reason && <small className="api-webhook-reason">{endpoint.disabled_reason}</small>}
                        {result && (
                          <small className={result.status === 'delivered' ? 'api-webhook-ok' : 'api-webhook-reason'}>
                            Test: {result.status === 'delivered'
                              ? `aangekomen (HTTP ${result.httpStatus}, ${result.durationMs} ms)`
                              : `mislukt — ${result.error ?? `HTTP ${result.httpStatus}`}`}
                          </small>
                        )}
                      </div>
                      <span className={`mcp-connection-scope${endpoint.active ? ' is-execute' : ''}`}>
                        {endpoint.active ? 'Aan' : endpoint.disabled_reason ? 'Automatisch uit' : 'Uit'}
                      </span>
                    </div>
                    <div className="api-webhook-actions">
                      <Button onClick={() => void test(endpoint)} disabled={busy || !endpoint.active}>Testen</Button>
                      <Button onClick={() => void toggleActive(endpoint)} disabled={busy}>{endpoint.active ? 'Uitzetten' : 'Aanzetten'}</Button>
                      <Button onClick={() => void showLog(endpoint)} disabled={busy}>{openLog === endpoint.id ? 'Verberg bezorgingen' : 'Bezorgingen'}</Button>
                      <Button onClick={() => rotate(endpoint)} disabled={busy}>Nieuw geheim</Button>
                      <Button variant="danger" onClick={() => remove(endpoint)} disabled={busy}>Verwijderen</Button>
                    </div>
                    {openLog === endpoint.id && (
                      <div className="api-request-log">
                        {deliveries === null && <p className="mcp-connections-empty">Laden…</p>}
                        {deliveries !== null && deliveries.length === 0 && <p className="mcp-connections-empty">Nog geen bezorgingen.</p>}
                        {deliveries !== null && deliveries.length > 0 && (
                          <table>
                            <thead><tr><th>Wanneer</th><th>Gebeurtenis</th><th>Uitkomst</th></tr></thead>
                            <tbody>
                              {deliveries.map(delivery => (
                                <tr key={delivery.id} className={delivery.status === 'failed' ? 'is-error' : ''}>
                                  <td>{formatDateTime(delivery.created_at)}</td>
                                  <td><code>{delivery.event_type ?? '—'}</code></td>
                                  <td>{describeDelivery(delivery)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function describeEvents(events: string[], labels: Map<string, string>): string {
  if (events.includes('*')) return 'alle gebeurtenissen';
  const named = events.map(type => (type.endsWith('.*') ? `alles van ${type.slice(0, -2)}` : labels.get(type) ?? type));
  return named.length <= 3 ? named.join(', ') : `${named.slice(0, 3).join(', ')} en ${named.length - 3} meer`;
}

function describeDelivery(delivery: WebhookDelivery): string {
  const code = delivery.response_status ? ` (HTTP ${delivery.response_status})` : '';
  switch (delivery.status) {
    case 'delivered': return `aangekomen${code}`;
    case 'pending': return delivery.attempts > 0
      ? `mislukt${code}, opnieuw om ${formatDateTime(delivery.next_attempt_at)}`
      : 'staat klaar';
    case 'sending': return 'onderweg';
    case 'skipped': return `overgeslagen — ${delivery.error ?? ''}`;
    case 'failed': return `opgegeven na ${delivery.attempts} poging${delivery.attempts === 1 ? '' : 'en'} — ${delivery.error ?? `HTTP ${delivery.response_status}`}`;
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'onbekend';
  return date.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
