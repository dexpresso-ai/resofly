// Opmaak van teamchatberichten — de markdown die Teams ook verstaat.
//
// Een bericht blijft platte tekst in de database (de pushmelding, de zoekfunctie
// en de ongelezen-teller lezen het zo), en wordt pas bij het tonen opgemaakt:
//
//   **vet**  _cursief_ of *cursief*  ~~doorgehaald~~  `code`
//   ```codeblok```   > citaat   - opsomming   1. genummerd
//   [tekst](https://…)   kale links (https://… of www.…)   @Naam
//
// De parser levert een kleine boom op; de React-kant (teamchat/format.tsx)
// zet die om in elementen. Er komt nooit HTML uit een bericht in de pagina, en
// een link is altijd http(s) — een javascript:-link blijft gewone tekst.

export type ChatInline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i' | 's'; c: ChatInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: ChatInline[] }
  | { t: 'mention'; name: string }
  | { t: 'br' };

export type ChatBlock =
  | { t: 'p'; c: ChatInline[] }
  | { t: 'quote'; c: ChatBlock[] }
  | { t: 'ul'; items: ChatInline[][] }
  | { t: 'ol'; start: number; items: ChatInline[][] }
  | { t: 'pre'; v: string };

const FENCE = /^\s*```/;
const FENCE_END = /^\s*```\s*$/;
const QUOTE = /^>\s?/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d{1,3})[.)]\s+(.*)$/;

/** Blokken (alinea's, citaten, lijsten, codeblokken) met de inline-opmaak erin. */
export function parseChatText(text: string, mentionNames: string[] = []): ChatBlock[] {
  const names = [...new Set(mentionNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  return parseBlocks(text.replace(/\r\n?/g, '\n'), names, 0);
}

function parseBlocks(text: string, names: string[], depth: number): ChatBlock[] {
  const lines = text.split('\n');
  const blocks: ChatBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ t: 'p', c: parseInline(para.join('\n'), names) });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flush();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_END.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({ t: 'pre', v: code.join('\n') });
      continue;
    }

    if (QUOTE.test(line) && depth < 3) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'quote', c: parseBlocks(quoted.join('\n'), names, depth + 1) });
      continue;
    }

    if (BULLET.test(line)) {
      flush();
      const items: ChatInline[][] = [];
      while (i < lines.length) {
        const m = BULLET.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[1], names));
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'ul', items });
      continue;
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      flush();
      const items: ChatInline[][] = [];
      const start = Number(numbered[1]) || 1;
      while (i < lines.length) {
        const m = NUMBERED.exec(lines[i]);
        if (!m) break;
        items.push(parseInline(m[2], names));
        i += 1;
      }
      i -= 1;
      blocks.push({ t: 'ol', start, items });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

