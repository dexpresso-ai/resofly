// ============================================================
// Het webadres van een organisatie: de regels, los te testen.
//
// Twee soorten adres (migratie 20261108230000):
//   - een naam bij ResoFly: <naam>.<basisdomein>, bijvoorbeeld
//     jansen.resofly.com. Gekozen bij het inrichten van de organisatie.
//   - een eigen domein: portaal.jansen.nl, met één CNAME-record naar ons,
//     via Cloudflare for SaaS.
//
// Puur: geen database, geen Deno, geen netwerk. clientDomains.test.ts loopt
// het na; de edge function client-domains, de linkbouwer (clientLinks.ts) en
// de Worker (workers/client-domains) gebruiken het.
// ============================================================

/** Waar een naam niet aan voldoet. De database (client_subdomain_problem) is de baas; dit is voor de snelle melding. */
export type SubdomainProblem = 'te_kort' | 'te_lang' | 'tekens' | 'streepje' | 'alleen_cijfers';

export const SUBDOMAIN_PROBLEM_TEXT: Record<SubdomainProblem | 'gereserveerd', string> = {
  te_kort: 'Kies een naam van minstens 3 tekens.',
  te_lang: 'Kies een naam van hooguit 40 tekens.',
  tekens: 'Gebruik alleen kleine letters, cijfers en streepjes.',
  streepje: 'Een streepje mag niet aan het begin of eind staan, en niet twee keer achter elkaar.',
  alleen_cijfers: 'Gebruik ook letters, niet alleen cijfers.',
  gereserveerd: 'Deze naam is niet beschikbaar. Kies een andere.',
};

/** De vorm van een naam, zoals client_subdomain_problem() hem keurt (zonder de lijst met gereserveerde namen). */
export function subdomainFormatProblem(name: string): SubdomainProblem | null {
  const v = String(name ?? '');
  if (v.length < 3) return 'te_kort';
  if (v.length > 40) return 'te_lang';
  if (!/^[a-z0-9-]+$/.test(v)) return 'tekens';
  if (v.startsWith('-') || v.endsWith('-') || v.includes('--')) return 'streepje';
  if (/^[0-9-]+$/.test(v)) return 'alleen_cijfers';
  return null;
}

/** De naam van een host: kleine letters, zonder punt aan het eind. */
export function normalizeHost(value: string): string {
  return String(value ?? '').trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * Wat iemand in het veld voor een eigen domein plakt, als kale hostnaam:
 * `https://Portaal.Jansen.nl/pad` → `portaal.jansen.nl`, `bücher.de` →
 * punycode. Null als het geen hostnaam is.
 */
export function parseHostnameInput(value: string): string | null {
  let raw = String(value ?? '').trim();
  if (!raw) return null;
  // Een e-mailadres: het domein erachter.
  if (/^[^\s/@]+@[^\s/@]+$/.test(raw)) raw = raw.slice(raw.lastIndexOf('@') + 1);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  let host: string;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return null;
    host = url.hostname;
  } catch {
    return null;
  }
  host = normalizeHost(host);
  if (!host || host.length > 253 || host.startsWith('[')) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return null;
  return host;
}

/**
 * Achtervoegsels van twee delen waar een hoofddomein er drie heeft
 * (jansen.co.uk). Geen volledige publicsuffix-lijst: genoeg om te zien dat
 * `portaal.co.uk` geen subdomein van iemands domein is maar een hoofddomein.
 */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'net.nz', 'co.za', 'org.za',
  'com.br', 'net.br', 'co.jp', 'or.jp', 'ne.jp', 'co.kr', 'com.cn', 'com.hk', 'com.sg', 'com.tr', 'com.mx',
  'co.in', 'co.il', 'co.at', 'or.at', 'com.pl', 'com.pt', 'com.es', 'com.ar', 'co.id', 'com.my', 'eu.org',
]);

