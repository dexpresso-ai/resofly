// ============================================================
// De extensies van de pagina-editor (stap 1A-3a en 1A-4a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md).
//
// Bewust zonder React: pageEditorExtensions.test.ts bouwt hiermee het schema
// in Node en controleert dat de editor alleen blokken en opmaak kan maken die
// de database aanneemt (public.page_body_allowed, gespiegeld in pageSchema.ts).
// Maakt de editor iets wat daar niet in staat, dan weigert de database het
// opslaan en verliest de gebruiker zijn werk.
//
// Alle pakketten zijn MIT (Tiptap 3.35.1, nagekeken op 27 november 2026;
// extension-table, extension-details en suggestion bij stap 1A-4a).
// extension-details vraagt extension-text-style als peer; die staat erin maar
// wordt niet geregistreerd: de database kent de opmaak textStyle niet.
// ============================================================

import { Extension, Node, mergeAttributes } from '@tiptap/core';
import type { Editor, NodeViewRenderer } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { columnResizing } from '@tiptap/pm/tables';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { UniqueID } from '@tiptap/extension-unique-id';
import { TableKit } from '@tiptap/extension-table';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { calloutVariant, isAllowedPageLink } from './pageSchema.ts';

/** Blokken met een vast id (attrs.id): waar Gerrie straks per blok iets voorstelt. */
export const PAGE_BLOCKS_WITH_ID = [
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule',
  'table', 'callout', 'details', 'tableOfContents',
] as const;

/** De smalste kolom van een tabel, ook bij slepen. */
export const TABLE_CELL_MIN_WIDTH = 60;

/**
 * Een gekleurd kader met een icoon: info, tip, let op, waarschuwing. De soort
 * staat als data-variant op het blok, de stijl hangt eraan (globals.css). Geen
 * vrije kleur of style-attribuut: dat zou een stijl van buiten in de pagina
 * laten (zie de migratie 20261127140000).
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: '(paragraph | bulletList | orderedList | taskList)+',
  defining: true,
  addAttributes() {
    return {
      variant: {
        default: 'info',
        parseHTML: (element: HTMLElement) => calloutVariant(element.getAttribute('data-variant')),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-variant': calloutVariant(attributes.variant) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout', class: 'page-callout' }), 0];
  },
});

type TocItem = { id: string | null; level: number; text: string };

function headingsOf(doc: PmNode): TocItem[] {
  const items: TocItem[] = [];
  doc.descendants(node => {
    if (node.type.name === 'heading') {
      items.push({ id: typeof node.attrs.id === 'string' ? node.attrs.id : null, level: Number(node.attrs.level) || 1, text: node.textContent });
      return false;
    }
    return true;
  });
  return items;
}

/** Spring naar de zoveelste kop (op id, anders op volgorde). */
function scrollToHeading(editor: Editor, item: TocItem, index: number): void {
  let target: number | null = null;
  let seen = 0;
  editor.state.doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name !== 'heading') return true;
    if ((item.id && node.attrs.id === item.id) || (!item.id && seen === index)) target = pos;
    seen += 1;
    return false;
  });
  if (target === null) return;
  const dom = editor.view.nodeDOM(target);
  if (dom instanceof HTMLElement) dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * De inhoudsopgave tekent zichzelf uit de koppen van de pagina. Zonder eigen
 * gegevens: niets om op te slaan, en altijd bij. Gewone DOM in plaats van
 * React, zodat dit bestand in Node blijft werken. De koppen gaan er als tekst
 * in (textContent), nooit als HTML.
 */
