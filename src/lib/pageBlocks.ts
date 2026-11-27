// ============================================================
// Het blokmenu van een pagina (stap 1A-4a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md).
//
// Eén lijst voor twee ingangen: `/` in de tekst en de +-knop in de werkbalk
// (op een telefoon typ je niet makkelijk een schuine streep). Zonder Tiptap,
// zodat zoeken op woorden in Node te toetsen is (pageBlocks.test.ts). Wat een
// blok doet, staat in src/features/PageBlockMenu.tsx.
// ============================================================

export type PageBlockKey =
  | 'tekst' | 'kop1' | 'kop2' | 'kop3'
  | 'opsomming' | 'nummering' | 'takenlijst'
  | 'tabel' | 'callout' | 'uitklapper' | 'inhoudsopgave' | 'subpagina'
  | 'citaat' | 'code' | 'scheidingslijn';

export type PageBlock = {
  key: PageBlockKey;
  label: string;
  /** Eén regel uitleg onder de naam. */
  hint: string;
  /** Andere woorden waarop je het vindt, ook de Engelse uit andere programma's. */
  words: string[];
};

export const PAGE_BLOCKS: readonly PageBlock[] = [
  { key: 'tekst', label: 'Tekst', hint: 'Een gewone alinea', words: ['alinea', 'paragraaf', 'text'] },
  { key: 'kop1', label: 'Kop 1', hint: 'Een grote kop', words: ['h1', 'titel', 'heading'] },
  { key: 'kop2', label: 'Kop 2', hint: 'Een middelgrote kop', words: ['h2', 'heading'] },
  { key: 'kop3', label: 'Kop 3', hint: 'Een kleine kop', words: ['h3', 'heading'] },
  { key: 'opsomming', label: 'Opsomming', hint: 'Een lijst met bolletjes', words: ['lijst', 'bolletjes', 'bullet'] },
  { key: 'nummering', label: 'Nummering', hint: 'Een genummerde lijst', words: ['lijst', 'nummers', 'genummerd', 'numbered'] },
  { key: 'takenlijst', label: 'Takenlijst', hint: 'Taken om af te vinken', words: ['taken', 'afvinken', 'todo', 'checklist'] },
  { key: 'tabel', label: 'Tabel', hint: 'Rijen en kolommen, met een kopregel', words: ['raster', 'excel', 'table'] },
  { key: 'callout', label: 'Callout', hint: 'Een kader dat opvalt: info, tip, let op', words: ['kader', 'opmerking', 'let op', 'tip', 'info', 'waarschuwing'] },
  { key: 'uitklapper', label: 'Uitklapper', hint: 'Tekst die je in- en uitklapt', words: ['inklappen', 'uitklappen', 'toggle', 'details'] },
  { key: 'inhoudsopgave', label: 'Inhoudsopgave', hint: 'Een lijst van de koppen op deze pagina', words: ['inhoud', 'overzicht', 'toc'] },
  { key: 'subpagina', label: 'Subpagina', hint: 'Een nieuwe pagina onder deze', words: ['pagina', 'onderliggend', 'subpage', 'page'] },
  { key: 'citaat', label: 'Citaat', hint: 'Een aanhaling', words: ['aanhaling', 'quote'] },
  { key: 'code', label: 'Code', hint: 'Code of tekst die precies zo blijft staan', words: ['codeblok', 'pre'] },
  { key: 'scheidingslijn', label: 'Scheidingslijn', hint: 'Een lijn tussen twee stukken', words: ['lijn', 'streep', 'divider'] },
];

/** Kleine letters, zonder accenten en dubbele spaties. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * De blokken bij wat iemand na `/` typt, de beste eerst: de naam begint ermee,
 * de naam bevat het, een ander woord begint ermee, een ander woord bevat het.
 * Leeg: alles, in de vaste volgorde.
 */
export function filterPageBlocks(query: string, blocks: readonly PageBlock[] = PAGE_BLOCKS): PageBlock[] {
  const q = normalize(query);
  if (!q) return [...blocks];
  // Na `/` typ je geen spatie (dan sluit het menu): /kop2 hoort Kop 2 te vinden.
  const compact = q.replace(/ /g, '');
  const scored: Array<{ block: PageBlock; score: number; index: number }> = [];
  blocks.forEach((block, index) => {
    const label = normalize(block.label);
    const words = block.words.map(normalize);
    const score = label.startsWith(q) || label.replace(/ /g, '').startsWith(compact) ? 0
      : label.includes(q) ? 1
        : words.some(word => word.startsWith(q)) ? 2
          : words.some(word => word.includes(q)) ? 3
            : -1;
    if (score >= 0) scored.push({ block, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map(entry => entry.block);
}