/** Is dit een hoofddomein (jansen.nl, jansen.co.uk) in plaats van een subdomein? */
export function isApexDomain(host: string): boolean {
  const labels = normalizeHost(host).split('.').filter(Boolean);
  if (labels.length <= 2) return true;
  return labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join('.'));
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** Hetzelfde domein, of het ene ligt onder het andere. */
export function hostsOverlap(a: string, b: string): boolean {
  const x = normalizeHost(a);
  const y = normalizeHost(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Waarom een eigen domein niet kan, of null. `reserved` zijn de domeinen van
 * ResoFly zelf (het basisdomein, het CNAME-doel, het adres van de app): een
 * klant mag daar niets onder of boven claimen.
 */
export function customDomainProblem(hostname: string, reserved: readonly string[]): string | null {
  const host = normalizeHost(hostname);
  if (!host) return 'Vul een domein in, zoals portaal.jouwbedrijf.nl.';
  if (isIpAddress(host)) return 'Vul een domeinnaam in, geen IP-adres.';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.invalid') || host.endsWith('.example')) {
    return 'Dit domein bestaat niet op internet. Vul je eigen domein in.';
  }
  for (const own of reserved) {
    if (own && hostsOverlap(host, own)) return 'Dit adres hoort bij ResoFly zelf. Vul je eigen domein in.';
  }
  if (isApexDomain(host)) {
    const labels = host.split('.');
    const suggestion = `portaal.${host}`;
    return labels.length >= 2
      ? `Gebruik een subdomein, zoals ${suggestion}. Op het hoofddomein ${host} mag geen CNAME-record staan, en daar staat meestal je website.`
      : 'Vul een volledig domein in, zoals portaal.jouwbedrijf.nl.';
  }
  return null;
}

/** <naam>.<basisdomein> */
export function subdomainHost(name: string, base: string): string {
  return `${normalizeHost(name)}.${normalizeHost(base)}`;
}

export type ClientHost =
  | { kind: 'subdomain'; name: string }
  | { kind: 'custom'; hostname: string };

/**
 * Wat voor adres is dit? Een naam onder het basisdomein (één label, niets
 * dieper), of een eigen domein. Het basisdomein zelf en wat er dieper onder
 * ligt (a.b.resofly.com) is geen klantadres: null.
 */
export function parseClientHost(host: string, base: string): ClientHost | null {
  const h = normalizeHost(host);
  const b = normalizeHost(base);
  if (!h) return null;
  if (b && (h === b || h.endsWith(`.${b}`))) {
    if (h === b) return null;
    const label = h.slice(0, -(b.length + 1));
    if (!label || label.includes('.')) return null;
    if (subdomainFormatProblem(label)) return null;
    return { kind: 'subdomain', name: label };
  }
  if (!parseHostnameInput(h) || isApexDomain(h)) return null;
  return { kind: 'custom', hostname: h };
}

// ── Cloudflare for SaaS ──────────────────────────────────────────────────────

/** Zoals de Custom Hostnames-API een hostnaam teruggeeft (alleen wat we lezen). */
export interface CloudflareCustomHostname {
  id?: string;
  hostname?: string;
  status?: string;
  verification_errors?: string[];
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string;
    validation_errors?: Array<{ message?: string }>;
  };
}

export type ClientDomainStatus =
  | 'pending_dns' | 'pending_certificate' | 'active' | 'failing' | 'moved' | 'removed' | 'blocked';

export interface ClientDomainState {
  status: ClientDomainStatus;
  /** Een zin voor het scherm als er iets hapert, anders null. */
  problem: string | null;
}

const SSL_PENDING = new Set([
  'initializing', 'pending_validation', 'pending_issuance', 'pending_deployment', 'staging_deployment', 'staging_active',
  'holding_deployment', 'backup_issued',
]);
const SSL_FAILED = new Set([
  'initializing_timed_out', 'validation_timed_out', 'issuance_timed_out', 'deployment_timed_out', 'expired', 'deleted',
  'deactivating', 'inactive', 'pending_deletion', 'pending_expiration', 'pending_cleanup', 'deletion_timed_out',
]);

/** Een foutmelding van Cloudflare in gewone woorden. */
export function translateCloudflareError(message: string): string {
  const m = String(message ?? '').toLowerCase();
  if (!m) return 'Cloudflare meldt een fout zonder uitleg.';
  if (m.includes('cname') || m.includes('does not resolve') || m.includes('not point')) return 'We zien het CNAME-record nog niet, of het wijst naar een ander adres.';
  if (m.includes('caa')) return 'Een CAA-record op je domein staat ons certificaat niet toe. Voeg een CAA-record toe voor letsencrypt.org en pki.goog, of haal de CAA-records weg.';
  if (m.includes('timed out') || m.includes('timeout')) return 'Het controleren duurde te lang. Controleer het record en klik op Opnieuw controleren.';
  if (m.includes('blocked') || m.includes('prohibited')) return 'Cloudflare staat dit domein niet toe.';
  return `Cloudflare meldt: ${String(message).slice(0, 200)}`;
}

/**
 * De stand bij Cloudflare, vertaald naar onze status. `wasActive`: het domein
 * was al eens actief (verified_at); verdwijnt het record dan, dan hapert het
 * in plaats van dat het weer "wacht op DNS".
 */
