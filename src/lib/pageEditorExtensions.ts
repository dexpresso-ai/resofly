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
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import type { Transaction } from '@tiptap/pm/state';
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
  'table', 'callout', 'details', 'tableOfContents', 'subpage', 'image',
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wat de subpagina nodig heeft van de editor eromheen (PageEditor zet dit in
 * editor.storage.subpage.links). Hier geen database: dit bestand draait ook in
 * Node, voor de test van het schema.
 */
export type PageLinks = {
  /** De titel, of null als de pagina niet (meer) bestaat of je hem niet mag zien. */
  titleOf: (pageId: string) => Promise<string | null>;
  /** Naar een andere pagina; de editor sluit deze eerst netjes (opslaan, versie, claim los). */
  open: (pageId: string) => void;
  /** Een nieuwe pagina onder deze; geeft het id, of null als het niet lukte. */
  create: () => Promise<string | null>;
};

export function pageLinksOf(editor: Editor): PageLinks | null {
  const storage = (editor.storage as unknown as Record<string, { links?: PageLinks | null } | undefined>).subpage;
  return storage?.links ?? null;
}

/**
 * Een subpagina: een verwijzing naar een andere pagina, met haar titel. De
 * titel staat niet in body (hij verandert in de andere pagina); het blok haalt
 * hem op. Bestaat de pagina niet meer, of mag je hem niet zien, dan staat er
 * "Pagina niet gevonden" en doet klikken niets.
 */
const subpageView: NodeViewRenderer = ({ editor, node }) => {
  const dom = document.createElement('div');
  dom.className = 'page-subpage';
  dom.setAttribute('data-type', 'subpage');
  dom.contentEditable = 'false';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'page-subpage-link';
  const icon = document.createElement('span');
  icon.className = 'page-subpage-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'page-subpage-title';
  button.append(icon, label);
  dom.append(button);
  let current: string | null = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : null;
  let alive = true;
  let missing = false;
  const load = (pageId: string | null) => {
    const links = pageLinksOf(editor);
    label.textContent = 'Laden…';
    if (!pageId || !links) { label.textContent = 'Pagina'; return; }
    links.titleOf(pageId).then(title => {
      if (!alive || current !== pageId) return;
      missing = title === null;
      dom.classList.toggle('is-missing', missing);
      label.textContent = missing ? 'Pagina niet gevonden' : (title || 'Naamloze pagina');
    }, () => {
      if (alive && current === pageId) label.textContent = 'Pagina';
    });
  };
  load(current);
  button.addEventListener('click', event => {
    event.preventDefault();
    const links = pageLinksOf(editor);
    if (links && current && !missing) links.open(current);
  });
  return {
    dom,
    update: updated => {
      if (updated.type.name !== 'subpage') return false;
      const next = typeof updated.attrs.pageId === 'string' ? updated.attrs.pageId : null;
      if (next !== current) { current = next; load(current); }
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof Element && event.target.closest('button') !== null,
    destroy: () => { alive = false; },
  };
};

export const Subpage = Node.create({
  name: 'subpage',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addStorage() {
    return { links: null as PageLinks | null };
  },
  addAttributes() {
    return {
      pageId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-page-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-page-id': attributes.pageId }),
      },
    };
  },
  parseHTML() {
    // Alleen met een geldig id: anders weigerde de database elke volgende
    // opslag van de pagina, en bleef je werk hangen.
    return [{
      tag: 'div[data-type="subpage"]',
      getAttrs: (element: HTMLElement) => (UUID_PATTERN.test(element.getAttribute('data-page-id') ?? '') ? null : false),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'subpage', class: 'page-subpage' })];
  },
  addNodeView() {
    return subpageView;
  },
});

/**
 * Na een blok zonder tekst hoort de cursor op een tekstregel. Tiptap zette na
 * een scheidingslijn de selectie óp het blok dat erna kwam (een tabel, een
 * callout), en na een inhoudsopgave op de inhoudsopgave zelf: de volgende
 * toets overschreef dan dat blok. prosemirror-tables maakte van zo'n tabel
 * zelfs een selectie van alle cellen.
 */
export function cursorOnText(where: 'na-dit-blok' | 'voor-het-volgende') {
  return ({ tr, dispatch }: { tr: Transaction; dispatch?: unknown }): boolean => {
    if (!dispatch || !(tr.selection instanceof NodeSelection)) return true;
    // Na een inhoudsopgave, subpagina of afbeelding is het geselecteerde blok
    // het nieuwe zelf: erachter verder. Na een lijn is het het blok dáárna: ervoor verder.
    return placeTextCursor(tr, where === 'na-dit-blok' ? tr.selection.to : tr.selection.from);
  };
}

function placeTextCursor(tr: Transaction, pos: number): boolean {
  const paragraph = tr.doc.type.schema.nodes.paragraph;
  const next = tr.doc.resolve(pos).nodeAfter;
  if (next?.isTextblock) {
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  } else {
    tr.insert(pos, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
  }
  return true;
}

/**
 * Wat een afbeelding nodig heeft van de editor eromheen (PageEditor zet dit in
 * editor.storage.image.media).
 */
export type PageMedia = {
  /** Een adres om te tonen (een blob-URL), of null als de afbeelding er niet (meer) is. */
  imageUrl: (attachmentId: string) => Promise<string | null>;
  /** Een bestand bij deze pagina zetten; geeft het id van de bijlage, of null als het niet lukte. */
  upload: (file: File) => Promise<string | null>;
};

export function pageMediaOf(editor: Editor): PageMedia | null {
  const storage = (editor.storage as unknown as Record<string, { media?: PageMedia | null } | undefined>).image;
  return storage?.media ?? null;
}

/** Plaatjes die een browser zelf toont; SVG bewust niet (er kan code in staan). */
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif)$/;

