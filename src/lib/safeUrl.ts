// Links die uit opgeslagen gegevens komen (vergaderlink, agenda-link, betaallink).
//
// React zet elke waarde in href, ook een javascript:-URL. Die velden kan een
// teamlid via de database-API zelf vullen; zonder deze check was dat een
// scriptlink die collega's of publieke bezoekers aanklikken. Nu houdt alleen de
// CSP dat tegen — dit is het eerste slot.

/** De URL als hij een geldige http(s)-URL is, anders null. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Betaallink: alleen https op mollie.com (of een subdomein), of dezelfde origin (testmodus). */
export function safeCheckoutUrl(value: unknown, sameOrigin?: string): string | null {
  const href = safeHttpUrl(value);
  if (!href) return null;
  const url = new URL(href);
  if (sameOrigin && url.origin === sameOrigin) return href;
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return host === 'mollie.com' || host.endsWith('.mollie.com') ? href : null;
}
