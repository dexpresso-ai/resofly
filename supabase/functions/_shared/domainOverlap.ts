// ============================================================
// Verzenddomeinen: wanneer botsen twee domeinen?
//
// Puur, zonder imports, zodat `npm test` er rechtstreeks overheen draait
// (domainOverlap.test.ts). De mail-functie gebruikt het bij "domein koppelen".
//
// Alle organisaties delen één Resend-account. Een domein mag daarom maar bij
// één organisatie horen, en ook geen subdomein of bovenliggend domein van een
// domein van een andere organisatie zijn. Anders kan de ene klant het domein
// van de andere bezetten, of mail versturen namens diens subdomein. Het domein
// van de platform-afzender (RESEND_FROM_EMAIL) is van niemand.
// ============================================================

/** `Mail.Example.nl.` → `mail.example.nl`. */
export function normalizeDomainName(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
}

/** `a.b.example.nl` → `['b.example.nl', 'example.nl']`. De TLD zelf telt niet mee. */
export function domainParents(domain: string): string[] {
  const labels = normalizeDomainName(domain).split('.').filter(Boolean);
  const parents: string[] = [];
  for (let i = 1; i < labels.length - 1; i += 1) parents.push(labels.slice(i).join('.'));
  return parents;
}

/** Hetzelfde domein, of het ene is een subdomein van het andere. */
export function domainsOverlap(a: string, b: string): boolean {
  const x = normalizeDomainName(a);
  const y = normalizeDomainName(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/** Het domein achter een afzender als `ResoFly <no-reply@mail.resofly.com>`, of null. */
export function senderDomain(fromEmail: string): string | null {
  const match = String(fromEmail || '').match(/@([a-z0-9.-]+)>?\s*$/i);
  return match ? normalizeDomainName(match[1]) : null;
}
