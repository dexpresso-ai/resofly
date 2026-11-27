// ============================================================
// Past een opgeslagen pagina in deze editor? (stap 1A-4a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md)
//
// Waarom: Tiptap maakt van inhoud met een blok of opmaak die het niet kent
// stilletjes een lege pagina (createNodeFromContent in @tiptap/core 3.35.1:
// een waarschuwing in de console, verder niets). In een editor die mag
// bewerken, schreef de eerste toetsaanslag die lege pagina dan over de echte
// heen; edit_version hielp niet, want de editor had vers geladen.
// Dat gebeurt zodra de database een blok aanneemt dat deze versie van de app
// niet kent: een tabblad van vóór een update, of een blok uit een latere stap
// (afbeelding, bestand, subpagina, kolommen). De editor kijkt daarom eerst
// hier, en opent een pagina die niet past alleen om te zeggen dat de app
// ververst moet worden.
//
// Ook de maten van tabelcellen worden nagekeken: Tiptap zet colwidth zonder
// controle in een style-attribuut (createColGroup), en de CSP laat plaatjes
// van elk https-adres toe. De database weigert zulke waarden (migratie
// 20261127140000); dit is de tweede grendel, voor wat er al stond.
//
// Zonder Tiptap-import: pageBodyCheck.test.ts draait in Node.
// ============================================================

import type { Schema } from '@tiptap/pm/model';

export type PageBodyFit =
  | { ok: true }
  | { ok: false; unknown: string[]; reason: string };

const CELL_TYPES = new Set(['tableCell', 'tableHeader']);
const MAX_DEPTH = 100;

function isWhole(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Klopt een tabelcel: spans en breedtes alleen als hele getallen. */
function cellAttrsOk(attrs: Record<string, unknown>): boolean {
  if (attrs.colspan != null && !isWhole(attrs.colspan, 1, 1000)) return false;
  if (attrs.rowspan != null && !isWhole(attrs.rowspan, 1, 1000)) return false;
  if (attrs.colwidth != null) {
    if (!Array.isArray(attrs.colwidth)) return false;
    if (!attrs.colwidth.every(width => isWhole(width, 0, 10000))) return false;
  }
  return true;
}

/**
 * Past `body` in `schema`? Zo niet: welke namen deze editor niet kent, en
 * waarom. Een pagina die niet past, mag nooit bewerkbaar worden.
 */
export function pageBodyFit(schema: Schema, body: unknown): PageBodyFit {
  const unknown = new Set<string>();
  let broken: string | null = null;

  const walk = (node: unknown, depth: number) => {
    if (broken) return;
    if (depth > MAX_DEPTH) { broken = 'te diep genest'; return; }
    if (!node || typeof node !== 'object' || Array.isArray(node)) { broken = 'een blok is geen object'; return; }
    const { type, marks, content, attrs } = node as { type?: unknown; marks?: unknown; content?: unknown; attrs?: unknown };
    if (typeof type !== 'string' || !schema.nodes[type]) unknown.add(String(type ?? '(geen type)'));
    if (Array.isArray(marks)) {
      for (const mark of marks) {
        const markType = (mark as { type?: unknown } | null)?.type;
        if (typeof markType !== 'string' || !schema.marks[markType]) unknown.add(`opmaak ${String(markType ?? '(geen type)')}`);
      }
    }
    if (typeof type === 'string' && CELL_TYPES.has(type) && attrs && typeof attrs === 'object' && !cellAttrsOk(attrs as Record<string, unknown>)) {
      broken = 'een tabelcel met een ongeldige maat';
      return;
    }
    if (Array.isArray(content)) for (const child of content) walk(child, depth + 1);
  };
  walk(body, 0);

  if (unknown.size > 0) {
    const names = [...unknown].sort();
    return { ok: false, unknown: names, reason: `onbekend: ${names.join(', ')}` };
  }
  if (broken) return { ok: false, unknown: [], reason: broken };
  if ((body as { type?: unknown }).type !== 'doc') return { ok: false, unknown: [], reason: 'een pagina begint met een document' };
  try {
    // check() kijkt ook of de blokken op hun plek mogen staan (een cel buiten
    // een tabel, een lijst zonder items).
    schema.nodeFromJSON(body).check();
  } catch (error) {
    return { ok: false, unknown: [], reason: (error as Error).message || 'de pagina past niet in de editor' };
  }
  return { ok: true };
}
