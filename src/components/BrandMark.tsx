/**
 * Het R-merkteken van ResoFly, nagetekend uit het app-icoon
 * (public/icons/icon-512.png) op hetzelfde raster van 512: de stam, de boog
 * die bovenaan voorbij de stam uitsteekt (de inkeping), de smalle spleet
 * tussen stam en boog, en het been dat schuin wegloopt en recht wordt
 * afgesneden met een afgeronde hoek.
 *
 * Het teken staat op het volle raster van het icoon (viewBox 0 0 512 512).
 * Een tegel die er de hele maat van geeft, ziet er dus precies zo uit als het
 * app-icoon op een telefoon: dezelfde R, op dezelfde plek, even groot.
 *
 * Waarom geen letter: de tegel droeg tot nu toe een "R" in Poppins. Dat is een
 * andere R dan die van het merk (geen inkeping, geen schuin been), en naast
 * het app-icoon zag je het verschil.
 *
 * De kleur komt van `currentColor`: de tegel bepaalt de kleur van de R.
 */
export const BRAND_MARK_PATH =
  'M142 117H202V395H142Z' +
  'M172 97A94 94 0 0 1 172 285L172 224A33 33 0 0 0 172 158Z' +
  'M200 237L361 383V401A12 12 0 0 1 349 413H307L180 297Z';

export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={BRAND_MARK_PATH} />
    </svg>
  );
}
