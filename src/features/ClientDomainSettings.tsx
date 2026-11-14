// Instellingen → Domein: het adres waarop je klanten je pagina's openen
// (migratie 20261108230000, docs/plannen/EIGEN_SUBDOMEIN_PLAN_2026-11-08.md).
//
// Twee kaarten. "Je webadres" is de naam bij ResoFly (<naam>.<basisdomein>),
// gekozen bij het inrichten; daar woont ook het klantportaal. "Eigen domein"
// koppelt een subdomein van je eigen domein (albums.jouwbedrijf.nl) voor de
// documenten met een link, met een CNAME- en een TXT-record; Cloudflare for
// SaaS maakt het certificaat. Het klantportaal kan er ook op, met een
// schakelaar (migratie 20261109020000). Standaard uit: een inlog daar geldt
// alleen voor deze organisatie, en klanten die al op het webadres ingelogd
// zijn, loggen op het nieuwe adres opnieuw in. Het verzenddomein voor mail
// staat eronder, in SimplePages (SendingDomainCard).
//
// Wijzigen mag alleen een owner of admin. De database (client_subdomain_claim)
// en de edge function client-domains controleren dat zelf; dit scherm verbergt
// alleen de knoppen.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Circle, Globe, Loader2 } from 'lucide-react';
import { Button, Input, Select } from '../components/Ui';
import { ClientAddressPicker, type AddressPickerState } from '../components/ClientAddressPicker';
import { canClaim, dnsRecordShortName, suggestCustomDomain, suggestSubdomain } from '../lib/clientDomains';
import {
  addClientDomain, claimClientSubdomain, loadClientDomainsOverview, refreshClientDomain, removeClientDomain, setClientDomainPortal,
  type ClientDomain, type ClientDomainStatus, type ClientDomainsOverview,
} from '../services/domainService';

/** Na koppelen of "Controleer nu" kijkt het scherm zelf mee, zo vaak en zo lang. */
const WATCH_INTERVAL_MS = 10_000;
const WATCH_TIMES = 18;

const STATUS_LABEL: Record<ClientDomainStatus, string> = {
  pending_dns: 'Wacht op het record',
  pending_certificate: 'Certificaat wordt gemaakt',
  active: 'Actief',
  failing: 'Werkt niet',
  moved: 'Verhuisd',
  removed: 'Verwijderd',
  blocked: 'Uitgezet door ResoFly',
};

function statusTone(status: ClientDomainStatus): 'ok' | 'wait' | 'bad' {
  if (status === 'active') return 'ok';
  if (status === 'pending_dns' || status === 'pending_certificate') return 'wait';
  return 'bad';
}

function isPending(status: ClientDomainStatus): boolean {
  return status === 'pending_dns' || status === 'pending_certificate';
}

/**
 * Een fout als zin. PostgREST geeft gewone objecten met een `message`, geen
 * Error; die tonen we ook. Engelse databasezinnen zeggen een gebruiker niets.
 */
function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error
    ? error.message
    : (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string')
      ? String((error as { message: string }).message)
      : '';
  if (!raw) return fallback;
  if (/row-level security|permission denied/i.test(raw)) return 'Alleen de eigenaar of een beheerder kan het webadres wijzigen.';
  if (/failed to fetch|networkerror|load failed/i.test(raw)) return 'Er is geen verbinding met ResoFly. Controleer je internet en probeer het opnieuw.';
  return raw;
}

function longDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function hostOfUrl(url: string): string {
  try { return new URL(url).host; } catch { return ''; }
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function CopyValue({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Geen klembord (geweigerd, of geen https): de waarde is ook te selecteren.
    }
  }
  return <button type="button" className="dns-record-copy" onClick={() => void copy()} aria-label={label}>{copied ? 'Gekopieerd' : 'Kopieer'}</button>;
}

// ── De stappen per domeinbeheerder ──────────────────────────────────────────
//
// Dezelfde vorm als de doorstuurregels bij E-mail. De menunamen verschuiven af
// en toe bij een provider, dus de stappen noemen wat je zoekt, niet elke klik.

