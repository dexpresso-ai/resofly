// Welk adres een link naar een klantpagina krijgt die de app zelf toont of
// kopieert: de deellink van een album, het portaal bij Huisstijl. Uit het
// overzicht van de edge function client-domains, zodat het dezelfde link is
// als in de mail aan de klant. Puur, voor de test (clientAddress.test.ts); de
// hooks staan in src/services/domainService.ts.
//
// Waarom de server het zegt en niet de app: een link hoort bij de organisatie,
// nooit bij het adres waar de app toevallig draait (harde regel 1, en
// _shared/clientLinks.ts). Tot het overzicht binnen is, en als het niet lukt,
// het adres van de app: daar werkt elke link altijd.

export interface ClientAddressPart {
  /** Zonder schuine streep aan het eind. */
  baseUrl: string;
  /** Het klantadres (jansen.resofly.com, een eigen domein), niet dat van de app. */
  onClientHost: boolean;
}

export interface ClientAddress extends ClientAddressPart {
  /** Voor het portaal: het eigen domein als het daar aan staat, anders de naam bij ResoFly. */
  portal: ClientAddressPart;
  /**
   * Voor de deellink van een album (/gallerij/<token>). Met
   * CLIENT_DOMAINS_LIVE=albums al op het klantadres, ook als de rest nog naar
   * het adres van de app gaat.
   */
  albums: ClientAddressPart;
}

/** Wat het overzicht van client-domains hiervoor geeft. Een oudere functie kent niet alle velden. */
export interface ClientAddressSource {
  clientUrl?: string | null;
  onClientHost?: boolean | null;
  portalUrl?: string | null;
  portalOnClientHost?: boolean | null;
  albumUrl?: string | null;
  albumOnClientHost?: boolean | null;
}

/**
 * Een adres uit het overzicht, of `fallback`. Alleen een http(s)-adres telt:
 * wat er ook binnenkomt, een link begint nooit met javascript: of iets anders
 * wat de browser zou uitvoeren in plaats van openen.
 */
function part(url: string | null | undefined, onClientHost: boolean | null | undefined, fallback: string): ClientAddressPart {
  const value = String(url ?? '').trim().replace(/\/+$/, '');
  if (!value) return { baseUrl: fallback, onClientHost: false };
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
      return { baseUrl: fallback, onClientHost: false };
    }
  } catch {
    return { baseUrl: fallback, onClientHost: false };
  }
  return { baseUrl: value, onClientHost: onClientHost === true };
}

export function clientAddressFrom(overview: ClientAddressSource | null | undefined, fallback: string): ClientAddress {
  const base = String(fallback ?? '').replace(/\/+$/, '');
  const documents = part(overview?.clientUrl, overview?.onClientHost, base);
  return {
    ...documents,
    portal: part(overview?.portalUrl, overview?.portalOnClientHost, base),
    // Een functie van vóór albumUrl: hetzelfde adres als de documenten, zoals voorheen.
    albums: overview?.albumUrl ? part(overview.albumUrl, overview.albumOnClientHost, base) : { ...documents },
  };
}

/** De deellink van een album: <adres>/gallerij/<token>. */
export function galleryShareUrl(baseUrl: string, token: string): string {
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}/gallerij/${encodeURIComponent(token)}`;
}
