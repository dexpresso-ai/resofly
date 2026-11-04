/**
 * Het Nederlandse btw-identificatienummer: NL, 9 cijfers, de letter B en 2
 * cijfers (bijvoorbeeld NL123456789B01). Sinds 1 januari 2020 heeft een
 * eenmanszaak een apart btw-id voor klanten en leveranciers; het
 * omzetbelastingnummer bevat het BSN en is alleen voor de Belastingdienst. Op
 * facturen hoort het btw-id.
 */

/** Haalt spaties en punten weg en zet in hoofdletters. */
export function normalizeVatId(value: string): string {
  return value.replace(/[\s.]/g, '').toUpperCase();
}

/** Klopt de vorm van een Nederlands btw-id? (Geen controle op het controlecijfer.) */
export function isDutchVatIdFormat(value: string): boolean {
  return /^NL\d{9}B\d{2}$/.test(normalizeVatId(value));
}

/**
 * Lijkt dit op een omzetbelastingnummer zonder landcode (9 cijfers + B + 2
 * cijfers)? Dat hoort niet op een factuur van een eenmanszaak.
 */
export function looksLikeTaxNumberWithoutCountry(value: string): boolean {
  return /^\d{9}B\d{2}$/.test(normalizeVatId(value));
}
