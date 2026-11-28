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
import { Fragment, Slice, type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Transaction } from '@tiptap/pm/state';
import { columnResizing } from '@tiptap/pm/tables';
import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { UniqueID } from '@tiptap/extension-unique-id';
import { TableKit } from '@tiptap/extension-table';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { calloutVariant, isAllowedPageLink } from './pageSchema.ts';
import { MENTION_KIND_WORDS, mentionKind, mentionOf, type MentionKind } from '../../supabase/functions/_shared/pageMentions.ts';
import type { MentionCandidate } from './pageMentionSearch.ts';
import { TASK_STATUS_WORDS, type PageTaskLink } from './pageTasks.ts';
import type { TaskStatus } from '../types';

/** Blokken met een vast id (attrs.id): waar Gerrie straks per blok iets voorstelt. */
export const PAGE_BLOCKS_WITH_ID = [
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule',
  'table', 'callout', 'details', 'tableOfContents', 'subpage', 'image', 'fileBlock', 'columns',
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

/**
 * Wat in een kolom mag: gewone blokken. Geen tabel, kolommen, uitklapper,
 * inhoudsopgave of subpagina: die passen niet in een smalle kolom, en Word
 * en PDF zetten kolommen al in een tabel (pageDocx.ts).
 */
export const COLUMN_CONTENT = '(paragraph | heading | bulletList | orderedList | taskList | blockquote | codeBlock | horizontalRule | callout | image | fileBlock)+';

/**
 * Kolommen (stap 2-0): twee of drie naast elkaar, even breed, en op een smal
 * scherm onder elkaar (globals.css). De database, de klantweergave
 * (pageHtml.ts) en de export (pageDocx.ts) kenden ze al sinds 1A-1; alleen de
 * editor kon ze nog niet maken. Isolating: Backspace of Enter aan de rand van
 * een kolom haalt geen tekst over de grens heen.
 */
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,3}',
  defining: true,
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'page-columns' }), 0];
  },
  addKeyboardShortcuts() {
    return { Backspace: ({ editor }) => backspaceInColumns(editor) };
  },
});

export const Column = Node.create({
  name: 'column',
  content: COLUMN_CONTENT,
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'page-column' }), 0];
  },
});

/**
 * Kolommen invoegen, met de cursor in de eerste. Staan de kolommen onderaan,
 * dan komt er een lege regel onder: anders kon je niet meer onder de kolommen
 * verder typen (een kolom houdt Enter binnen zichzelf).
 */
export function insertColumns(count: 2 | 3) {
  return ({ tr, dispatch }: { tr: Transaction; dispatch?: unknown }): boolean => {
    const { schema } = tr.doc.type;
    const columns = schema.nodes.columns.create(null,
      Array.from({ length: count }, () => schema.nodes.column.create(null, schema.nodes.paragraph.create())));
    const { $from } = tr.selection;
    // Alleen op het hoogste niveau: niet in een lijst, citaat of uitklapper.
    if ($from.depth !== 1 || !$from.parent.isTextblock) return false;
    if (!dispatch) return true;
    // Een lege regel wordt de kolommen; anders komen ze eronder.
    const empty = $from.parent.content.size === 0;
    const at = empty ? $from.before(1) : $from.after(1);
    if (empty) tr.replaceWith(at, $from.after(1), columns);
    else tr.insert(at, columns);
    const after = at + columns.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter) tr.insert(after, schema.nodes.paragraph.create());
    tr.setSelection(Selection.near(tr.doc.resolve(at + 2), 1));
    return true;
  };
}

/**
 * Backspace aan het begin van een kolom. In een volgende kolom: naar het eind
 * van de kolom ervoor. In de eerste, terwijl alle kolommen leeg zijn: de
 * kolommen weg, met een lege regel ervoor in de plaats. Anders kwam je er
 * niet meer uit: een kolom laat Backspace niet over zijn rand.
 */
