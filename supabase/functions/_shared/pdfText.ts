/**
 * Tekst voor de PDF's die met pdf-lib en Helvetica worden getekend (contract,
 * offerte, factuur, creditnota, rapporten).
 *
 * Puur: geen pdf-lib, geen Deno. Getest in pdfText.test.ts.
 */

const LATIN1 = /^[\x20-\x7e\xa0-\xff]+$/;
const TRANSLITERATION: Record<string, string> = {
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h',
  'Œ': 'OE', 'œ': 'oe', 'Ŋ': 'N', 'ŋ': 'n', 'Ŧ': 'T', 'ŧ': 't',
};

/**
 * WinAnsi-filter. Alles buiten 32-126 en 160-255 kan Helvetica hier niet
 * tekenen; wat te vertalen is wordt vertaald, de rest wordt een vraagteken.
 *
 * Waarom: de contract-, offerte- en factuur-PDF gooiden elk teken buiten
 * Latin-1 stil weg. "Łukasz Dvořák" werd "ukasz Dvoák" op de handtekening- en
 * bewijspagina van een getekend contract, en "Boete ≤ € 500" werd "Boete  EUR
 * 500". reportPdf.ts deed het al goed; dit is die versie, nu gedeeld.
 */
export function normalizePdfText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/€/g, 'EUR')
    .replace(/≤/g, '<=')
    .replace(/≥/g, '>=')
    .replace(/[→⇒]/g, '->')
    .replace(/[✓✔]/g, 'v')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Letters buiten Latin-1 worden eerst ontdaan van hun diakriet (NFD splitst
    // ě in e + combining caron, de tweede valt weg); "Vaněk" wordt zo "Vanek".
    .split('')
    .map((char) => {
      const code = char.charCodeAt(0);
      if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255)) return char;
      const stripped = char.normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (stripped && LATIN1.test(stripped)) return stripped;
      if (TRANSLITERATION[char]) return TRANSLITERATION[char];
      // Wat er dan nog overblijft is niet te tekenen. Een vraagteken valt op en
      // is te corrigeren; stil weglaten niet.
      return '?';
    })
    .join('')
    .replace(/\?{2,}/g, '?')
    .trim();
}

export type PdfBlockType = 'h2' | 'h3' | 'h4' | 'p' | 'li' | 'quote';
export type PdfBlock = { type: PdfBlockType; text: string; depth?: number };

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", euro: '€',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', deg: '°', para: '¶', sect: '§',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'section', 'article', 'header', 'footer', 'hr', 'pre']);

/**
 * Rich-text (al gesanitizede HTML) naar blokken voor de PDF, zonder iets weg te
 * laten wat de klant op de pagina ziet.
 *
 * Waarom: de vorige versie pakte alleen h2-h4, p, blockquote en ul/ol. Stond er
 * één zo'n blok in, dan verdween de rest: <div>-regels (wat de editor maakt na
 * Enter), losse tekst, h1/h5/h6, tabellen en lijstitems na een geneste lijst.
 * Een contract met "<h2>Artikel 1</h2><div>De prijs is € 1.000 per maand.</div>"
 * gaf een PDF met alleen "Artikel 1" — ook het getekende exemplaar.
 */
export function htmlToPdfBlocks(value: unknown): PdfBlock[] {
  const src = String(value ?? '');
  if (!src.trim()) return [];
  if (!/<[a-z!/]/i.test(src)) {
    return src.replace(/\r\n/g, '\n').split(/\n{2,}/)
      .map((t) => ({ type: 'p' as const, text: decodeEntities(t).replace(/\s+/g, ' ').trim() }))
      .filter((b) => b.text);
  }

  const out: PdfBlock[] = [];
  const lists: Array<{ ordered: boolean; counter: number }> = [];
  const context: PdfBlockType[] = [];
  let buffer = '';
  let currentType: PdfBlockType = 'p';
  let liPrefix = '';
  let skipDepth = 0; // binnen <script>/<style>/<head>: niets tonen
  let rowCells: string[] | null = null;

  const typeFromStack = (): PdfBlockType => {
    for (let i = context.length - 1; i >= 0; i -= 1) if (context[i] !== 'p') return context[i];
    return 'p';
  };
  const flush = () => {
    const text = decodeEntities(buffer).replace(/\s+/g, ' ').trim();
    buffer = '';
    if (rowCells) { if (text) rowCells.push(text); return; }
    if (!text) return;
    if (currentType === 'li') {
      out.push({ type: 'li', text: `${liPrefix}${text}`, depth: Math.max(0, lists.length - 1) });
      liPrefix = ''; // een vervolgregel van hetzelfde item krijgt geen nieuw teken
    } else {
      out.push({ type: currentType, text });
    }
  };

  const tagRe = /<!--[\s\S]*?-->|<\/?([a-z][a-z0-9]*)\b[^>]*>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    if (skipDepth === 0) buffer += src.slice(last, m.index);
    last = tagRe.lastIndex;
    const raw = m[0];
    const name = (m[1] || '').toLowerCase();
    if (!name) continue; // commentaar
    const closing = raw.startsWith('</');
    if (name === 'script' || name === 'style' || name === 'head' || name === 'title') {
      skipDepth = Math.max(0, skipDepth + (closing ? -1 : 1));
      continue;
    }
    if (skipDepth > 0) continue;
    if (name === 'br') { flush(); continue; }
    if (!BLOCK_TAGS.has(name)) {
      // Inline: een cel of spatie-scheiding binnen dezelfde regel.
      if (name === 'td' || name === 'th') flush();
      continue;
    }

    flush();
    if (name === 'ul' || name === 'ol') {
      if (closing) lists.pop(); else lists.push({ ordered: name === 'ol', counter: 0 });
    } else if (name === 'li') {
      if (closing) {
        context.pop();
      } else {
        const list = lists[lists.length - 1];
        if (list) list.counter += 1;
        liPrefix = list?.ordered ? `${list.counter}. ` : '•  ';
        context.push('li');
      }
    } else if (name === 'tr') {
      if (closing) {
        const cells = rowCells ?? [];
        rowCells = null;
        if (cells.length) out.push({ type: 'p', text: cells.join(' | ') });
      } else {
        rowCells = [];
      }
    } else if (name === 'hr') {
      // Een scheidingslijn: niets te tekenen als tekst.
    } else {
      const mapped: PdfBlockType =
        name === 'h1' || name === 'h2' ? 'h2'
          : name === 'h3' ? 'h3'
            : name === 'h4' || name === 'h5' || name === 'h6' ? 'h4'
              : name === 'blockquote' ? 'quote'
                : 'p';
      if (closing) context.pop(); else context.push(mapped);
    }
    currentType = typeFromStack();
  }
  if (skipDepth === 0) buffer += src.slice(last);
  if (rowCells) {
    flush();
    const cells: string[] = rowCells;
    rowCells = null;
    if (cells.length) out.push({ type: 'p', text: cells.join(' | ') });
  }
  flush();
  return out;
}
