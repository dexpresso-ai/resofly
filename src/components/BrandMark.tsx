/**
 * Het logo van ResoFly: een zwarte R op een amberkleurige tegel.
 *
 * Nagetekend uit het logobestand van 12 november 2026, op een raster van 512
 * (de tegel loopt van 0 tot 512). De R bestaat uit een stam en een balk die
 * samen één hoek vormen, een ronde boog met een open teller, en een been dat
 * schuin wegloopt en onderaan door de rand van de tegel wordt afgesneden. Tussen
 * stam en been zit een open spleet: de teller loopt daar naar beneden uit.
 * Overgetrokken op het origineel valt 99,6% samen; het verschil is een haarlijn
 * aan de buitenkant van de boog.
 *
 * Waarom de tegel in het teken zit en niet in de CSS: het been loopt tot de
 * onderrand, en de hoek van de tegel (8,2% van de maat) is veel kleiner dan de
 * hoeken van de tegels in de looks (13 tot 15px op 40px). Met de oude CSS-tegel
 * sneed de ronde hoek een stuk van het been af, en het logo was niet meer het
 * logo. Nu tekent het svg de hele tegel; de tegel eromheen (`.brand-icon`,
 * `.zrail-logo`, `.onb-brand-tile`) geeft alleen nog de maat en de gloed.
 *
 * Zonder `size` vult het teken de tegel waar het in staat.
 *
 * De iconen voor op een telefoon of computer (public/icons/) tekent
 * scripts/app-iconen.mjs uit precies deze waarden.
 */

/** De kleur van de tegel, uit het logobestand gemeten. */
export const BRAND_TILE_COLOR = '#FFBD59';
/** De kleur van de R. */
export const BRAND_INK = '#000000';
/** De hoek van de tegel op het raster van 512. */
export const BRAND_TILE_RADIUS = 42;
/** De R op het raster van 512. */
export const BRAND_MARK_PATH =
  'M88.4 114.8H264.7A106 106 0 0 1 304.1 319.1L423.7 512H335.6L176.5 256H264.7A35.35 35.35 0 0 0 264.7 185.3H158.9V406.1H88.4Z';

export function BrandMark({ size, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size ?? '100%'}
      height={size ?? '100%'}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="512" height="512" rx={BRAND_TILE_RADIUS} fill={BRAND_TILE_COLOR} />
      <path d={BRAND_MARK_PATH} fill={BRAND_INK} />
    </svg>
  );
}
