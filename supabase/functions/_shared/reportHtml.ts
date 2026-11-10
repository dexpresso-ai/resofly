// ============================================================
// De HTML van een rapportage: wijzigingen toepassen en nakijken.
//
// Een kleine aanpassing ("maak de grafiek een lijn", "voeg een kolom toe") hoeft
// niet de hele pagina opnieuw: Gerrie stuurt dan zoek/vervang-paren. Dat scheelt
// de gebruiker AI-tegoed, want elk teken dat Gerrie schrijft kost tokens.
//
// Nakijken is een tweede slot. Het eerste is het kader waarin de pagina draait
// (public/rapport-weergave.html): een sandbox zonder eigen herkomst, met een CSP
// zonder netwerk. Wat hier wordt geweigerd, zou daar ook niet werken; door het
// hier al te weigeren krijgt Gerrie een zin terug waarmee hij het meteen goed
// doet, in plaats van een pagina die bij de gebruiker stil leeg blijft.
//
// Puur: reportHtml.test.ts draait er met node overheen.
// ============================================================

export const MAX_HTML_CHARS = 200_000;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Past zoek/vervang-paren toe, in volgorde. Elke zoektekst moet precies één keer
 * voorkomen: twee keer is dubbelzinnig (welke bedoel je?) en nul keer betekent dat
 * Gerrie een oudere versie voor ogen had.
 */
export function applyHtmlEdits(current: string, raw: unknown): Result<string> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '"html_edits" moet een niet-lege lijst zijn.' };
  if (raw.length > 40) return { ok: false, error: 'Hoogstens 40 wijzigingen tegelijk; stuur anders de hele HTML opnieuw.' };
  let html = current;
  for (const [index, item] of raw.entries()) {
    const edit = (item && typeof item === 'object') ? item as Record<string, unknown> : {};
    const find = typeof edit.find === 'string' ? edit.find : '';
    const replace = typeof edit.replace === 'string' ? edit.replace : null;
    if (!find) return { ok: false, error: `Wijziging ${index + 1}: "find" is leeg.` };
    if (replace === null) return { ok: false, error: `Wijziging ${index + 1}: "replace" ontbreekt (gebruik "" om iets weg te halen).` };
    const hits = countOccurrences(html, find);
    if (hits === 0) return { ok: false, error: `Wijziging ${index + 1}: de tekst om te vervangen staat niet (meer) in de HTML. Kopieer hem letterlijk uit de huidige versie, of stuur de hele HTML.` };
    if (hits > 1) return { ok: false, error: `Wijziging ${index + 1}: de tekst om te vervangen staat ${hits} keer in de HTML. Neem er meer omliggende tekst bij, zodat hij uniek is.` };
    html = html.replace(find, () => replace);
  }
  return { ok: true, value: html };
}