function backspaceInColumns(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return false;
  const { $from } = selection;
  if ($from.parentOffset !== 0) return false;
  let columnDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'column') {
      columnDepth = depth;
      break;
    }
  }
  if (columnDepth < 1) return false;
  // Alleen aan het begin van het eerste blok van de kolom.
  if ($from.index(columnDepth) !== 0 || $from.depth !== columnDepth + 1) return false;
  const columns = $from.node(columnDepth - 1);
  const columnIndex = $from.index(columnDepth - 1);
  const columnsPos = $from.before(columnDepth - 1);
  if (columnIndex > 0) {
    // Naar het eind van de kolom ervoor.
    const previousEnd = $from.before(columnDepth) - 1;
    editor.view.dispatch(state.tr.setSelection(Selection.near(state.doc.resolve(previousEnd), -1)));
    return true;
  }
  let allEmpty = true;
  columns.forEach(column => {
    if (column.childCount !== 1 || column.firstChild?.type.name !== 'paragraph' || column.firstChild.content.size > 0) allEmpty = false;
  });
  if (!allEmpty) return false;
  const tr = state.tr.replaceWith(columnsPos, columnsPos + columns.nodeSize, state.schema.nodes.paragraph.create());
  tr.setSelection(TextSelection.create(tr.doc, columnsPos + 1));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/**
 * De naam bij een @-vermelding, met de rechten van wie kijkt; null als die
 * persoon hem niet mag zien, of als het niet meer bestaat. PageEditor zet dit
 * in editor.storage.mention.names, uit wat de app geladen heeft.
 */
export type PageMentionNames = (kind: MentionKind, id: string) => string | null;

type MentionStorage = {
  names?: PageMentionNames | null;
  /** De @-kiezer (stap 2-1b): wat je kunt noemen bij wat je typte. Zonder: geen kiezer. */
  search?: ((query: string) => MentionCandidate[]) | null;
  /** Openen wat een chip noemt: een klant, project, taak of factuur. Zonder: een chip opent niets. */
  open?: ((kind: MentionKind, id: string) => void) | null;
};

const mentionStorageOf = (editor: Editor): MentionStorage | undefined =>
  (editor.storage as unknown as Record<string, MentionStorage | undefined>).mention;

export function mentionNamesOf(editor: Editor): PageMentionNames | null {
  return mentionStorageOf(editor)?.names ?? null;
}

export function mentionSearchOf(editor: Editor): ((query: string) => MentionCandidate[]) | null {
  return mentionStorageOf(editor)?.search ?? null;
}

export function mentionOpenOf(editor: Editor): ((kind: MentionKind, id: string) => void) | null {
  return mentionStorageOf(editor)?.open ?? null;
}

/** Een collega heeft geen eigen scherm; de rest wel. */
export const MENTION_OPENS: Readonly<Record<MentionKind, boolean>> = { client: true, project: true, task: true, invoice: true, member: false };

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Een @-vermelding (stap 2-1a): een klant, project, taak, factuur of collega,
 * midden in de tekst. In de pagina staan alleen de soort en het id (migratie
 * 20261128160000): een naam in de body kwam bij wie Inhoud mag lezen maar de
 * klant of de factuur niet. De naam komt hier uit wat de app geladen heeft,
 * dus met de rechten van wie kijkt; anders staat de soort er. Kiezen met @
 * komt in stap 2-1b.
 */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addStorage(): MentionStorage {
    return { names: null, search: null, open: null };
  },
  addAttributes() {
    return {
      kind: {
        default: null,
        parseHTML: (element: HTMLElement) => mentionKind(element.getAttribute('data-kind')),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-kind': attributes.kind }),
      },
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-id': attributes.id }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }];
  },
  // Ook bij kopiëren alleen de soort: dat is wat de pagina weet.
  renderHTML({ node, HTMLAttributes }) {
    const kind = mentionKind(node.attrs.kind);
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'mention', class: 'page-mention' }), `@${kind ? MENTION_KIND_WORDS[kind] : 'vermelding'}`];
  },
  renderText({ node }) {
    const kind = mentionKind(node.attrs.kind);
    return `@${kind ? MENTION_KIND_WORDS[kind] : 'vermelding'}`;
  },
  addNodeView() {
    return mentionView;
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      props: {
        // Geplakt uit een andere organisatie (twee tabbladen) weigert de
        // database, en dan mislukte elke opslag van deze pagina. Een
        // vermelding die deze editor niet kent, valt bij plakken dus weg,
        // zoals een afbeelding uit een ander dossier.
        transformPasted: (slice: Slice) => {
          const names = mentionNamesOf(editor);
          const keep = (node: PmNode) => {
            const ref = mentionOf({ type: 'mention', attrs: node.attrs });
            return Boolean(ref && names && names(ref.kind, ref.id) !== null);
          };
          const content = withoutUnknownMentions(slice.content, keep);
          return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
        },
      },
    })];
  },
});