export function cloudflareHostnameState(result: CloudflareCustomHostname | null | undefined, wasActive: boolean): ClientDomainState {
  if (!result) return { status: wasActive ? 'failing' : 'pending_dns', problem: 'Het domein staat niet (meer) bij Cloudflare. Verwijder het en voeg het opnieuw toe.' };
  const status = String(result.status ?? '').toLowerCase();
  const ssl = String(result.ssl?.status ?? '').toLowerCase();
  const verificationError = (result.verification_errors ?? []).find(Boolean) ?? null;
  const sslError = (result.ssl?.validation_errors ?? []).map(e => e?.message).find(Boolean) ?? null;

  if (status === 'blocked' || status === 'pending_blocked' || status === 'test_blocked') {
    return { status: 'blocked', problem: 'Cloudflare heeft dit domein geblokkeerd. Neem contact op met ResoFly.' };
  }
  if (status === 'deleted' || status === 'pending_deletion') {
    return { status: wasActive ? 'failing' : 'pending_dns', problem: 'Het domein is bij Cloudflare verwijderd. Verwijder het hier en voeg het opnieuw toe.' };
  }
  if (status === 'moved') {
    return { status: wasActive ? 'failing' : 'pending_dns', problem: 'Het CNAME-record wijst niet (meer) naar ResoFly.' };
  }
  if (status === 'active' && ssl === 'active') return { status: 'active', problem: null };
  if (SSL_FAILED.has(ssl)) {
    return { status: wasActive ? 'failing' : 'pending_certificate', problem: translateCloudflareError(sslError ?? ssl) };
  }
  if (status === 'active') {
    return { status: wasActive ? 'failing' : 'pending_certificate', problem: sslError ? translateCloudflareError(sslError) : null };
  }
  // Nog niet gevalideerd (pending, test_pending, …).
  if (verificationError) return { status: wasActive ? 'failing' : 'pending_dns', problem: translateCloudflareError(verificationError) };
  if (SSL_PENDING.has(ssl) && ssl !== 'initializing' && ssl !== 'pending_validation') {
    return { status: wasActive ? 'failing' : 'pending_certificate', problem: null };
  }
  return { status: wasActive ? 'failing' : 'pending_dns', problem: sslError ? translateCloudflareError(sslError) : null };
}

export interface DnsRecordInstruction {
  type: 'CNAME' | 'TXT';
  /** De volledige naam; de meeste providers willen alleen het deel vóór je domein. */
  name: string;
  value: string;
}

/**
 * Wat de klant bij zijn domeinbeheerder zet: het CNAME-record (het verkeer)
 * en het TXT-record van deze koppeling (het bewijs dat het domein van hem is).
 * Beide zijn nodig; zie ownershipVerdict.
 */
export function dnsInstructions(hostname: string, cnameTarget: string, result?: CloudflareCustomHostname | null): DnsRecordInstruction[] {
  const records: DnsRecordInstruction[] = [{ type: 'CNAME', name: normalizeHost(hostname), value: normalizeHost(cnameTarget) }];
  const own = result?.ownership_verification;
  if (own?.type === 'txt' && own.name && own.value) {
    records.push({ type: 'TXT', name: normalizeHost(own.name), value: String(own.value) });
  }
  return records;
}

/** Een TXT-antwoord als losse waarden: zonder aanhalingstekens, stukken samengevoegd. */
export function txtValues(answers: readonly string[]): string[] {
  return answers.map((answer) => {
    const text = String(answer ?? '').trim();
    const chunks = text.match(/"((?:[^"\\]|\\.)*)"/g);
    return chunks ? chunks.map((chunk) => chunk.slice(1, -1).replace(/\\(.)/g, '$1')).join('') : text;
  });
}

/**
 * Mag een eigen domein actief worden? Alleen met het TXT-record van díe
 * koppeling (de waarde die Cloudflare voor deze aanmelding gaf), of als het
 * al eens actief was.
 *
 * Waarom: het CNAME-record is voor iedereen hetzelfde. Haalde een organisatie
 * haar domein weg en liet ze het record staan, dan kon een andere organisatie
 * dezelfde hostnaam koppelen: Cloudflare zag het record en keurde het goed. En
 * wie een hostnaam als eerste aanmeldde, won zodra de echte eigenaar zijn
 * CNAME zette. Het TXT-record verschilt per aanmelding; dat zet alleen wie de
 * DNS van het domein beheert, voor zijn eigen aanmelding.
 *
 * `found`: true = gevonden, false = niet gevonden, null = niet te controleren
 * (DNS gaf geen antwoord). Bij twijfel niet actief.
 */
export function ownershipVerdict(
  state: ClientDomainState,
  ownership: { wasVerified: boolean; name: string | null; found: boolean | null },
): ClientDomainState {
  if (ownership.wasVerified || state.status === 'blocked' || ownership.found === true) return state;
  const txtProblem = ownership.found === null
    ? 'We konden het TXT-record nog niet controleren. Probeer het zo opnieuw.'
    : `Zet ook het TXT-record op ${ownership.name ?? 'de naam hieronder'}. Daarmee laat je zien dat het domein van jou is.`;
  // Wijst het CNAME-record nog niet goed, dan is dat eerst aan de beurt.
  if (state.status === 'pending_dns' && state.problem) return state;
  return { status: 'pending_dns', problem: txtProblem };
}