const RULES: Array<{ test: RegExp; message: string }> = [
  { test: /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i, message: 'Lever alleen de inhoud van <body> (met eventueel <style> en <script>), zonder <!doctype>, <html>, <head> of <body>.' },
  { test: /<script[^>]*\bsrc\s*=/i, message: 'Geen <script src>: externe scripts worden geblokkeerd. Schrijf je script inline en gebruik de ingebouwde RF-bouwstenen voor grafieken.' },
  { test: /<(link|iframe|frame|object|embed|base|meta|form|portal)\b/i, message: 'Geen <link>, <iframe>, <object>, <embed>, <base>, <meta> of <form>: de rapportage draait zonder internet en zonder formulieren.' },
  { test: /\b(src|href|srcset|action|poster|data)\s*=\s*["']?\s*(https?:)?\/\//i, message: 'Geen afbeeldingen, links of bestanden van internet (http/https): de rapportage draait zonder netwerk. Teken grafieken met RF of inline SVG.' },
  // Ook een adres dat de browser pas zelf rechtzet: "https:\\elders" leest hij als
  // https://elders, en "javascript:" voert uit. Dat glipte langs de regel hierboven.
  { test: /\b(src|href|srcset|action|formaction|poster|data|ping|xlink:href)\s*=\s*["']?\s*(?!data:image\/|#|mailto:|tel:)(?:[a-z][a-z0-9+.-]*:|\\\\|\/\\|\\\/)/i, message: 'Geen adressen met een schema (https:, javascript:, data:) in src, href of action: de rapportage draait zonder netwerk en zonder links naar buiten. Een mailto:- of tel:-link mag wel.' },
  { test: /url\(\s*["']?\s*(https?:)?\/\//i, message: 'Geen url(http…) in CSS: externe bronnen worden geblokkeerd.' },
  { test: /@import\b/i, message: 'Geen @import in CSS: externe stylesheets worden geblokkeerd. De ResoFly-opmaak (rf-klassen en de kleurvariabelen) staat al klaar.' },
  { test: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|importScripts|SharedWorker|Worker)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource|RTCPeerConnection|Worker|SharedWorker)\b|navigator\s*\.\s*sendBeacon/, message: 'Geen netwerkverkeer (fetch, XMLHttpRequest, WebSocket, sendBeacon, workers): alle gegevens staan al klaar in RF.data.' },
  { test: /\b(localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie)\b/, message: 'Geen localStorage, sessionStorage, indexedDB of cookies: de rapportage draait afgeschermd en kan daar niet bij.' },
  // `r.location` (een veld van een agenda-item) is gewoon een gegeven; alleen de
  // echte `location` van het venster telt, en `===` is een vergelijking.
  { test: /\b(window|document|self|top|parent)\s*\.\s*location\b|(?<![.\w$])location\s*(?:\.\s*(?:href|assign|replace)\s*[=(]|=(?!=))|\bwindow\s*\.\s*open\s*\(/, message: 'Niet navigeren of vensters openen (location, window.open): de rapportage blijft op zijn eigen pagina.' },
  { test: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/, message: 'Geen eval of new Function; schrijf de code gewoon uit.' },
];

/**
 * Regels die alleen over SCRIPT gaan: de inhoud van <script> en van on…-attributen.
 *
 * Eerst liepen ze over de hele pagina, en dan was gewone tekst als "btw verlegd
 * bij import (rubriek 4a)" ineens een import(). Tekst op de pagina voert niets
 * uit; alleen het script kan iets opbouwen.
 */
const SCRIPT_RULES: Array<{ test: RegExp; message: string }> = [
  // De regels hierboven lezen letterlijke tekst. `window['fe'+'tch']`, `(0, eval)`
  // en `[].constructor.constructor('…')` deden hetzelfde zonder dat woord: een
  // pagina die zo gegevens naar buiten probeerde te krijgen, kwam erdoor. Een
  // rapportage heeft geen opgebouwde namen op het venster nodig; dus weg ermee.
  // `top` en `parent` staan hier bewust niet in: RF.top() geeft een lijst, en
  // `const top = RF.top(…); top[0]` is gewone code.
  { test: /(?<![.\w$])(window|globalThis|self|document|navigator)\s*\[|\bReflect\s*\.\s*(get|apply|construct|getOwnPropertyDescriptor)\s*\(|\bObject\s*\.\s*(getOwnPropertyNames|getOwnPropertyDescriptors?|entries|values|keys)\s*\(\s*(window|globalThis|self)\b|\bfor\s*\([^)]*\bin\s+(window|globalThis|self)\b/, message: 'Geen opgebouwde namen op window, globalThis, self of document (zoals window[\'…\']) en geen lijst van alles op het venster: schrijf gewoon uit wat je gebruikt, met de RF-bouwstenen.' },
  // `class X { constructor() {} }` en `v.constructor === Object` mogen;
  // `[].constructor.constructor('…')` en `f.constructor('…')` niet.
  { test: /\beval\b|\.\s*constructor\s*(\(|\[|\.\s*constructor\b)|\[\s*['"`]constructor['"`]\s*\]|\bset(Timeout|Interval)\s*\(\s*['"`]|(?<![\w$.])import\s*\(/, message: 'Geen eval, constructor-trucs, setTimeout met een tekst of import(): schrijf de code gewoon uit.' },
  // WebRTC valt buiten de CSP (connect-src): een verbinding met een STUN-adres
  // stuurt gegevens via DNS naar buiten. Een rapportage heeft er niets aan.
  // "stun:" telt alleen als begin van een tekst ('stun:…'); `{turn: 1}` is een veld.
  { test: /\b(RTC[A-Z]\w*|webkitRTC\w*|mozRTC\w*|iceServers|createDataChannel|createOffer|setLocalDescription)\b|['"`](stuns?|turns?):/, message: 'Geen WebRTC (RTCPeerConnection, STUN/TURN): de rapportage maakt geen verbindingen.' },
  { test: /\.\s*(href|src|srcset|action|formAction|ping)\s*=(?!=)|\bsetAttribute(NS)?\s*\(\s*(['"`][^'"`]*['"`]\s*,\s*)?['"`](href|src|srcset|action|formaction|ping|xlink:href|data)['"`]/i, message: 'Zet geen adressen (href, src, action) vanuit script: een rapportage linkt nergens heen en laadt niets.' },
  // Een nieuw frame heeft een eigen, schone set browserfuncties; het kader zelf
  // houdt ze ook tegen (public/rapport-weergave.html), dit is de zin voor Gerrie.
  { test: /\bcreateElement(NS)?\s*\([^)]*['"`](iframe|frame|frameset|object|embed|portal|fencedframe)['"`]|\battachShadow\b|\bdocument\s*\.\s*(write|writeln|open)\s*\(|\bDOMParser\b|\bcreateContextualFragment\b|\bexecCommand\b/i, message: 'Geen frames, objecten, document.write, shadow-DOM of DOMParser: zet inhoud neer met innerHTML of de RF-bouwstenen.' },
];

/** De scriptdelen van een pagina: <script>-blokken en inline event-handlers. */
export function scriptParts(html: string): string {
  const blocks = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)(?:<\/script\s*>|$)/gi)].map((m) => m[1]);
  const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)].map((m) => m[1].replace(/^["']|["']$/g, ''));
  return [...blocks, ...handlers].join('\n');
}

/** Wat er niet klopt aan deze HTML, als zinnen voor Gerrie. Leeg = in orde. */
export function checkReportHtml(html: string): string[] {
  const problems: string[] = [];
  if (!html.trim()) problems.push('De HTML is leeg.');
  if (html.length > MAX_HTML_CHARS) problems.push(`De HTML is te groot (${html.length.toLocaleString('nl-NL')} tekens, hoogstens ${MAX_HTML_CHARS.toLocaleString('nl-NL')}). Laat de RF-bouwstenen het werk doen in plaats van alles uit te schrijven.`);
  for (const rule of RULES) if (rule.test.test(html)) problems.push(rule.message);
  const script = scriptParts(html);
  for (const rule of SCRIPT_RULES) if (rule.test.test(script)) problems.push(rule.message);
  return problems;
}

/**
 * Welke dataset-sleutels de HTML gebruikt (RF.rows('x'), RF.totals('x'),
 * RF.data.x, RF.meta.x, RF.data['x']). Een tikfout in een sleutel geeft anders
 * een lege grafiek die pas de gebruiker opvalt.
 */
export function referencedDatasetKeys(html: string): string[] {
  const keys = new Set<string>();
  const patterns = [
    /RF\s*\.\s*(?:rows|totals|list)\s*\(\s*['"`]([A-Za-z0-9_]+)['"`]/g,
    /RF\s*\.\s*(?:data|meta)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    /RF\s*\.\s*(?:data|meta)\s*\[\s*['"`]([A-Za-z0-9_]+)['"`]\s*\]/g,
  ];
  for (const pattern of patterns) for (const match of html.matchAll(pattern)) keys.add(match[1]);
  return [...keys];
}