/**
 * Actiepunten die een taak werden (stap 2-2a): wat PageEditor in
 * editor.storage.pageTaskLinks zet. De link staat bij de taak (tasks.page_id
 * en page_block_id), niet in de pagina. De taken komen uit wat de app geladen
 * heeft: wie Projecten niet mag lezen, heeft ze niet, en ziet een gewone
 * takenlijst (regel 3).
 */
export type PageTaskLinksStorage = {
  /** Per regel (het id van het blok) de taak. */
  links: ReadonlyMap<string, PageTaskLink>;
  /** De taak openen; de pagina gaat eerst netjes dicht. Zonder: het label opent niets. */
  open: ((taskId: string) => void) | null;
  /** Van een regel een taak maken. Zonder (geen rechten op Projecten): geen knop. */
  make: ((blockId: string, title: string) => Promise<void>) | null;
  /**
   * Iemand klikte het vinkje van een regel met een taak aan of uit (stap
   * 2-2b). Alleen een klik: zie PageTaskLinks.
   */
  checked: ((link: PageTaskLink, checked: boolean, blockId: string) => void) | null;
};

export const PAGE_TASK_LINKS_KEY = new PluginKey('pageTaskLinks');

export function pageTaskLinksOf(editor: Editor): PageTaskLinksStorage | null {
  return (editor.storage as unknown as Record<string, PageTaskLinksStorage | undefined>).pageTaskLinks ?? null;
}

/**
 * Het label achter een regel met een taak: "Taak · Te doen". Alleen lezen: een
 * klik opent de taak. Bij bewerken zet een klik de cursor aan het eind van de
 * regel, en opent "Openen" in de balk; daar klik je ook om de cursor te
 * zetten, net als bij een chip.
 */
function taskBadge(editor: Editor, link: PageTaskLink, getPos: () => number | undefined): HTMLElement {
  const badge = document.createElement('span');
  badge.className = `page-task-badge is-${link.status}`;
  badge.contentEditable = 'false';
  badge.setAttribute('role', 'button');
  badge.setAttribute('aria-label', `Taak: ${link.title}, ${TASK_STATUS_WORDS[link.status].toLowerCase()}`);
  badge.title = `Taak: ${link.title}`;
  badge.textContent = `Taak · ${TASK_STATUS_WORDS[link.status]}`;
  badge.addEventListener('mousedown', event => event.preventDefault());
  badge.addEventListener('click', event => {
    event.preventDefault();
    if (!editor.isEditable) {
      pageTaskLinksOf(editor)?.open?.(link.id);
      return;
    }
    const at = getPos();
    if (typeof at === 'number') editor.chain().focus().setTextSelection(at).run();
  });
  return badge;
}

/**
 * De labels zelf. Een decoratie, geen inhoud: de pagina verandert er niet
 * door, en de klant, de export en de versies zien ze niet. PageEditor stuurt
 * een lege transactie met PAGE_TASK_LINKS_KEY als de taken veranderen.
 */