const DNS_PROVIDERS: Array<{ id: string; label: string; steps: (name: string, target: string) => ReactNode[] }> = [
  {
    id: 'transip', label: 'TransIP', steps: (name, target) => [
      'Log in op het controlepaneel van TransIP en open bij Domeinen je domein.',
      'Ga naar het tabblad DNS en voeg een record toe.',
      <>Naam <code>{name}</code>, type <code>CNAME</code>, waarde <code>{target}.</code> Let op de punt aan het eind: zonder punt plakt TransIP je eigen domein erachter.</>,
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'versio', label: 'Versio', steps: (name, target) => [
      'Log in bij Versio, ga naar Domeinen en kies je domein.',
      'Open DNS-beheer en voeg een record toe.',
      <>Type <code>CNAME</code>, naam <code>{name}</code>, waarde <code>{target}</code>.</>,
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'mijndomein', label: 'Mijndomein', steps: (name, target) => [
      'Log in bij Mijndomein en open je domein.',
      'Ga naar de DNS-instellingen en voeg een record toe.',
      <>Type <code>CNAME</code>, naam <code>{name}</code>, waarde <code>{target}</code>.</>,
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'hostnet', label: 'Hostnet', steps: (name, target) => [
      'Log in op het controlepaneel van Hostnet en kies je domeinnaam.',
      'Open de DNS-instellingen en voeg een record toe.',
      <>Type <code>CNAME</code>, naam <code>{name}</code>, waarde <code>{target}</code>.</>,
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'strato', label: 'Strato', steps: (name, target) => [
      'Log in bij Strato en open het domeinbeheer.',
      <>Maak bij je domein eerst het subdomein <code>{name}</code> aan.</>,
      <>Open bij dat subdomein de DNS-instellingen en zet een CNAME-record met als waarde <code>{target}</code>.</>,
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'onecom', label: 'one.com', steps: (name, target) => [
      'Log in bij one.com en open de DNS-instellingen van je domein (bij de geavanceerde instellingen).',
      <>Maak een nieuw CNAME-record: hostnaam <code>{name}</code>, wijst naar <code>{target}</code>.</>,
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'cloudflare', label: 'Cloudflare', steps: (name, target) => [
      'Log in bij Cloudflare en kies je domein.',
      'Ga naar DNS → Records en kies Add record.',
      <>Type <code>CNAME</code>, Name <code>{name}</code>, Target <code>{target}</code>.</>,
      'Zet het wolkje op grijs (DNS only). Met een oranje wolkje werkt het niet.',
      'Sla de wijziging op.',
    ],
  },
  {
    id: 'overig', label: 'Een andere provider', steps: (name, target) => [
      'Log in bij de partij waar je domein staat en zoek naar DNS, DNS-beheer of zone-editor.',
      <>Maak een record van het type <code>CNAME</code>, met als naam <code>{name}</code> en als waarde <code>{target}</code>.</>,
      'Vraagt je provider om de volledige naam, vul dan de volledige naam in die hierboven staat.',
      'Sla op. Een wijziging is soms pas na een paar uur overal zichtbaar.',
    ],
  },
];

// ── Het tabblad ─────────────────────────────────────────────────────────────

export function ClientDomainSettings({ organizationId, canAdmin, companyName, website }: {
  organizationId: string;
  canAdmin: boolean;
  /** Voor een voorstel als er nog geen webadres is. */
  companyName: string | null;
  /** Voor een voorstel voor een eigen domein: albums.<je domein>. */
  website: string | null;
}) {
  const [overview, setOverview] = useState<ClientDomainsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Hoort een antwoord nog bij deze organisatie? Na wisselen mag een oud
  // antwoord het scherm niet meer vullen.
  const loadRun = useRef(0);

  const reload = useCallback(async () => {
    const run = ++loadRun.current;
    try {
      const next = await loadClientDomainsOverview(organizationId);
      if (loadRun.current === run) { setOverview(next); setLoadError(null); }
    } catch (err) {
      if (loadRun.current === run) setLoadError(errorText(err, 'Het webadres kon niet worden geladen.'));
    }
  }, [organizationId]);

  useEffect(() => {
    setOverview(null);
    setLoadError(null);
    void reload();
    return () => { loadRun.current += 1; };
  }, [reload]);

  const setDomain = useCallback((domain: ClientDomain) => {
    setOverview(current => current && current.domain?.id === domain.id ? { ...current, domain } : current);
  }, []);

  if (!overview) {
    return <section className="settings-card organization-card client-domain-card">
      <div className="settings-card-head"><div><h3>Je webadres</h3></div></div>
      {loadError
        ? <div className="error">{loadError} <button type="button" className="client-domain-link" onClick={() => void reload()}>Opnieuw proberen</button></div>
        : <p className="settings-help"><Loader2 size={14} className="onb-spin" aria-hidden="true" /> Even laden…</p>}
    </section>;
  }

  return <>
    <AddressCard organizationId={organizationId} overview={overview} canAdmin={canAdmin} companyName={companyName} onChanged={reload} />
    <CustomDomainCard organizationId={organizationId} overview={overview} canAdmin={canAdmin} website={website} onChanged={reload} onDomain={setDomain} />
  </>;
}

// ── Je webadres ─────────────────────────────────────────────────────────────

function AddressCard({ organizationId, overview, canAdmin, companyName, onChanged }: {
  organizationId: string;
  overview: ClientDomainsOverview;
  canAdmin: boolean;
  companyName: string | null;
  onChanged: () => Promise<void>;
}) {
  const current = overview.subdomain;
  const base = overview.config.base;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(() => current?.name ?? suggestSubdomain(companyName));
  const [picker, setPicker] = useState<AddressPickerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Zonder webadres (een organisatie van vóór deze functie) staat het veld
  // meteen open; met een adres pas na "Wijzig je adres".
  const showPicker = canAdmin && !overview.blocked && (editing || !current);
  const changed = Boolean(picker && picker.name !== current?.name);
  const ready = Boolean(picker && !picker.checking && changed && canClaim(picker.check));
  const appHost = hostOfUrl(overview.clientUrl);
  const domainActive = overview.domain?.status === 'active';
  // Albums kunnen vóór de rest op het klantadres (CLIENT_DOMAINS_LIVE=albums):
  // dan zegt het scherm waar ze heen gaan, en dat de rest nog volgt.
  const albumHost = !overview.config.live && overview.albumOnClientHost ? hostOfUrl(overview.albumUrl ?? '') : '';

  function startEditing() {
    setName(current?.name ?? suggestSubdomain(companyName));
    setPicker(null);
    setError(null);
    setMessage(null);
    setEditing(true);
  }

  async function save() {
    if (!picker || !ready) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await claimClientSubdomain(organizationId, picker.name);
      const host = `${result.name}.${base}`;
      setEditing(false);
      setPicker(null);
      setMessage(result.previous && result.changed
        ? `Je webadres is nu ${host}. ${result.previous}.${base} stuurt nog twaalf maanden door naar het nieuwe adres.`
        : `Je webadres is nu ${host}.`);
      await onChanged();
    } catch (err) {
      setError(errorText(err, 'Het webadres kon niet worden vastgelegd.'));
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-card organization-card client-domain-card" data-testid="client-address-card">
    <div className="settings-card-head">
      <div>
        <h3>Je webadres</h3>
        <p className="settings-help">Op dit adres openen je klanten hun portaal, albums, offertes, facturen, contracten en gedeelde bestanden. Het staat in elke mail die ze van je krijgen.</p>
      </div>
    </div>

    {message && <div className="success" role="status">{message}</div>}
    {error && <div className="error" role="alert">{error}</div>}

    {current && <div className="client-domain-current">
      <Globe size={16} aria-hidden="true" />
      <code className="client-domain-host">{current.host}</code>
      <CopyValue value={`https://${current.host}`} label={`Kopieer het adres ${current.host}`} />
    </div>}

    {overview.blocked && !current && <p className="settings-help client-domain-warning">ResoFly heeft je webadres uitgezet. Neem contact met ons op als je denkt dat dat niet klopt.</p>}
    {!overview.blocked && !current && !canAdmin && <p className="settings-help">Er is nog geen webadres gekozen. De eigenaar of een beheerder kan dat hier doen.</p>}
    {!overview.blocked && !current && canAdmin && <p className="settings-help">Je hebt nog geen webadres. Kies een naam die bij je bedrijf past; je klanten zien hem in elke mail.</p>}

    {current && <p className="settings-help" data-testid="client-address-usage">
      {!overview.config.live && albumHost
        ? <>De deellinks van je albums gaan al naar {albumHost === current.host ? 'dit adres' : <strong>{albumHost}</strong>}.{appHost
          ? <> Links in je mails (offertes, facturen, contracten en het portaal) gaan nu nog naar <strong>{appHost}</strong>.</>
          : null} Zodra ResoFly de klantadressen helemaal aanzet, gaan ook die vanzelf naar {albumHost === current.host ? 'dit adres' : 'je eigen adres'}.</>
        : !overview.config.live
        ? <>Nog niet in gebruik{appHost ? <>: links in je mails gaan nu naar <strong>{appHost}</strong></> : null}. Zodra ResoFly de klantadressen aanzet, gaan je links vanzelf naar dit adres.</>
        : domainActive
          ? overview.domain?.portalEnabled
            ? <>Je eigen domein <strong>{overview.domain?.hostname}</strong> gaat voor bij albums, offertes, facturen, contracten en het klantportaal.</>
            : <>Je eigen domein <strong>{overview.domain?.hostname}</strong> gaat voor bij albums, offertes, facturen en contracten. Het klantportaal blijft op dit adres.</>
          : <>Links in je mails en op je pagina's gaan naar dit adres.</>}
    </p>}

    {showPicker && <div className="client-domain-edit">
      <label className="client-domain-label" htmlFor="settings-client-address">{current ? 'Nieuw adres' : 'Je adres'}</label>
      <ClientAddressPicker
        id="settings-client-address"
        organizationId={organizationId}
        base={base}
        value={name}
        disabled={busy}
        autoFocus={editing}
        onChange={state => { setName(state.name); setPicker(state); setError(null); }}
      />
      {current && changed && <p className="settings-help">Je huidige adres <strong>{current.host}</strong> blijft nog twaalf maanden werken en stuurt door naar het nieuwe. Links in mails die je al verstuurde, blijven zo werken.</p>}
      <div className="client-domain-actions">
        <Button variant="primary" onClick={() => void save()} disabled={busy || !ready}>{busy ? 'Bezig…' : current ? 'Adres wijzigen' : 'Adres vastleggen'}</Button>
        {current && <Button onClick={() => { setEditing(false); setPicker(null); setError(null); }} disabled={busy}>Annuleren</Button>}
      </div>
    </div>}

    {current && canAdmin && !editing && !overview.blocked && <div className="client-domain-actions">
      <Button onClick={startEditing}>Wijzig je adres</Button>
    </div>}
    {current && !canAdmin && <p className="settings-help">Alleen de eigenaar of een beheerder kan het webadres wijzigen.</p>}

    {overview.previous.length > 0 && <div className="client-domain-previous">
      <span className="dns-record-label">Eerdere adressen</span>
      <ul>
        {overview.previous.map(item => <li key={item.name}><span><code>{item.host}</code> stuurt door tot {longDate(item.redirectUntil)}.</span></li>)}
      </ul>
    </div>}
  </section>;
}

// ── Eigen domein ────────────────────────────────────────────────────────────

function CustomDomainCard({ organizationId, overview, canAdmin, website, onChanged, onDomain }: {
  organizationId: string;
  overview: ClientDomainsOverview;
  canAdmin: boolean;
  website: string | null;
  onChanged: () => Promise<void>;
  onDomain: (domain: ClientDomain) => void;
}) {
  const domain = overview.domain;
  const target = overview.config.cnameTarget;
  const suggestion = suggestCustomDomain(website, overview.config.base);
  const [hostname, setHostname] = useState('');
  const [provider, setProvider] = useState('transip');
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Hoort het meekijken nog bij dit scherm? Na wegklikken, wisselen van
  // organisatie of verwijderen mag een oud antwoord niets meer bijwerken.
  const watchRun = useRef(0);
  useEffect(() => () => { watchRun.current += 1; }, []);
  useEffect(() => { watchRun.current += 1; setWatching(false); }, [organizationId]);

  const watch = useCallback(async (domainId: string) => {
    const run = ++watchRun.current;
    setWatching(true);
    let latest: ClientDomain | null = null;
    for (let attempt = 0; attempt < WATCH_TIMES; attempt += 1) {
      await wait(WATCH_INTERVAL_MS);
      if (watchRun.current !== run) return;
      try {
        latest = await refreshClientDomain(organizationId, domainId);
      } catch {
        break;
      }
      if (watchRun.current !== run) return;
      // Een antwoord zonder domein (een oudere server): stoppen in plaats van
      // het scherm leeg te maken.
      if (!latest?.id) { latest = null; break; }
      onDomain(latest);
      if (!isPending(latest.status)) break;
    }
    if (watchRun.current !== run) return;
    setWatching(false);
    if (latest?.status === 'active') {
      setMessage(`${latest.hostname} is actief.`);
      await onChanged();
    } else if (latest && isPending(latest.status)) {
      setMessage('We kijken op de achtergrond verder. Je krijgt een mail zodra je domein actief is.');
    }
  }, [organizationId, onDomain, onChanged]);

  // Staat er een domein te wachten als je het scherm opent: meteen meekijken.
  const pendingId = domain && isPending(domain.status) ? domain.id : null;
  useEffect(() => {
    if (pendingId && canAdmin) void watch(pendingId);
    // Alleen bij een ander wachtend domein opnieuw beginnen, niet bij elke
    // nieuwe stand van hetzelfde domein.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId, canAdmin]);

  async function add() {
    const value = hostname.trim();
    if (!value) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      const added = await addClientDomain(organizationId, value);
      setHostname('');
      await onChanged();
      if (added.status === 'active') setMessage(`${added.hostname} is actief.`);
      else setMessage('Zet het record hieronder bij je domeinbeheerder. Dit scherm kijkt zelf mee; je hoeft niets te verifiëren.');
    } catch (err) {
      setError(errorText(err, 'Het domein kon niet worden toegevoegd.'));
    } finally {
      setBusy(false);
    }
  }

  async function checkNow(item: ClientDomain) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const next = await refreshClientDomain(organizationId, item.id);
      if (!next?.id) throw new Error('Het domein kon niet worden gecontroleerd.');
      onDomain(next);
      if (next.status === 'active') {
        setMessage(`${next.hostname} is actief.`);
        await onChanged();
      } else if (isPending(next.status)) {
        void watch(next.id);
      }
    } catch (err) {
      setError(errorText(err, 'Het domein kon niet worden gecontroleerd.'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: ClientDomain) {
    const fallback = overview.subdomain?.host ?? hostOfUrl(overview.clientUrl);
    const question = item.verifiedAt
      ? `${item.hostname} ontkoppelen? Links in mails die je al verstuurde, blijven twaalf maanden werken zolang het record bij je domeinbeheerder blijft staan.${fallback ? ` Nieuwe mails linken naar ${fallback}.` : ''}`
      : `De koppeling met ${item.hostname} stoppen? Het record bij je domeinbeheerder kun je daarna weghalen.`;
    if (!window.confirm(question)) return;
    watchRun.current += 1;
    setWatching(false);
    setBusy(true); setError(null); setMessage(null);
    try {
      const result = await removeClientDomain(organizationId, item.id);
      setMessage(result.redirectUntil
        ? `${item.hostname} is ontkoppeld. Oude links sturen door tot ${longDate(result.redirectUntil)}, zolang het record blijft staan.`
        : 'De koppeling is gestopt. Je kunt het record bij je domeinbeheerder weghalen.');
      await onChanged();
    } catch (err) {
      setError(errorText(err, 'Het domein kon niet worden verwijderd.'));
    } finally {
      setBusy(false);
    }
  }

  async function changePortal(item: ClientDomain, enabled: boolean) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const next = await setClientDomainPortal(organizationId, item.id, enabled);
      if (!next?.id) throw new Error('Het klantportaal kon niet worden omgezet.');
      onDomain(next);
      const home = overview.subdomain?.host ?? 'je webadres';
      setMessage(enabled
        ? `Het klantportaal staat nu ook op ${item.hostname}.${item.status === 'active' ? '' : ' Het werkt zodra het domein actief is.'} Klanten die op ${home} ingelogd zijn, loggen daar één keer opnieuw in.`
        : `Het klantportaal staat weer alleen op ${home}. Klanten die op ${item.hostname} ingelogd waren, loggen opnieuw in.`);
      await onChanged();
    } catch (err) {
      setError(errorText(err, 'Het klantportaal kon niet worden omgezet.'));
    } finally {
      setBusy(false);
    }
  }

  async function stopRedirect(item: { id: string; hostname: string }) {
    if (!window.confirm(`Doorsturen vanaf ${item.hostname} stoppen? Oude links in verstuurde mails werken daarna niet meer.`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await removeClientDomain(organizationId, item.id);
      setMessage(`${item.hostname} stuurt niet meer door. Je kunt het record bij je domeinbeheerder weghalen.`);
      await onChanged();
    } catch (err) {
      setError(errorText(err, 'Het doorsturen kon niet worden gestopt.'));
    } finally {
      setBusy(false);
    }
  }

  const available = overview.config.customDomainsAvailable;
  const allowed = overview.customDomainAllowed;
  const fallbackHost = overview.subdomain?.host ?? null;

  return <section className="settings-card organization-card client-domain-card" data-testid="custom-domain-card">
    <div className="settings-card-head">
      <div>
        <h3>Eigen domein</h3>
        <p className="settings-help">Wil je dat je klanten je albums, offertes, facturen en contracten op je eigen domein openen, zoals <code>albums.jouwbedrijf.nl</code>? Koppel het hier met twee records bij je domeinbeheerder. Je website op je hoofddomein blijft gewoon werken. Ook het klantportaal kan daar staan.</p>
      </div>
    </div>

    {message && <div className="success" role="status">{message}</div>}
    {error && <div className="error" role="alert">{error}</div>}

    {domain && <DomainStatus
      domain={domain}
      target={target}
      live={overview.config.live}
      albumsHere={!overview.config.live && overview.albumOnClientHost === true && hostOfUrl(overview.albumUrl ?? '') === domain.hostname}
      fallbackHost={fallbackHost}
      watching={watching}
      provider={provider}
      onProvider={setProvider}
      actions={canAdmin && domain.status !== 'blocked' ? <div className="client-domain-actions">
        <Button onClick={() => void checkNow(domain)} disabled={busy}>{domain.status === 'active' ? 'Controleer opnieuw' : 'Controleer nu'}</Button>
        <Button variant="danger" onClick={() => void remove(domain)} disabled={busy}>{domain.verifiedAt ? 'Ontkoppelen' : 'Koppeling stoppen'}</Button>
      </div> : null}
    />}

    {domain && domain.status !== 'blocked' && <div className="billing-control-row client-domain-portal" data-testid="custom-domain-portal">
      <div>
        <strong>Ook het klantportaal op {domain.hostname}</strong>
        <p className="settings-help">{domain.portalEnabled
          ? <>Je klanten loggen in op <code>{domain.hostname}</code>.{domain.status === 'active' ? null : ' Dat werkt zodra het domein actief is.'}</>
          : <>Je klanten loggen nu in op <code>{fallbackHost ?? 'je webadres'}</code>. Zet je dit aan, dan op <code>{domain.hostname}</code>.</>}
          {' '}Een inlog op je eigen domein geldt alleen voor jouw portaal: wat je klanten bij anderen hebben, is daar nooit te zien.</p>
      </div>
      {canAdmin
        ? <label className="settings-toggle">
          <input
            type="checkbox"
            checked={domain.portalEnabled === true}
            disabled={busy}
            onChange={e => void changePortal(domain, e.target.checked)}
            aria-label={`Klantportaal ook op ${domain.hostname}`}
          />
          {domain.portalEnabled ? 'Aan' : 'Uit'}
        </label>
        : <span className="settings-toggle">{domain.portalEnabled ? 'Aan' : 'Uit'}</span>}
    </div>}

    {!domain && !canAdmin && <p className="settings-help">Er is geen eigen domein gekoppeld. De eigenaar of een beheerder kan dat hier doen.</p>}
    {!domain && canAdmin && !available && <p className="settings-help">Een eigen domein koppelen kan op deze omgeving nog niet. Je webadres hierboven werkt wel.</p>}
    {!domain && canAdmin && available && !allowed && <p className="settings-help">Een eigen domein kan met een betaald abonnement. Kies een abonnement bij Instellingen → Abonnement; je webadres hierboven werkt al.</p>}
    {!domain && canAdmin && available && allowed && <div className="client-domain-edit">
      <label className="client-domain-label" htmlFor="settings-custom-domain">Je domein</label>
      <div className="client-domain-add">
        <Input
          id="settings-custom-domain"
          value={hostname}
          onChange={e => { setHostname(e.target.value); setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }}
          placeholder={suggestion || 'albums.jouwbedrijf.nl'}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          inputMode="url"
          maxLength={253}
          disabled={busy}
        />
        <Button variant="primary" onClick={() => void add()} disabled={busy || !hostname.trim()}>{busy ? 'Bezig…' : 'Koppelen'}</Button>
      </div>
      {suggestion && !hostname && <p className="settings-help">Voorstel: <button type="button" className="client-domain-link" onClick={() => setHostname(suggestion)}>{suggestion}</button></p>}
      <p className="settings-help">Gebruik een subdomein, zoals <code>albums.jouwbedrijf.nl</code>. Op je hoofddomein mag geen CNAME-record staan, en daar staat meestal je website.</p>
    </div>}

    {overview.moved.length > 0 && <div className="client-domain-previous">
      <span className="dns-record-label">Verhuisd</span>
      <ul>
        {overview.moved.map(item => <li key={item.id}>
          <span><code>{item.hostname}</code> stuurt door tot {longDate(item.redirectUntil)}, zolang het record blijft staan.</span>
          {canAdmin && <button type="button" className="client-domain-link" onClick={() => void stopRedirect(item)} disabled={busy}>Doorsturen stoppen</button>}
        </li>)}
      </ul>
    </div>}

    <p className="settings-help client-domain-note">Mail en web horen niet op dezelfde naam: gebruik <code>albums.jouwbedrijf.nl</code> voor je pagina's en <code>info@jouwbedrijf.nl</code> als afzender. Naast een CNAME-record kan geen mail binnenkomen. Je afzender stel je hieronder in, bij Eigen verzenddomein.</p>
  </section>;
}

function DomainStatus({ domain, target, live, albumsHere, fallbackHost, watching, provider, onProvider, actions }: {
  domain: ClientDomain;
  target: string;
  live: boolean;
  /** Gaan de deellinks van albums al naar dit domein, terwijl de rest nog niet live is? */
  albumsHere: boolean;
  fallbackHost: string | null;
  watching: boolean;
  provider: string;
  onProvider: (id: string) => void;
  actions: ReactNode;
}) {
  const tone = statusTone(domain.status);
  const recordFound = domain.status === 'pending_certificate' || domain.status === 'active';
  const steps = [
    { label: 'Record gevonden', done: recordFound },
    { label: 'Certificaat klaar', done: domain.status === 'active' },
    { label: 'Actief', done: domain.status === 'active' },
  ];
  const cname = domain.records.find(record => record.type === 'CNAME');
  const txt = domain.records.find(record => record.type === 'TXT');
  const shortName = dnsRecordShortName(cname?.name ?? domain.hostname);
  // Het TXT-record bewijst dat het domein van jou is; zonder wordt het niet actief.
  const providerSteps: ReactNode[] = [
    ...(DNS_PROVIDERS.find(p => p.id === provider)?.steps(shortName, cname?.value ?? target) ?? []),
    ...(txt ? [<>Voeg op dezelfde manier het TXT-record toe: naam <code>{dnsRecordShortName(txt.name)}</code>, waarde <code>{txt.value}</code>. Daarmee laat je zien dat het domein van jou is.</>] : []),
  ];

  let text: string;
  switch (domain.status) {
    case 'pending_dns':
      text = domain.problem || `We zien nog geen record op ${domain.hostname}. Een wijziging bij je domeinbeheerder kan een paar uur duren.`;
      break;
    case 'pending_certificate':
      text = domain.problem || 'Record gevonden. We maken nu een beveiligd certificaat; dat duurt meestal een paar minuten.';
      break;
    case 'active':
      text = domain.portalEnabled
        ? `Actief. Je klanten openen hun portaal, albums, offertes, facturen en contracten op ${domain.hostname}.`
        : `Actief. Je klanten openen albums, offertes, facturen en contracten op ${domain.hostname}.`;
      break;
    case 'failing':
      text = `${domain.hostname} werkt niet meer: het record is weg of gewijzigd.${fallbackHost ? ` Nieuwe mails linken zolang naar ${fallbackHost}.` : ''}${domain.problem ? ` ${domain.problem}` : ''}`;
      break;
    case 'blocked':
      text = 'ResoFly heeft dit domein uitgezet. Neem contact met ons op als je denkt dat dat niet klopt.';
      break;
    default:
      text = '';
  }

  return <div className="sending-domain-row client-domain-row">
    <div className="sending-domain-head-row">
      <div className="sending-domain-title">
        <strong>{domain.hostname}</strong>
        <span className={`client-domain-status is-${tone}`}>{watching && isPending(domain.status) ? <><Loader2 size={11} className="onb-spin" aria-hidden="true" /> {STATUS_LABEL[domain.status]}</> : STATUS_LABEL[domain.status]}</span>
      </div>
    </div>

    {domain.status !== 'blocked' && <ol className="client-domain-steps" aria-label="Voortgang">
      {steps.map(step => <li key={step.label} className={step.done ? 'is-done' : ''}>
        {step.done ? <CheckCircle2 size={15} aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
        <span>{step.label}</span>
        <span className="client-domain-sr">{step.done ? ' (klaar)' : ' (nog niet)'}</span>
      </li>)}
    </ol>}

    {text && <p className={`settings-help${tone === 'bad' ? ' client-domain-warning' : ''}`} role="status" aria-live="polite">{text}</p>}
    {domain.status === 'active' && !live && <p className="settings-help">{albumsHere
      ? 'De deellinks van je albums gaan al hierheen. Links in je mails volgen zodra ResoFly de klantadressen helemaal aanzet.'
      : 'Links in je mails gaan hierheen zodra ResoFly de klantadressen aanzet.'}</p>}

    {domain.status !== 'active' && domain.status !== 'blocked' && <div className="dns-records">
      <p className="settings-help">Zet {domain.records.length > 1 ? 'deze twee records' : 'dit record'} bij de DNS van je domein, bij je domeinbeheerder. Bij de meeste beheerders vul je bij Naam alleen het deel vóór je domein in, zoals <code>{shortName}</code>.{txt ? ' Het TXT-record laat zien dat het domein van jou is: zonder wordt het niet actief.' : ''}</p>
      <div className="dns-records-list">
        {domain.records.map(record => <div className="dns-record" key={`${record.type}-${record.name}`}>
          <div className="dns-record-field"><span className="dns-record-label">Type</span><code>{record.type}</code></div>
          <div className="dns-record-field"><span className="dns-record-label">Naam</span><code>{record.name}</code><CopyValue value={record.name} label={`Kopieer de naam ${record.name}`} /></div>
          <div className="dns-record-field grow"><span className="dns-record-label">Waarde</span><code className="dns-record-value">{record.value}</code><CopyValue value={record.value} label={`Kopieer de waarde van ${record.name}`} /></div>
        </div>)}
      </div>
      <div className="settings-grid compact client-domain-provider">
        <label>Waar staat je domein?
          <Select value={provider} onChange={e => onProvider(e.target.value)}>
            {DNS_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </label>
      </div>
      <ol className="inbound-steps">
        {providerSteps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
    </div>}

    {actions}
    {domain.lastCheckedAt && <p className="settings-help sending-domain-checked">Laatst gecontroleerd: {new Date(domain.lastCheckedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' })}</p>}
  </div>;
}
