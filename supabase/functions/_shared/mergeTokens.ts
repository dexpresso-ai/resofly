// ============================================================
// Variabelen ({{token}}) voor campagnes en follow-up-stromen.
//
// De body, het onderwerp en de preheader mogen tokens bevatten; die worden per
// ONTVANGER ingevuld. De waarden komen uit een momentopname die bij het
// materialiseren van de ontvangers is gemaakt (email_campaign_recipients.
// merge_data / email_flow_enrollments.merge_data), niet uit een live query bij
// het versturen — zie migratie 20260814000000 voor het waarom.
//
// Twee soorten tokens:
//   {{klantnaam}}      — vaste velden (klant, contactpersoon, eigen bedrijf)
//   {{veld.<sleutel>}} — vrije velden uit client_field_definitions
// De punt-namespace voorkomt dat een zelfgemaakt veld "datum" het vaste
// {{datum}} overschaduwt.
//
// Terugvalwaarde: {{voornaam|klant}} levert "klant" als het veld leeg is.
// Zonder dit wordt "Beste {{voornaam}}," letterlijk "Beste ,".
//
// BELANGRIJK: houd deze module gelijk aan de frontend-spiegel src/lib/
// mergeTokens.ts, die de chips in de editor en de voorbeeldweergave levert.
// ============================================================

export type MergeFieldDefinition = {
  field_key: string;
  label: string;
  field_type: string;
  default_fallback?: string | null;
};

export type MergeClient = {
  name?: string | null;
  contact_name?: string | null;
  client_code?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  postal_code?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  country?: string | null;
  vat_number?: string | null;
  kvk_number?: string | null;
  custom_fields?: Record<string, unknown> | null;
};

export type MergeContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: string | null;
};

export type MergeCompany = {
  company_name?: string | null;
  trade_name?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
};

export type MergeTokenSource = {
  client?: MergeClient | null;
  contact?: MergeContact | null;
  company?: MergeCompany | null;
  /** Het adres waar deze mail heen gaat — vult {{email}} als de klant geen eigen adres heeft. */
  toEmail?: string | null;
  toName?: string | null;
  /** Datum voor {{datum}}; standaard vandaag. Meegeven maakt het testbaar. */
  today?: Date;
};

/** De vaste tokens, in de volgorde waarin de editor ze als chips toont. */
export const STANDARD_MERGE_TOKENS: Array<{ token: string; label: string; group: string }> = [
  { token: 'klantnaam', label: 'Klantnaam', group: 'Klant' },
  { token: 'contactpersoon', label: 'Contactpersoon', group: 'Klant' },
  { token: 'voornaam', label: 'Voornaam', group: 'Klant' },
  { token: 'achternaam', label: 'Achternaam', group: 'Klant' },
  { token: 'functie', label: 'Functie', group: 'Klant' },
  { token: 'email', label: 'E-mailadres', group: 'Klant' },
  { token: 'telefoon', label: 'Telefoon', group: 'Klant' },
  { token: 'klantnummer', label: 'Klantnummer', group: 'Klant' },
  { token: 'adres', label: 'Adres', group: 'Klant' },
  { token: 'postcode', label: 'Postcode', group: 'Klant' },
  { token: 'plaats', label: 'Plaats', group: 'Klant' },
  { token: 'land', label: 'Land', group: 'Klant' },
  { token: 'btwnummer', label: 'Btw-nummer', group: 'Klant' },
  { token: 'kvknummer', label: 'KVK-nummer', group: 'Klant' },
  { token: 'bedrijfsnaam', label: 'Eigen bedrijfsnaam', group: 'Eigen bedrijf' },
  { token: 'bedrijfsadres', label: 'Eigen adres', group: 'Eigen bedrijf' },
  { token: 'bedrijfsemail', label: 'Eigen e-mailadres', group: 'Eigen bedrijf' },
  { token: 'bedrijfstelefoon', label: 'Eigen telefoon', group: 'Eigen bedrijf' },
  { token: 'website', label: 'Website', group: 'Eigen bedrijf' },
  { token: 'datum', label: 'Datum van vandaag', group: 'Overig' },
];

const STANDARD_TOKEN_KEYS = new Set(STANDARD_MERGE_TOKENS.map((t) => t.token));

/** Het token waarmee een vrij klantveld in een mailing wordt aangeroepen. */
export function customFieldToken(fieldKey: string): string {
  return `veld.${fieldKey}`;
}

/**
 * Bouwt de token→waarde-tabel voor één ontvanger. Lege waarden blijven bewust
 * leeg (lege string): de terugvalwaarde wordt pas bij het INVULLEN toegepast,
 * zodat zowel {{voornaam|klant}} als de standaardterugval uit de velddefinitie
 * kan gelden.
 */