export const PageTaskLinks = Extension.create({
  name: 'pageTaskLinks',
  // Vóór TaskItem, voor Enter hieronder.
  priority: 1000,
  addStorage(): PageTaskLinksStorage {
    return { links: new Map(), open: null, make: null, checked: null };
  },
  addKeyboardShortcuts() {
    return {
      // Enter aan het begin van een gevulde takenregel: een lege regel erboven,
      // en deze regel blijft dezelfde knoop, met hetzelfde id. Splitsen gaf
      // beide helften hetzelfde id, en dan gaf UniqueID ze allebei een nieuw:
      // de taak van die regel raakte haar label kwijt, en de knop "Maak er een
      // taak van" kwam terug (gezien in ui.mjs, stap 2-2a). UniqueID verhuist
      // een id alleen naar de volgende regel als de eerste helemaal leeg is, en
      // een takenregel heeft altijd een alinea.
      Enter: ({ editor }) => {
        const { state } = editor;
        const { selection } = state;
        if (!selection.empty) return false;
        const { $from } = selection;
        if ($from.parentOffset !== 0 || $from.parent.type.name !== 'paragraph' || $from.parent.content.size === 0) return false;
        const depth = $from.depth - 1;
        if (depth < 1) return false;
        const item = $from.node(depth);
        if (item.type.name !== 'taskItem' || item.firstChild !== $from.parent) return false;
        const empty = item.type.create({ checked: false }, state.schema.nodes.paragraph.create());
        editor.view.dispatch(state.tr.insert($from.before(depth), empty).scrollIntoView());
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: PAGE_TASK_LINKS_KEY,
      // Het vinkje en de taak (stap 2-2b). Alleen een klik van iemand telt: het
      // change-event van het vinkje. Ongedaan maken, een oude versie
      // terugzetten of opnieuw laden na een conflict zetten `checked` in de
      // pagina ook om, maar mogen geen taak afvinken. TaskItem zet de pagina
      // zelf om. Wij luisteren in de capture-fase, dus vóór TaskItem: dan staat
      // de gevraagde stand al klaar als zijn transactie komt, en flitst
      // "loopt achter op zijn taak" (2-2c) niet even op.
      view: view => {
        const onChange = (event: Event) => {
          const box = event.target;
          if (!(box instanceof HTMLInputElement) || box.type !== 'checkbox' || !editor.isEditable) return;
          const blockId = box.closest('li[data-id]')?.getAttribute('data-id');
          const store = pageTaskLinksOf(editor);
          const link = blockId ? store?.links.get(blockId) : undefined;
          if (!blockId || !link || !store?.checked) return;
          store.checked(link, box.checked, blockId);
        };
        view.dom.addEventListener('change', onChange, true);
        return { destroy: () => view.dom.removeEventListener('change', onChange, true) };
      },
      props: {
        decorations: state => {
          const links = pageTaskLinksOf(editor)?.links;
          if (!links || links.size === 0) return DecorationSet.empty;
          const found: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'taskItem') return true;
            const link = typeof node.attrs.id === 'string' ? links.get(node.attrs.id) : undefined;
            const first = node.firstChild;
            if (link && first?.type.name === 'paragraph') {
              // Aan het eind van de eerste alinea van de regel, niet achter een lijst eronder.
              found.push(Decoration.widget(pos + first.nodeSize, (_view, getPos) => taskBadge(editor, link, getPos), {
                side: 1, ignoreSelection: true, key: `taak:${link.id}:${link.status}:${link.title}`,
              }));
            }
            return true;
          });
          return DecorationSet.create(state.doc, found);
        },
      },
    })];
  },
});

/**
 * De vinkjes die achterlopen op hun taak (stap 2-2c), met waar ze heen
 * moeten. `pending` zijn standen die al gevraagd zijn maar nog niet terug
 * (een klik, stap 2-2b): anders stond er na elke klik even "loopt achter".
 */
export function taskCheckDrift(
  doc: PmNode,
  links: ReadonlyMap<string, PageTaskLink>,
  pending?: ReadonlyMap<string, TaskStatus>,
  skip?: ReadonlySet<string>,
): Array<{ pos: number; checked: boolean; blockId: string }> {
  const out: Array<{ pos: number; checked: boolean; blockId: string }> = [];
  if (links.size === 0) return out;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'taskItem') return true;
    const link = typeof node.attrs.id === 'string' && !skip?.has(node.attrs.id) ? links.get(node.attrs.id) : undefined;
    if (link) {
      const want = (pending?.get(link.id) ?? link.status) === 'done';
      if ((node.attrs.checked === true) !== want) out.push({ pos, checked: want, blockId: node.attrs.id as string });
    }
    return true;
  });
  return out;
}