const tableOfContentsView: NodeViewRenderer = ({ editor }) => {
  const dom = document.createElement('nav');
  dom.className = 'page-toc';
  dom.setAttribute('data-type', 'table-of-contents');
  dom.setAttribute('aria-label', 'Inhoudsopgave');
  dom.contentEditable = 'false';
  let signature = '';
  const render = () => {
    const items = headingsOf(editor.state.doc);
    const next = JSON.stringify(items);
    if (next === signature) return;
    signature = next;
    const title = document.createElement('p');
    title.className = 'page-toc-title';
    title.textContent = 'Inhoud';
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'page-toc-empty';
      empty.textContent = 'Nog geen koppen. Een kop 1, 2 of 3 komt hier vanzelf bij.';
      dom.replaceChildren(title, empty);
      return;
    }
    const list = document.createElement('ol');
    list.className = 'page-toc-list';
    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = `page-toc-item is-level-${Math.min(3, Math.max(1, item.level))}`;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = item.text.trim() || 'Kop zonder tekst';
      button.addEventListener('click', event => { event.preventDefault(); scrollToHeading(editor, item, index); });
      li.append(button);
      list.append(li);
    });
    dom.replaceChildren(title, list);
  };
  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => { if (transaction.docChanged) render(); };
  render();
  editor.on('transaction', onTransaction);
  return {
    dom,
    // Wij tekenen de inhoud zelf; ProseMirror hoeft daar niets mee.
    ignoreMutation: () => true,
    // Een klik op een kop is een sprong, geen selectie van het blok.
    stopEvent: (event: Event) => event.target instanceof Element && event.target.closest('button') !== null,
    destroy: () => { editor.off('transaction', onTransaction); },
  };
};

export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  parseHTML() {
    return [{ tag: 'nav[data-type="table-of-contents"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-type': 'table-of-contents', class: 'page-toc' })];
  },
  addNodeView() {
    return tableOfContentsView;
  },
});

/**
 * Kolombreedtes slepen. Tiptap zet dit alleen aan als de editor bij het maken
 * al bewerkbaar is (Table.addProseMirrorPlugins in 3.35.1); de onze begint op
 * alleen-lezen tot de claim er is, dus dan kon slepen nooit. Deze plugin staat
 * er altijd; hij kijkt zelf bij elke muisbeweging of de editor bewerkbaar is
 * (view.editable in prosemirror-tables). Prioriteit boven die van de tabel:
 * columnResizing hoort vóór tableEditing te staan.
 */
const PageColumnResizing = Extension.create({
  name: 'pageColumnResizing',
  priority: 101,
  addProseMirrorPlugins() {
    return [columnResizing({ handleWidth: 5, cellMinWidth: TABLE_CELL_MIN_WIDTH, defaultCellMinWidth: TABLE_CELL_MIN_WIDTH, View: null, lastColumnResizable: true })];
  },
});

export function pageEditorExtensions(options: { placeholder?: string } = {}) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      // Links alleen naar wat de database ook aanneemt; javascript: en data:
      // komen er zo niet eens in.
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        protocols: ['mailto', 'tel'],
        isAllowedUri: (url: string) => isAllowedPageLink(url),
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({
      // resizable uit: dat doet PageColumnResizing (zie daar).
      table: { resizable: false, cellMinWidth: TABLE_CELL_MIN_WIDTH, HTMLAttributes: { class: 'page-table' } },
    }),
    PageColumnResizing,
    // Open of dicht is een weergave, geen inhoud (persist uit): anders zou
    // alleen al uitklappen de pagina wijzigen en opslaan.
    Details.configure({
      persist: false,
      HTMLAttributes: { class: 'page-details' },
      renderToggleButton: ({ element, isOpen }: { element: HTMLElement; isOpen: boolean }) => {
        element.setAttribute('aria-label', isOpen ? 'Inklappen' : 'Uitklappen');
      },
    }),
    DetailsSummary,
    DetailsContent,
    Callout,
    TableOfContents,
    UniqueID.configure({ types: [...PAGE_BLOCKS_WITH_ID] }),
    Placeholder.configure({ placeholder: options.placeholder ?? 'Typ hier, of typ / voor een tabel, callout of ander blok.' }),
  ];
}
