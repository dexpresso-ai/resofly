/**
 * De R van het logo van ResoFly.
 *
 * Nagetekend uit het logobestand van 12 november 2026, op het raster van de
 * tegel (512; de tegel loopt van 0 tot 512). De R bestaat uit een stam en een
 * balk die samen één hoek vormen, een ronde boog met een open teller, en een
 * been dat schuin wegloopt tot de onderrand van de tegel. Tussen stam en been
 * zit een open spleet: de teller loopt daar naar beneden uit. Overgetrokken op
 * het origineel valt 99,6% samen; het verschil is een haarlijn aan de
 * buitenkant van de boog.
 *
 * Het teken vult de tegel waar het in staat (`.brand-icon`, `.zrail-logo`,
 * `.onb-brand-tile`); die tegel geeft de oranje kleur (BRAND_TILE_COLOR), de
 * vorm en de gloed. De kleur van de R komt van `currentColor`.
 *
 * `border-radius: inherit`: het been loopt tot de onderrand, en de tegels
 * hebben ronde hoeken. Zonder deze regel stak de rechteronderhoek van het been
 * buiten de ronde hoek van de tegel uit, als een zwart puntje naast de tegel.
 * Nu knipt de hoek van de tegel het been af, net als de rand in het logo.
 *
 * De iconen voor op een telefoon of computer (public/icons/) tekent
 * scripts/app-iconen.mjs uit precies deze waarden.
 */

/** De oranje kleur van de tegel, uit het logobestand gemeten. */
export const BRAND_TILE_COLOR = '#FFBD59';
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
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      style={{ borderRadius: 'inherit' }}
    >
      <path d={BRAND_MARK_PATH} />
    </svg>
  );
}