/**
 * Zet die vinkjes gelijk met hun taak, in één transactie. Geen klik op een
 * vinkje: dat zou de taak weer omzetten (stap 2-2b).
 */
export function syncTaskChecks(editor: Editor, drift: ReadonlyArray<{ pos: number; checked: boolean }>): void {
  if (editor.isDestroyed || drift.length === 0) return;
  const tr = editor.state.tr;
  for (const { pos, checked } of drift) {
    const node = tr.doc.nodeAt(pos);
    if (node?.type.name === 'taskItem') tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked });
  }
  if (tr.docChanged) editor.view.dispatch(tr);
}

/** Een fragment zonder de vermeldingen die `keep` niet houdt; hetzelfde fragment als er niets weg hoeft. */
export function withoutUnknownMentions(fragment: Fragment, keep: (node: PmNode) => boolean): Fragment {
  let changed = false;
  const nodes: PmNode[] = [];
  fragment.forEach(child => {
    if (child.type.name === 'mention') {
      if (keep(child)) nodes.push(child);
      else changed = true;
      return;
    }
    if (child.isLeaf) { nodes.push(child); return; }
    const inner = withoutUnknownMentions(child.content, keep);
    if (inner !== child.content) changed = true;
    nodes.push(inner === child.content ? child : child.copy(inner));
  });
  return changed ? Fragment.from(nodes) : fragment;
}

const mentionView: NodeViewRenderer = ({ editor, node }) => {
  const dom = document.createElement('span');
  dom.className = 'page-mention';
  dom.setAttribute('data-type', 'mention');
  dom.contentEditable = 'false';
  let ref: ReturnType<typeof mentionOf> = null;
  let named = false;
  // Alleen lezen: een klik opent wat de chip noemt. Bij bewerken selecteert een
  // klik de chip, en opent de knop "Openen" in de balk (PageEditor): daar klik je
  // ook om de cursor te zetten, en openen sluit de pagina.
  dom.addEventListener('click', event => {
    if (editor.isEditable || !ref || !named || !MENTION_OPENS[ref.kind]) return;
    const open = mentionOpenOf(editor);
    if (!open) return;
    event.preventDefault();
    open(ref.kind, ref.id);
  });
  const show = (current: PmNode) => {
    ref = mentionOf({ type: 'mention', attrs: current.attrs });
    const names = mentionNamesOf(editor);
    const name = ref && names ? names(ref.kind, ref.id) : null;
    named = Boolean(name);
    dom.setAttribute('data-kind', ref?.kind ?? '');
    dom.classList.toggle('is-unknown', !name);
    dom.textContent = `@${name ?? (ref ? MENTION_KIND_WORDS[ref.kind] : 'vermelding')}`;
    dom.title = name && ref ? `${capitalized(MENTION_KIND_WORDS[ref.kind])}: ${name}`
      : 'Je ziet niet wat hier genoemd wordt, of het bestaat niet meer.';
  };
  show(node);
  return {
    dom,
    update: updated => {
      if (updated.type.name !== 'mention') return false;
      show(updated);
      return true;
    },
  };
};

/**
 * Een knop in een blok (inhoudsopgave, subpagina, bestand) pakt bij een klik
 * de focus niet: anders stond de cursor daarna nergens, en ging wat je typte
 * verloren. De klik zelf werkt gewoon.
 */
function keepEditorFocus(button: HTMLButtonElement): void {
  button.addEventListener('mousedown', event => event.preventDefault());
}

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
      keepEditorFocus(button);
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
  keepEditorFocus(button);
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
  /** Zeggen waarom iets niet kan (in de balk van de editor). */
  refuse: (reason: string) => void;
  /** Naam en grootte van een bestand, of null als het er niet (meer) is. */
  fileInfo: (attachmentId: string) => Promise<{ name: string; size: number } | null>;
  /** Een bestand opslaan op de computer. Nooit openen in de app: zie het bestandsblok. */
  download: (attachmentId: string) => Promise<void>;
  /** De kiezer: een bestand uit het dossier (id), of bestanden van de computer. */
  chooseFile: () => Promise<{ attachmentId: string } | { files: File[] } | null>;
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

