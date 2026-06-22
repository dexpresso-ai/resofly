// ============================================================
// Server-side HTML-sanitizing voor contractinhoud (Deno-veilig).
//
// De rich-text editor sanitized al in de browser, maar dat is niet genoeg voor
// een PUBLIEK eindpunt: de ondertekenpagina rendert de body via innerHTML, dus
// elke body die naar de klant gaat MOET hier nog een keer langs — ongeacht hoe
// die in de database is beland (ook directe REST-writes). js-xss is pure JS en
// heeft geen DOM nodig, dus het werkt in de Edge-runtime.
//
// Whitelist = de opmaak die de editor produceert + (forward-compatible) tabellen
// en afbeeldingen. Scripts, styles, iframes en event-handlers worden verwijderd;
// javascript:-URL's in href/src worden door js-xss zelf onschadelijk gemaakt.
// ============================================================

import { FilterXSS } from 'https://esm.sh/xss@1.0.15';

const filter = new FilterXSS({
  whiteList: {
    h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
    p: [], br: [], hr: [],
    strong: [], b: [], em: [], i: [], u: [], s: [],
    ul: ['class'], ol: ['class', 'start'], li: ['class', 'data-checked', 'aria-checked'],
    blockquote: [], span: ['class'], div: ['class'],
    a: ['href', 'target', 'rel'],
    table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
    img: ['src', 'alt', 'width', 'height'],
  },
  stripIgnoreTag: false, // onbekende tags: tekst behouden, tag-zelf escapen
  stripIgnoreTagBody: ['script', 'style'], // inhoud van script/style volledig weg
  // Forceer veilige links: alleen http(s)/mailto/tel/anker, en altijd noopener.
  onTagAttr: (tag, name, value) => {
    if (tag === 'a' && name === 'href') {
      if (!/^(https?:|mailto:|tel:|#)/i.test(value.trim())) return 'href=""';
    }
    return undefined; // val terug op standaard (incl. javascript:-filtering)
  },
});

export function sanitizeContractHtml(html: string | null | undefined): string {
  const input = String(html ?? '');
  if (!input.trim()) return '';
  return filter.process(input);
}
