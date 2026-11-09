// Het webadres van een organisatie, in de app: de naam bij ResoFly
// (<naam>.<basisdomein>) en een eigen domein (migratie 20261108230000).
//
// Wat hier staat is voor de snelle melding tijdens het typen. De database
// beslist (client_subdomain_check en client_subdomain_claim); de vorm van een
// naam en de zinnen zijn een kopie van supabase/functions/_shared/
// clientDomains.ts, en clientDomains.test.ts houdt ze gelijk.

export type SubdomainProblem = 'te_kort' | 'te_lang' | 'tekens' | 'streepje' | 'alleen_cijfers';

export const SUBDOMAIN_PROBLEM_TEXT: Record<SubdomainProblem | 'gereserveerd', string> = {
  te_kort: 'Kies een naam van minstens 3 tekens.',
  te_lang: 'Kies een naam van hooguit 40 tekens.',
  tekens: 'Gebruik alleen kleine letters, cijfers en streepjes.',
  streepje: 'Een streepje mag niet aan het begin of eind staan, en niet twee keer achter elkaar.',
  alleen_cijfers: 'Gebruik ook letters, niet alleen cijfers.',
  gereserveerd: 'Deze naam is niet beschikbaar. Kies een andere.',
};

export function subdomainFormatProblem(name: string): SubdomainProblem | null {
  const v = String(name ?? '');
  if (v.length < 3) return 'te_kort';
  if (v.length > 40) return 'te_lang';
  if (!/^[a-z0-9-]+$/.test(v)) return 'tekens';
  if (v.startsWith('-') || v.endsWith('-') || v.includes('--')) return 'streepje';
  if (/^[0-9-]+$/.test(v)) return 'alleen_cijfers';
  return null;
}

/** Accenten eraf: "Café Élan" → "Cafe Elan". */
function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Wat iemand typt, terwijl hij typt: kleine letters, spaties en punten worden
 * streepjes, de rest valt weg. Een streepje aan het eind blijft staan (hij
 * typt misschien nog door); de controle zegt het als het zo blijft.
 */
export function normalizeSubdomainInput(value: string): string {
  return stripAccents(String(value ?? '').toLowerCase())
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40);
}

const LEGAL_SUFFIXES = /\b(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?|vof|bv|nv|cv|holding|eenmanszaak|ltd|gmbh|inc)\.?$/i;

/** Een voorstel uit de naam van het bedrijf: "Studio Lopik B.V." → "studio-lopik". */
export function suggestSubdomain(companyName: string | null | undefined): string {
  let name = String(companyName ?? '').trim();
  for (let i = 0; i < 2; i += 1) name = name.replace(LEGAL_SUFFIXES, '').trim().replace(/[,.\s]+$/, '');
  const slug = normalizeSubdomainInput(name).replace(/-+$/, '').slice(0, 40).replace(/-+$/, '');
  return subdomainFormatProblem(slug) ? '' : slug;
}

/** Wat de database zegt over een naam (client_subdomain_check). */
export type SubdomainAvailability = 'available' | 'taken' | 'reserved' | 'invalid' | 'own' | 'own_previous';

export interface SubdomainCheck {
  name: string;
  status: SubdomainAvailability;
  message?: string;
}

/** De zin onder het veld. */
export function availabilityText(check: SubdomainCheck, host: string): string {
  switch (check.status) {
    case 'available': return `${host} is beschikbaar.`;
    case 'own': return `${host} is nu je adres.`;
    case 'own_previous': return `${host} was eerder je adres. Je kunt het terugnemen.`;
    case 'taken': return 'Dit adres bestaat al. Kies een andere naam.';
    case 'reserved': return SUBDOMAIN_PROBLEM_TEXT.gereserveerd;
    case 'invalid': return check.message || 'Deze naam kan niet.';
  }
}

/** Mag je deze naam vastleggen? */
export function canClaim(check: SubdomainCheck | null): boolean {
  return Boolean(check && (check.status === 'available' || check.status === 'own_previous'));
}

/** De hostnaam uit wat iemand als website invulde: "https://www.jansen.nl/contact" → "www.jansen.nl". */
function hostOf(value: string | null | undefined): string {
  const host = String(value ?? '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/?#:]/)[0]
    .replace(/\.+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
}

/**
 * Een voorstel voor een eigen domein: albums.<je domein>, uit je website. Niet
 * "portaal": het klantportaal woont op de naam bij ResoFly, het eigen domein
 * is voor albums, offertes en facturen. Alleen een voorstel; wat je typt,
 * gaat voor. Een adres onder het domein van ResoFly zelf is geen eigen domein.
 */
export function suggestCustomDomain(website: string | null | undefined, base: string): string {
  const host = hostOf(website).replace(/^www\./, '');
  if (!host.includes('.')) return '';
  const own = base.toLowerCase();
  if (host === own || host.endsWith(`.${own}`)) return '';
  return `albums.${host}`;
}

/**
 * Wat je bij de meeste domeinbeheerders bij "Naam" invult: het deel vóór je
 * domein (portaal.jansen.nl → portaal). Bij jansen.co.uk blijft co.uk staan.
 * Het blijft een gok, dus het scherm toont de volledige naam ernaast.
 */
export function dnsRecordShortName(name: string): string {
  const labels = String(name ?? '').toLowerCase().replace(/\.+$/, '').split('.').filter(Boolean);
  const last = labels[labels.length - 1] ?? '';
  const secondLevel = labels.length >= 3 && last.length === 2 && /^(co|com|net|org|ac|gov|edu)$/.test(labels[labels.length - 2]);
  const keep = secondLevel ? 3 : 2;
  return labels.length > keep ? labels.slice(0, labels.length - keep).join('.') : '@';
}
