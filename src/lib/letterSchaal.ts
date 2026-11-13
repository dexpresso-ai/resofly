/**
 * Lettergrootte van de werkruimte (2026-11-13)
 *
 * De PO vond de letters overal wat groot, zeker op de telefoon: de agenda gaf
 * meer overzicht. De stijlbladen hebben ruim 2.400 vaste lettergroottes in px.
 * Die met de hand verkleinen kost een diff van duizenden regels, en elke
 * nieuwe regel zou het weer vergeten.
 *
 * Daarom vermenigvuldigt de bouwstap (een PostCSS-plugin in vite.config.ts)
 * elke lettergrootte met `var(--letter, 1)`. Zo staat de schaal op één plek
 * (globals.css, sectie "Lettergrootte"):
 *   - in de werkruimte .95, op de telefoon .9;
 *   - in de agenda en het tijdrooster 1, want dat was het voorbeeld;
 *   - buiten de werkruimte (portaal, publieke pagina's, inloggen) is de
 *     variabele er niet en blijft alles 1.
 *
 * Wat niet meekrimpt, en waarom:
 *   - tekst van 10px of kleiner, en niets gaat onder de 10px: kleiner is
 *     niet meer te lezen;
 *   - een invoerveld van 16px of meer. Onder de 16px zoomt iOS het hele
 *     scherm in zodra je het veld aanraakt (zie globals.css, "Invoervelden
 *     op 16px");
 *   - em en %: die volgen hun ouder al. clamp(), var() en andere functies
 *     laten we staan: daar is de maat bewust gekozen;
 *   - printregels.
 */

export const LETTER_VAR = '--letter';
/** Hieronder krimpt geen tekst. Tekst die al zo klein is, blijft zoals hij is. */
export const LETTER_FLOOR_PX = 10;
/** iOS zoomt in bij een veld met een kleinere letter dan dit. */
export const FIELD_MIN_PX = 16;

const ROOT_PX = 16;
const SIZE = /^(\d*\.?\d+)(px|rem)$/;
// De lettergrootte in `font`: het eerste getal met px of rem dat los staat
// (niet binnen clamp(…)), met een regelhoogte of de letterfamilie erachter.
const FONT_SIZE_TOKEN = /(^|\s)(\d*\.?\d+(?:px|rem))(?=\/|\s)/;
// Een invoerveld: een input, textarea of select als element, iets bewerkbaars,
// of een klasse die zichzelf zo noemt (.form-input, .tmc-input, .select-trigger).
const FIELD_SELECTOR = /(^|[\s>+~,(])(input|textarea|select)\b|\[contenteditable|\.(form-(input|textarea|select)|select-trigger)\b|-input\b/;

function toPx(token: string): number | null {
  const m = SIZE.exec(token);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'rem' ? ROOT_PX : 1);
}

/** De geschaalde maat voor één lettergrootte, of null als hij blijft staan. */
export function scaleSize(token: string): string | null {
  const px = toPx(token.trim());
  if (px == null || px <= LETTER_FLOOR_PX) return null;
  return `max(${LETTER_FLOOR_PX}px, calc(${token.trim()} * var(${LETTER_VAR}, 1)))`;
}

export type FontDecl = { prop: string; value: string; selector?: string; inPrint?: boolean };

/** De nieuwe waarde voor `font-size` of `font`, of null als er niets verandert. */
export function scaleFontDecl({ prop, value, selector = '', inPrint = false }: FontDecl): string | null {
  if (inPrint) return null;
  if (prop === 'font-size') {
    const px = toPx(value.trim());
    if (px != null && px >= FIELD_MIN_PX && FIELD_SELECTOR.test(selector)) return null;
    return scaleSize(value);
  }
  if (prop === 'font') {
    const m = FONT_SIZE_TOKEN.exec(value);
    if (!m) return null;
    const px = toPx(m[2]);
    if (px != null && px >= FIELD_MIN_PX && FIELD_SELECTOR.test(selector)) return null;
    const scaled = scaleSize(m[2]);
    if (!scaled) return null;
    const at = m.index + m[1].length;
    return value.slice(0, at) + scaled + value.slice(at + m[2].length);
  }
  return null;
}

// Net genoeg van PostCSS om de boom te lopen; postcss zelf is een afhankelijkheid
// van Vite, niet van de app.
type CssNode = { type: string; name?: string; params?: string; selector?: string; parent?: CssNode };
type CssDecl = CssNode & { prop: string; value: string };
type CssRoot = { source?: { input?: { file?: string } }; walkDecls: (fn: (decl: CssDecl) => void) => void };

function context(decl: CssDecl): { selector: string; inPrint: boolean } {
  let selector = '';
  let inPrint = false;
  for (let node = decl.parent; node; node = node.parent) {
    if (node.type === 'rule' && !selector) selector = node.selector ?? '';
    if (node.type === 'atrule' && node.name === 'media' && /\bprint\b/.test(node.params ?? '')) inPrint = true;
  }
  return { selector, inPrint };
}

/** De PostCSS-plugin voor vite.config.ts. */
export function letterSchaal() {
  return {
    postcssPlugin: 'resofly-letterschaal',
    Once(root: CssRoot) {
      if ((root.source?.input?.file ?? '').includes('node_modules')) return;
      root.walkDecls(decl => {
        if (decl.prop !== 'font-size' && decl.prop !== 'font') return;
        const next = scaleFontDecl({ prop: decl.prop, value: decl.value, ...context(decl) });
        if (next) decl.value = next;
      });
    },
  };
}
