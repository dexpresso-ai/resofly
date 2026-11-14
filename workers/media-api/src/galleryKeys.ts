// De vorm van een galerijbestand in R2, en welke variant erin staat.
//
// Sinds 14 november 2026:  {org}/gallery/{galerij}/{item}/{variant}-{uuid}/{naam}
// Daarvoor:                {org}/gallery/{galerij}/{item}/{variant}-{uuid}-{naam}
//
// Waarom de naam een eigen laatste deel kreeg: een foto die op de telefoon
// `yes.jpg` heet, stond in R2 als `original-3f2a…-yes.jpg`. Wie hem in de
// browser opende en bewaarde, of in het R2-dashboard keek, zag die naam en
// niet `yes.jpg`. Nu eindigt de sleutel, en dus ook de URL, op `yes.jpg`
// (of `preview-yes.jpg` voor de preview).
//
// Waarom de variant en de uuid er nog in zitten:
// - De variant beslist wie het bestand mag zien: een kijk-token krijgt geen
//   `original` (handleGalleryFile). Daarom komt hij uit een deel dat alleen de
//   worker schrijft, nooit uit de bestandsnaam. Een origineel dat de klant
//   zelf `preview-x.jpg` noemde, blijft zo een origineel.
// - De uuid houdt elke sleutel uniek, zodat de inhoud erachter nooit
//   verandert en de browser hem mag bewaren (immutable).
//
// Oude sleutels blijven geldig; galleryVariantFromKey leest beide vormen.
// src/lib/galleryMedia.ts (keyVariant) doet hetzelfde in de app.

export function galleryObjectKey(parts: {
  organizationId: string;
  galleryId: string;
  itemId: string;
  variant: string;
  uuid: string;
  /** Al opgeschoond (sanitizeFileName): geen schuine strepen, geen spaties. */
  fileName: string;
}): string {
  const { organizationId, galleryId, itemId, variant, uuid, fileName } = parts;
  return `${organizationId}/gallery/${galleryId}/${itemId}/${variant}-${uuid}/${fileName}`;
}

/**
 * De variant van een galerijsleutel: `original`, `master`, `source`, `preview`
 * of `thumb`. Een lege string als er geen te vinden is.
 *
 * Nieuwe vorm (zes delen): de variant staat vooraan in het vijfde deel.
 * Oude vorm (vijf delen): vooraan in de bestandsnaam. Een bestandsnaam bevat
 * nooit een schuine streep (sanitizeFileName haalt het pad eraf), dus het
 * aantal delen zegt welke vorm het is.
 */
export function galleryVariantFromKey(key: string): string {
  const segments = key.split('/');
  const holder = segments.length >= 6 ? segments[4] : segments[segments.length - 1];
  const dash = holder.indexOf('-');
  return dash > 0 ? holder.slice(0, dash) : '';
}