/**
 * De plaatjes van een plakactie, alleen als het plakken écht om het plaatje
 * gaat: een schermafdruk (geen HTML), of "Afbeelding kopiëren" in een browser
 * (HTML met alleen één <img>). Excel en Word zetten naast de tabel of tekst
 * ook een plaatje van de selectie op het klembord; dat werd anders geüpload
 * in plaats van dat er een tabel kwam.
 */
export function pastedImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files = imageFilesOf(data.files);
  if (files.length === 0) return [];
  const html = data.getData('text/html');
  if (!html.trim()) return files;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  const onlyOneImage = body.querySelectorAll('img').length === 1 && !(body.textContent ?? '').trim() && !body.querySelector('table');
  return onlyOneImage ? files : [];
}

const PROBE_ATTACHMENT_ID = '00000000-0000-4000-8000-000000000000';

/** Uploaden en invoegen, op `pos` of waar de cursor staat. Eén voor één, in volgorde. */
export async function insertImages(editor: Editor, files: File[], pos?: number): Promise<void> {
  const media = pageMediaOf(editor);
  if (!media || files.length === 0) return;
  // Eerst kijken of hier een afbeelding mag (niet in een callout of codeblok):
  // anders stond er een geüpload bestand in de opslag dat niemand ziet.
  const probe = { type: 'image', attrs: { attachmentId: PROBE_ATTACHMENT_ID, alt: '' } };
  const fits = typeof pos === 'number' ? editor.can().insertContentAt(pos, probe) : editor.can().insertContent(probe);
  if (!fits) {
    media.refuse('Hier kan geen afbeelding staan. Zet de cursor op een gewone regel.');
    return;
  }
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

/** Bestanden uploaden en als bestandsblok invoegen, op `pos` of waar de cursor staat. */
export async function insertFiles(editor: Editor, files: File[], pos?: number): Promise<void> {
  const media = pageMediaOf(editor);
  if (!media || files.length === 0) return;
  if (!canInsertFileBlock(editor, pos)) {
    media.refuse('Hier kan geen bestand staan. Zet de cursor op een gewone regel.');
    return;
  }
  let at = pos;
  for (const file of files) {
    const attachmentId = await media.upload(file);
    if (!attachmentId || editor.isDestroyed || !editor.isEditable) return;
    insertFileBlock(editor, attachmentId, at);
    at = undefined;
  }
}

export function canInsertFileBlock(editor: Editor, pos?: number): boolean {
  const probe = { type: 'fileBlock', attrs: { attachmentId: PROBE_ATTACHMENT_ID } };
  return typeof pos === 'number' ? editor.can().insertContentAt(pos, probe) : editor.can().insertContent(probe);
}

export function insertFileBlock(editor: Editor, attachmentId: string, pos?: number): void {
  const content = { type: 'fileBlock', attrs: { attachmentId } };
  const chain = editor.chain().focus();
  if (typeof pos === 'number') chain.insertContentAt(pos, content);
  else chain.insertContent(content);
  chain.command(cursorOnText('na-dit-blok')).run();
}

function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Een bestand uit ResoFly, met naam en grootte. Klikken slaat het op, via een
 * downloadlink. Nooit openen in een tabblad of frame: een blob-URL draait in de
 * herkomst van de app, zonder de sandbox die de worker meestuurt. Een
 * geüpload HTML-bestand zou dan als de app draaien.
 */
const fileBlockView: NodeViewRenderer = ({ editor, node }) => {
  const dom = document.createElement('div');
  dom.className = 'page-file';
  dom.setAttribute('data-type', 'file-block');
  dom.contentEditable = 'false';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'page-file-link';
  keepEditorFocus(button);
  const icon = document.createElement('span');
  icon.className = 'page-file-icon';
  icon.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'page-file-name';
  const meta = document.createElement('span');
  meta.className = 'page-file-meta';
  button.append(icon, name, meta);
  dom.append(button);
  let current: string | null = typeof node.attrs.attachmentId === 'string' ? node.attrs.attachmentId : null;
  let alive = true;
  let available = false;
  const load = (attachmentId: string | null) => {
    const media = pageMediaOf(editor);
    available = false;
    if (attachmentId) dom.dataset.attachmentId = attachmentId;
    else delete dom.dataset.attachmentId;
    dom.classList.remove('is-missing');
    name.textContent = 'Laden…';
    meta.textContent = '';
    if (!attachmentId || !media) { dom.classList.add('is-missing'); name.textContent = 'Bestand niet gevonden'; return; }
    media.fileInfo(attachmentId).then(info => {
      if (!alive || current !== attachmentId) return;
      available = info !== null;
      dom.classList.toggle('is-missing', !available);
      name.textContent = info ? info.name : 'Bestand niet gevonden';
      meta.textContent = info ? sizeLabel(info.size) : '';
      button.title = info ? `${info.name} opslaan` : '';
    }, () => {
      if (alive && current === attachmentId) name.textContent = 'Het bestand kon niet worden geladen';
    });
  };
  load(current);
  button.addEventListener('click', event => {
    event.preventDefault();
    const media = pageMediaOf(editor);
    if (media && current && available) void media.download(current);
  });
  return {
    dom,
    update: updated => {
      if (updated.type.name !== 'fileBlock') return false;
      const next = typeof updated.attrs.attachmentId === 'string' ? updated.attrs.attachmentId : null;
      if (next !== current) { current = next; load(current); }
      return true;
    },
    ignoreMutation: () => true,
    stopEvent: (event: Event) => event.target instanceof Element && event.target.closest('button') !== null,
    destroy: () => { alive = false; },
  };
};

export const FileBlock = Node.create({
  name: 'fileBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      attachmentId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-attachment-id'),
        renderHTML: (attributes: Record<string, unknown>) => ({ 'data-attachment-id': attributes.attachmentId }),
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'div[data-type="file-block"]',
      getAttrs: (element: HTMLElement) => (UUID_PATTERN.test(element.getAttribute('data-attachment-id') ?? '') ? null : false),
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'file-block', class: 'page-file' })];
  },
  addNodeView() {
    return fileBlockView;
  },
});

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
    // Het id (geen adres) op de weergave: zo is een blok terug te vinden.
    if (attachmentId) dom.dataset.attachmentId = attachmentId;
    else delete dom.dataset.attachmentId;
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
          if (!view.editable || !pageMediaOf(editor)) return false;
          const images = pastedImageFiles(event.clipboardData);
          if (images.length > 0) {
            event.preventDefault();
            void insertImages(editor, images);
            return true;
          }
          // Bestanden geplakt uit een verkenner (geen tekst of HTML erbij):
          // een bestandsblok. Met tekst erbij gaat de tekst voor.
          const data = event.clipboardData;
          const others = Array.from(data?.files ?? []).filter(file => !IMAGE_TYPES.test(file.type));
          if (others.length === 0 || data?.getData('text/html') || data?.getData('text/plain')) return false;
          event.preventDefault();
          void insertFiles(editor, others);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false;
          const dropped = Array.from((event as DragEvent).dataTransfer?.files ?? []);
          if (dropped.length === 0 || !view.editable) return false;
          // Elk bestand dat erop valt, houden we tegen: anders opent de browser
          // het en verlaat je de app. Plaatjes worden een afbeelding, de rest
          // een bestandsblok.
          event.preventDefault();
          const files = imageFilesOf(dropped);
          const others = dropped.filter(file => !IMAGE_TYPES.test(file.type));
          const pos = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
          // Eerst de plaatjes, dan de rest; de tweede groep komt waar de cursor
          // na de eerste staat.
          void insertImages(editor, files, pos).then(() => insertFiles(editor, others, files.length > 0 ? undefined : pos));
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
    Columns,
    Column,
    Mention,
    PageTaskLinks,
    TableOfContents,
    Subpage,
    PageImage,
    FileBlock,
    UniqueID.configure({ types: [...PAGE_BLOCKS_WITH_ID] }),
    Placeholder.configure({ placeholder: options.placeholder ?? 'Typ hier, of typ / voor een tabel, callout of ander blok.' }),
  ];
}