export function buildMergeTokens(
  source: MergeTokenSource,
  definitions: MergeFieldDefinition[] = [],
): Record<string, string> {
  const client = source.client ?? null;
  const contact = source.contact ?? null;
  const company = source.company ?? null;

  const contactName = text(contact?.name) || text(client?.contact_name) || text(source.toName);
  const { first, last } = splitName(contactName);

  const tokens: Record<string, string> = {
    klantnaam: text(client?.name),
    contactpersoon: contactName,
    voornaam: first,
    achternaam: last,
    functie: text(contact?.role),
    email: text(contact?.email) || text(source.toEmail) || text(client?.email),
    telefoon: text(contact?.phone) || text(client?.phone),
    klantnummer: text(client?.client_code),
    adres: joinAddress(client?.address_line1, client?.address_line2, client?.postal_code, client?.city, client?.country),
    postcode: text(client?.postal_code),
    plaats: text(client?.city),
    land: text(client?.country),
    btwnummer: text(client?.vat_number),
    kvknummer: text(client?.kvk_number),
    bedrijfsnaam: text(company?.trade_name) || text(company?.company_name),
    bedrijfsadres: joinAddress(company?.address_line1, company?.address_line2, company?.postal_code, company?.city, company?.country),
    bedrijfsemail: text(company?.email),
    bedrijfstelefoon: text(company?.phone),
    website: text(company?.website),
    datum: formatDateNl(source.today ?? new Date()),
  };

  const values = (client?.custom_fields ?? {}) as Record<string, unknown>;
  for (const def of definitions) {
    tokens[customFieldToken(def.field_key)] = formatCustomValue(values[def.field_key], def.field_type);
  }

  return tokens;
}

/**
 * Standaardterugvalwaarden per token, uit de velddefinities. Losstaand van de
 * waarden zelf, zodat een inline {{veld.x|iets anders}} altijd voorrang heeft.
 */
export function buildMergeFallbacks(definitions: MergeFieldDefinition[] = []): Record<string, string> {
  const fallbacks: Record<string, string> = {};
  for (const def of definitions) {
    const fallback = text(def.default_fallback);
    if (fallback) fallbacks[customFieldToken(def.field_key)] = fallback;
  }
  return fallbacks;
}

// Let op de toegestane tekens: de punt hoort erbij voor {{veld.x}}, en de
// terugvalwaarde na de pijp mag alles behalve een accolade bevatten.
// Elke aanroep krijgt een VERSE regex: een gedeelde /g/-regex draagt zijn
// lastIndex mee tussen aanroepen en slaat dan willekeurig treffers over.
function tokenPattern(): RegExp {
  return /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;
}

/**
 * Vult de tokens in. `escape` bepaalt of de waarde HTML-veilig gemaakt wordt:
 * aan voor de body (HTML), uit voor het onderwerp en de platte-tekstversie.
 *
 * Een onbekend token wordt weggelaten in plaats van letterlijk doorgelaten —
 * een typefout hoort nooit als "{{voornam}}" bij de klant te belanden. De
 * editor waarschuwt er vooraf voor via unknownMergeTokens().
 */
export function fillMergeTokens(
  input: string | null | undefined,
  tokens: Record<string, string>,
  options: { escape?: boolean; fallbacks?: Record<string, string> } = {},
): string {
  const escape = options.escape !== false;
  const fallbacks = options.fallbacks ?? {};
  return String(input ?? '').replace(tokenPattern(), (_match, rawKey: string, inlineFallback?: string) => {
    const key = rawKey.trim();
    const value = (tokens[key] ?? '').trim();
    const resolved = value || (inlineFallback ?? '').trim() || (fallbacks[key] ?? '').trim();
    return escape ? escapeHtml(resolved) : resolved;
  });
}

/** Alle tokens die in de tekst voorkomen (zonder terugvalwaarde), ontdubbeld. */
export function collectMergeTokens(input: string | null | undefined): string[] {
  const found = new Set<string>();
  const haystack = String(input ?? '');
  const pattern = tokenPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(haystack)) !== null) {
    found.add(match[1].trim());
  }
  return [...found];
}

/**
 * Tokens die nergens op slaan — een typefout, of een vrij veld dat inmiddels
 * verwijderd is. Voor de waarschuwing vóór verzending.
 */
export function unknownMergeTokens(input: string | null | undefined, definitions: MergeFieldDefinition[] = []): string[] {
  const known = new Set<string>(STANDARD_TOKEN_KEYS);
  for (const def of definitions) known.add(customFieldToken(def.field_key));
  return collectMergeTokens(input).filter((token) => !known.has(token));
}

// ── Hulpfuncties ────────────────────────────────────────────────────────────

function formatCustomValue(value: unknown, fieldType: string): string {
  if (value === null || value === undefined) return '';

  switch (fieldType) {
    case 'boolean':
      return value === true ? 'Ja' : value === false ? 'Nee' : '';
    case 'amount':
      return typeof value === 'number' && Number.isFinite(value) ? formatAmount(value) : '';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) : '';
    case 'date':
      return formatDateNl(value);
    case 'multiselect':
      return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean).join(', ') : '';
    default:
      return typeof value === 'string' ? value.trim() : String(value);
  }
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function joinAddress(...parts: Array<string | null | undefined>): string {
  const [line1, line2, postalCode, city, country] = parts;
  return [line1, line2, [postalCode, city].map(text).filter(Boolean).join(' '), country]
    .map(text)
    .filter(Boolean)
    .join(', ');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function formatAmount(value: number): string {
  try {
    return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(value);
  } catch {
    return `€ ${value.toFixed(2)}`;
  }
}

function formatNumber(value: number): string {
  try {
    return new Intl.NumberFormat('nl-NL').format(value);
  } catch {
    return String(value);
  }
}

function formatDateNl(value: unknown): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '';
  return date.toLocaleDateString('nl-NL');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