export function imageFilesOf(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(file => IMAGE_TYPES.test(file.type));
}

/** Uploaden en invoegen, op `pos` of waar de cursor staat. Eén voor één, in volgorde. */
export async function insertImages(editor: Editor, files: File[], pos?: number): Promise<void> {
  const media = pageMediaOf(editor);
  if (!media) return;
  let at = pos;
  for (const file of files) {
    const attachmentId = await media.upload(file);
    if (!attachmentId || editor.isDestroyed || !editor.isEditable) return;
    const content = { type: 'image', attrs: { attachmentId, alt: '' } };
    const chain = editor.chain().focus();
    if (typeof at === 'number') chain.insertContentAt(at, content);
    else chain.insertContent(content);
    // De cursor achter de afbeelding, op tekst: bleef de afbeelding
    // geselecteerd, dan verving de volgende toets of het volgende plaatje hem.
    chain.command(cursorOnText('na-dit-blok')).run();
    at = undefined;
  }
}

/**
 * Een afbeelding: een bestand in ResoFly (attachmentId), nooit een adres. Een
 * adres van buiten zou in een klantpagina een volgpixel zijn; de database
 * weigert src (page_body_problem). Het adres om te tonen is een blob-URL die
 * alleen in de weergave leeft, niet in body: anders zou elke opening de pagina
 * wijzigen en opslaan.
 */
const imageView: NodeViewRenderer = ({ editor, node }) => {
  const dom = document.createElement('figure');
  dom.className = 'page-image';
  dom.contentEditable = 'false';
  const img = document.createElement('img');
  img.draggable = false;
  img.alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
  const note = document.createElement('figcaption');
  note.className = 'page-image-note';
  dom.append(img, note);
  let current: string | null = typeof node.attrs.attachmentId === 'string' ? node.attrs.attachmentId : null;
  let alive = true;
  const show = (state: 'laden' | 'klaar' | 'weg' | 'fout', url?: string) => {
    dom.classList.toggle('is-loading', state === 'laden');
    dom.classList.toggle('is-missing', state === 'weg' || state === 'fout');
    note.textContent = state === 'laden' ? 'Afbeelding laden…'
      : state === 'weg' ? 'Afbeelding niet gevonden'
        : state === 'fout' ? 'De afbeelding kon niet worden geladen' : '';
    if (url) img.src = url;
    else img.removeAttribute('src');
  };
  const load = (attachmentId: string | null) => {
    const media = pageMediaOf(editor);
    if (!attachmentId || !media) { show('weg'); return; }
    show('laden');
    media.imageUrl(attachmentId).then(url => {
      if (!alive || current !== attachmentId) return;
      show(url ? 'klaar' : 'weg', url ?? undefined);
    }, () => {
      if (alive && current === attachmentId) show('fout');
    });
  };
  load(current);
  return {
    dom,
    update: updated => {
      if (updated.type.name !== 'image') return false;
      img.alt = typeof updated.attrs.alt === 'string' ? updated.attrs.alt : '';
      const next = typeof updated.attrs.attachmentId === 'string' ? updated.attrs.attachmentId : null;
      if (next !== current) { current = next; load(current); }
      return true;
    },
    ignoreMutation: () => true,
    destroy: () => { alive = false; },
  };
};

export const PageImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addStorage() {
    return { media: null as PageMedia | null };
  },
  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-attachment-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-attachment-id': attributes.attachmentId }),
      },
      alt: {
        default: '',
        parseHTML: (element: HTMLElement) => element.getAttribute('alt') ?? '',
        renderHTML: (attributes: Record<string, unknown>) => ({ alt: typeof attributes.alt === 'string' ? attributes.alt : '' }),
      },
    };
  },
  parseHTML() {
    // Alleen een afbeelding uit ResoFly, met een geldig id. Een geplakt plaatje
    // van buiten (<img src="https://…">) wordt niets: het adres mag niet in de
    // pagina, en zonder bestand weigerde de database elke volgende opslag.
    return [{
      tag: 'img[data-attachment-id]',
      getAttrs: (element: HTMLElement) => (UUID_PATTERN.test(element.getAttribute('data-attachment-id') ?? '') ? null : false),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes, { class: 'page-image' })];
  },
  addNodeView() {
    return imageView;
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
        // Een plaatje plakken of erop slepen: uploaden als bijlage van deze pagina.
        handlePaste: (view, event) => {
          const files = imageFilesOf(event.clipboardData?.files);
          if (files.length === 0 || !view.editable || !pageMediaOf(editor)) return false;
          event.preventDefault();
          void insertImages(editor, files);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const files = imageFilesOf((event as DragEvent).dataTransfer?.files);
          if (files.length === 0 || !view.editable || !pageMediaOf(editor)) return false;
          event.preventDefault();
          const pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
          void insertImages(editor, files, pos);
          return true;
        },
      },
    })];
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
    Subpage,
    PageImage,
    UniqueID.configure({ types: [...PAGE_BLOCKS_WITH_ID] }),
    Placeholder.configure({ placeholder: options.placeholder ?? 'Typ hier, of typ / voor een tabel, callout of ander blok.' }),
  ];
}