const WORD = /[\p{L}\p{N}]/u;
const isWord = (ch: string | undefined) => !!ch && WORD.test(ch);
const isSpace = (ch: string | undefined) => !ch || /\s/.test(ch);
/** Mag hier een link of vermelding beginnen? Na een spatie, aan het begin of na een haakje/aanhalingsteken. */
const isOpenBoundary = (ch: string | undefined) => !ch || /[\s([{"'“‘]/.test(ch);

const URL_AT = /^(?:https?:\/\/|www\.)[^\s<>"]+/i;
const MD_LINK_AT = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/i;

/** Een link op deze plek, zonder de leestekens die er in een zin achter staan. */
function readUrl(src: string, i: number): { raw: string; href: string } | null {
  const m = URL_AT.exec(src.slice(i));
  if (!m) return null;
  let raw = m[0];
  // Leestekens aan het eind horen bij de zin, niet bij de link. Een sluithaakje
  // alleen als er in de link geen openingshaakje voor staat.
  for (;;) {
    const last = raw[raw.length - 1];
    if (/[.,;:!?'"’”]/.test(last)) { raw = raw.slice(0, -1); continue; }
    if (last === ')' && (raw.match(/\(/g)?.length ?? 0) < (raw.match(/\)/g)?.length ?? 0)) { raw = raw.slice(0, -1); continue; }
    break;
  }
  if (raw.length < 5) return null;
  const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
  return safeHref(href) ? { raw, href } : null;
}

function safeHref(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Zoekt de afsluitende markering; null als hij er niet (geldig) is. */
function findClose(src: string, from: number, marker: string): number {
  let at = src.indexOf(marker, from);
  while (at !== -1) {
    // De markering mag niet direct na een spatie staan (dan is het geen afsluiter).
    if (!isSpace(src[at - 1])) return at;
    at = src.indexOf(marker, at + 1);
  }
  return -1;
}

function parseInline(src: string, names: string[]): ChatInline[] {
  const out: ChatInline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const prev = src[i - 1];

    if (ch === '\n') {
      flush();
      out.push({ t: 'br' });
      i += 1;
      continue;
    }

    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (src.startsWith('**', i) && !isSpace(src[i + 2])) {
      const end = findClose(src, i + 2, '**');
      if (end > i + 2) {
        flush();
        out.push({ t: 'b', c: parseInline(src.slice(i + 2, end), names) });
        i = end + 2;
        continue;
      }
    }

    if (src.startsWith('~~', i) && !isSpace(src[i + 2])) {
      const end = findClose(src, i + 2, '~~');
      if (end > i + 2) {
        flush();
        out.push({ t: 's', c: parseInline(src.slice(i + 2, end), names) });
        i = end + 2;
        continue;
      }
    }

    if (ch === '*' && src[i + 1] !== '*' && !isSpace(src[i + 1]) && !isWord(prev)) {
      const end = findClose(src, i + 1, '*');
      if (end > i + 1 && src[end + 1] !== '*' && !isWord(src[end + 1])) {
        flush();
        out.push({ t: 'i', c: parseInline(src.slice(i + 1, end), names) });
        i = end + 1;
        continue;
      }
    }

    // _cursief_ alleen als losse woorden: snake_case_namen blijven heel.
    if (ch === '_' && !isWord(prev) && !isSpace(src[i + 1]) && src[i + 1] !== '_') {
      let end = findClose(src, i + 1, '_');
      while (end !== -1 && isWord(src[end + 1])) end = findClose(src, end + 1, '_');
      if (end > i + 1) {
        flush();
        out.push({ t: 'i', c: parseInline(src.slice(i + 1, end), names) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const m = MD_LINK_AT.exec(src.slice(i));
      if (m && safeHref(m[2])) {
        flush();
        out.push({ t: 'link', href: m[2], c: parseInline(m[1], names) });
        i += m[0].length;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H' || ch === 'w' || ch === 'W') && isOpenBoundary(prev)) {
      const url = readUrl(src, i);
      if (url) {
        flush();
        out.push({ t: 'link', href: url.href, c: [{ t: 'text', v: url.raw }] });
        i += url.raw.length;
        continue;
      }
    }

    if (ch === '@' && isOpenBoundary(prev) && names.length) {
      const rest = src.slice(i + 1);
      const name = names.find((n) => rest.startsWith(n) && !isWord(rest[n.length]));
      if (name) {
        flush();
        out.push({ t: 'mention', name });
        i += 1 + name.length;
        continue;
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Platte tekst van opgemaakte inhoud — voor voorbeeldregels en meldingen. */
export function inlineText(nodes: ChatInline[]): string {
  return nodes.map((n) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'code': return n.v;
      case 'br': return ' ';
      case 'mention': return `@${n.name}`;
      default: return inlineText(n.c);
    }
  }).join('');
}

function blockText(blocks: ChatBlock[]): string {
  return blocks.map((b) => {
    switch (b.t) {
      case 'p': return inlineText(b.c);
      case 'pre': return b.v;
      case 'quote': return blockText(b.c);
      default: return b.items.map(inlineText).join(', ');
    }
  }).join(' ');
}

/** Eén regel zonder opmaaktekens, ingekort — voor de gesprekslijst en meldingen. */
export function plainPreview(text: string, max = 120): string {
  const flat = blockText(parseChatText(text)).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Alle links in een bericht (http/https), in volgorde en zonder dubbele. */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  const walk = (nodes: ChatInline[]) => {
    for (const n of nodes) {
      if (n.t === 'link') found.push(n.href);
      else if (n.t === 'b' || n.t === 'i' || n.t === 's') walk(n.c);
    }
  };
  const walkBlocks = (blocks: ChatBlock[]) => {
    for (const b of blocks) {
      if (b.t === 'p') walk(b.c);
      else if (b.t === 'quote') walkBlocks(b.c);
      else if (b.t === 'ul' || b.t === 'ol') b.items.forEach(walk);
    }
  };
  walkBlocks(parseChatText(text));
  return [...new Set(found)];
}

/**
 * Een bericht van alleen één tot drie emoji — dat toont Teams groot. Cijfers,
 * # en * tellen in Unicode ook als emoji-onderdeel, dus er moet minstens één
 * echt plaatje in zitten.
 */
export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 40) return false;
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(trimmed)) return false;
  if (!/\p{Extended_Pictographic}/u.test(trimmed)) return false;
  const compact = trimmed.replace(/\s+/g, '');
  // Intl.Segmenter telt "👨‍👩‍👧" als één teken; zonder (oude browser) tellen we
  // codepunten zonder de lijmtekens ertussen.
  type Segmenter = { segment: (input: string) => Iterable<unknown> };
  const SegmenterCtor = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: 'grapheme' }) => Segmenter }).Segmenter;
  const count = SegmenterCtor
    ? [...new SegmenterCtor('nl', { granularity: 'grapheme' }).segment(compact)].length
    : [...compact.replace(/[‍️]|[\u{1F3FB}-\u{1F3FF}]/gu, '')].length;
  return count <= 3;
}

/**
 * Opmaak rond de selectie in een tekstvak: geeft de nieuwe tekst en selectie
 * terug. Staat de markering er al omheen, dan gaat hij er weer af.
 */
export function toggleWrap(value: string, start: number, end: number, marker: string, placeholder = 'tekst'): { value: string; start: number; end: number } {
  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  if (before.endsWith(marker) && after.startsWith(marker)) {
    return {
      value: before.slice(0, -marker.length) + selected + after.slice(marker.length),
      start: start - marker.length,
      end: end - marker.length,
    };
  }
  const inner = selected || placeholder;
  return {
    value: `${before}${marker}${inner}${marker}${after}`,
    start: start + marker.length,
    end: start + marker.length + inner.length,
  };
}

/** Zet een voorvoegsel ("- ", "1. ", "> ") voor elke geselecteerde regel, of haalt het weg. */
export function toggleLinePrefix(value: string, start: number, end: number, kind: 'bullet' | 'number' | 'quote'): { value: string; start: number; end: number } {
  const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextBreak = value.indexOf('\n', end);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, lineEnd).split('\n');
  const pattern = kind === 'bullet' ? /^- / : kind === 'number' ? /^\d+\. / : /^> /;
  const allHave = lines.every((l) => pattern.test(l));
  const next = lines.map((l, idx) => {
    if (allHave) return l.replace(pattern, '');
    const prefix = kind === 'bullet' ? '- ' : kind === 'number' ? `${idx + 1}. ` : '> ';
    return prefix + l;
  }).join('\n');
  const result = value.slice(0, lineStart) + next + value.slice(lineEnd);
  return { value: result, start: lineStart, end: lineStart + next.length };
}
