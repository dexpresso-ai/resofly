import { sanitizeRichText } from '../components/RichTextEditor';

/** A styled span of text within a block. `\n` inside text marks a soft line break. */
export type DocRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean };
export type DocBlockType = 'h1' | 'h2' | 'h3' | 'p' | 'bullet' | 'ordered' | 'task' | 'quote';
export type DocBlock = { type: DocBlockType; runs: DocRun[]; checked?: boolean; depth: number };

type Style = { bold?: boolean; italic?: boolean; underline?: boolean };

const TASK_CHECKBOX_CLASS = 'rf-task-checkbox';
const TASK_LIST_CLASS = 'rf-task-list';

function extractRuns(node: Node, style: Style, runs: DocRun[]): void {
  node.childNodes.forEach(child => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? '';
      if (text) runs.push({ text, ...style });
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (el.classList.contains(TASK_CHECKBOX_CLASS)) return; // decorative
    if (tag === 'br') { runs.push({ text: '\n', ...style }); return; }
    const next: Style = { ...style };
    if (tag === 'strong' || tag === 'b') next.bold = true;
    if (tag === 'em' || tag === 'i') next.italic = true;
    if (tag === 'u') next.underline = true;
    extractRuns(el, next, runs);
  });
}

/** Merge adjacent runs that share styling and drop empties, keeping soft breaks. */
function normalizeRuns(runs: DocRun[]): DocRun[] {
  const merged: DocRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = merged[merged.length - 1];
    if (last && Boolean(last.bold) === Boolean(run.bold) && Boolean(last.italic) === Boolean(run.italic) && Boolean(last.underline) === Boolean(run.underline)) {
      last.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function blockTypeForTag(tag: string): DocBlockType {
  if (tag === 'h2') return 'h1';
  if (tag === 'h3') return 'h2';
  if (tag === 'h4') return 'h3';
  if (tag === 'blockquote') return 'quote';
  return 'p';
}

function walkList(listEl: Element, blocks: DocBlock[], depth: number): void {
  const tag = listEl.tagName.toLowerCase();
  const isTask = listEl.classList.contains(TASK_LIST_CLASS);
  Array.from(listEl.children).forEach(li => {
    if (li.tagName.toLowerCase() !== 'li') return;
    const runs: DocRun[] = [];
    Array.from(li.childNodes).forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const childTag = (node as HTMLElement).tagName.toLowerCase();
        if (childTag === 'ul' || childTag === 'ol') return; // handled via recursion
      }
      extractRuns(node, {}, runs);
    });
    blocks.push({
      type: isTask ? 'task' : tag === 'ol' ? 'ordered' : 'bullet',
      runs: normalizeRuns(runs),
      checked: li.getAttribute('data-checked') === 'true',
      depth,
    });
    Array.from(li.children).forEach(child => {
      const childTag = child.tagName.toLowerCase();
      if (childTag === 'ul' || childTag === 'ol') walkList(child, blocks, depth + 1);
    });
  });
}

function walkBlocks(root: Element, blocks: DocBlock[]): void {
  Array.from(root.children).forEach(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      walkList(el, blocks, 0);
      return;
    }
    if (tag === 'div' && (el.querySelector('ul, ol, p, h2, h3, h4, blockquote'))) {
      walkBlocks(el, blocks); // unwrap structural wrappers
      return;
    }
    const runs: DocRun[] = [];
    extractRuns(el, {}, runs);
    blocks.push({ type: blockTypeForTag(tag), runs: normalizeRuns(runs), depth: 0 });
  });
}

/** Parse the app's sanitized rich-text HTML into a flat, render-agnostic block model. */
export function parseRichTextToBlocks(html: string | null | undefined): DocBlock[] {
  const safe = sanitizeRichText(html);
  if (!safe || typeof DOMParser === 'undefined') return [];
  const parsed = new DOMParser().parseFromString(`<div>${safe}</div>`, 'text/html');
  const root = parsed.body.firstElementChild ?? parsed.body;
  const blocks: DocBlock[] = [];
  walkBlocks(root, blocks);
  return blocks;
}

/** Plain concatenated text of a block (soft breaks become spaces), for empty checks. */
export function blockText(block: DocBlock): string {
  return block.runs.map(r => r.text).join('').replace(/\n/g, ' ').trim();
}
