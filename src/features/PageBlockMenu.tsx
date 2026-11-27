// ============================================================
// Het blokmenu van de pagina-editor (stap 1A-4a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md).
//
// Twee ingangen, één menu:
//  - `/` in de tekst (Tiptap Suggestion). Pijltjes, Enter en Escape werken
//    zoals in andere programma's; wat je na de schuine streep typt, filtert.
//  - de +-knop in de werkbalk. Op een telefoon typ je niet makkelijk een
//    schuine streep, en daar komt het menu als een paneel van onderen.
// Het menu toont alleen wat op die plek kan (editor.can()): geen tabel in een
// tabel, geen kop in een callout. Anders kreeg je een knop die niets deed.
// De terugknop van de telefoon sluit eerst het menu, niet de pagina.
// ============================================================

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Extension } from '@tiptap/core';
import type { ChainedCommands, Editor, Range } from '@tiptap/core';
import { Suggestion, exitSuggestion } from '@tiptap/suggestion';
import type { SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import {
  Braces, Heading1, Heading2, Heading3, List, ListChecks, ListCollapse, ListOrdered, ListTree, MessageSquareText, Minus,
  Pilcrow, Quote, Table2,
} from 'lucide-react';
import { filterPageBlocks, type PageBlock, type PageBlockKey } from '../lib/pageBlocks';
import { useBackStep } from '../lib/useBackStep';

const ICONS: Record<PageBlockKey, JSX.Element> = {
  tekst: <Pilcrow size={17} />,
  kop1: <Heading1 size={17} />,
  kop2: <Heading2 size={17} />,
  kop3: <Heading3 size={17} />,
  opsomming: <List size={17} />,
  nummering: <ListOrdered size={17} />,
  takenlijst: <ListChecks size={17} />,
  tabel: <Table2 size={17} />,
  callout: <MessageSquareText size={17} />,
  uitklapper: <ListCollapse size={17} />,
  inhoudsopgave: <ListTree size={17} />,
  citaat: <Quote size={17} />,
  code: <Braces size={17} />,
  scheidingslijn: <Minus size={17} />,
};

/** Wat elk blok doet, op een keten die echt draait of alleen kijkt (can). */
function blockChain(chain: ChainedCommands, key: PageBlockKey): ChainedCommands {
  switch (key) {
    case 'tekst': return chain.setParagraph();
    case 'kop1': return chain.setHeading({ level: 1 });
    case 'kop2': return chain.setHeading({ level: 2 });
    case 'kop3': return chain.setHeading({ level: 3 });
    case 'opsomming': return chain.toggleBulletList();
    case 'nummering': return chain.toggleOrderedList();
    case 'takenlijst': return chain.toggleTaskList();
    case 'tabel': return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true });
    case 'callout': return chain.wrapIn('callout', { variant: 'info' });
    case 'uitklapper': return chain.setDetails();
    case 'inhoudsopgave': return chain.insertContent({ type: 'tableOfContents' });
    case 'citaat': return chain.toggleBlockquote();
    case 'code': return chain.setCodeBlock();
    case 'scheidingslijn': return chain.setHorizontalRule();
  }
}

/** Blokken die in een tabel of callout niet thuishoren, ook als het schema ze toelaat. */
const NOT_IN_TABLE: ReadonlySet<PageBlockKey> = new Set(['tabel', 'callout', 'uitklapper', 'inhoudsopgave']);
const NOT_IN_CALLOUT: ReadonlySet<PageBlockKey> = new Set(['tabel', 'callout', 'uitklapper', 'inhoudsopgave', 'code', 'citaat', 'scheidingslijn']);

export function canRunPageBlock(editor: Editor, key: PageBlockKey): boolean {
  if (!editor.isEditable || editor.isActive('codeBlock')) return false;
  if (editor.isActive('table') && NOT_IN_TABLE.has(key)) return false;
  if (editor.isActive('callout') && NOT_IN_CALLOUT.has(key)) return false;
  try {
    return blockChain(editor.can().chain(), key).run();
  } catch {
    return false;
  }
}

/** Voert het blok uit. Met `range` (na `/`) eerst de schuine streep en het zoekwoord weg. */
export function runPageBlock(editor: Editor, key: PageBlockKey, range?: Range): boolean {
  let chain = editor.chain().focus();
  if (range) chain = chain.deleteRange(range);
  return blockChain(chain, key).run();
}

export function pageBlocksFor(editor: Editor, query: string): PageBlock[] {
  return filterPageBlocks(query).filter(block => canRunPageBlock(editor, block.key));
}

/** Wat het menu in beeld zet: waar, welke blokken, en wat een keuze doet. */
export type BlockMenuState = {
  source: 'slash' | 'plus';
  items: PageBlock[];
  active: number;
  /** Waar het menu bij hoort: de schuine streep of de +-knop. */
  anchor: DOMRect | null;
  pick: (block: PageBlock) => void;
};

/** Brug van de Suggestion-plugin (buiten React) naar de state van de editor. */
export type SlashBridge = {
  open: (props: SuggestionProps<PageBlock, PageBlock>) => void;
  update: (props: SuggestionProps<PageBlock, PageBlock>) => void;
  keyDown: (event: KeyboardEvent) => boolean;
  close: () => void;
};

export const SLASH_MENU_KEY = new PluginKey('pageSlashMenu');

/**
 * De `/`-ingang. `bridge` is een ref: de extensie wordt één keer gemaakt, de
 * handlers in de editor veranderen bij elke render.
 */
export function slashMenuExtension(bridge: { current: SlashBridge | null }) {
  return Extension.create({
    name: 'pageSlashMenu',
    addProseMirrorPlugins() {
      return [Suggestion<PageBlock, PageBlock>({
        editor: this.editor,
        pluginKey: SLASH_MENU_KEY,
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock'),
        items: ({ query, editor }) => pageBlocksFor(editor, query),
        command: ({ editor, range, props }) => { runPageBlock(editor, props.key, range); },
        render: () => ({
          onStart: props => bridge.current?.open(props),
          onUpdate: props => bridge.current?.update(props),
          onKeyDown: ({ event }) => bridge.current?.keyDown(event) ?? false,
          onExit: () => bridge.current?.close(),
        }),
      })];
    },
  });
}

/** Sluit het `/`-menu zonder te kiezen; de getypte tekst blijft staan. */
export function closeSlashMenu(editor: Editor): void {
  exitSuggestion(editor.view, SLASH_MENU_KEY);
}

const MENU_WIDTH = 300;
const MENU_MAX_HEIGHT = 340;

/**
 * Het menu zelf. Bij `/` en op een groot scherm een lijst bij de plek waar je
 * bent; bij de +-knop op een telefoon een paneel van onderen.
 */
export function BlockMenu({ menu, onHover, onClose }: {
  menu: BlockMenuState;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 640);
  const sheet = menu.source === 'plus' && narrow;

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth <= 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // De terugknop van de telefoon sluit het menu, niet de pagina.
  useBackStep(true, onClose);

  // Escape sluit het menu van de +-knop (bij `/` doet de plugin dat zelf).
  useEffect(() => {
    if (menu.source !== 'plus') return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu.source, onClose]);

  // Het gekozen blok in beeld houden bij pijltjes.
  useLayoutEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('.page-block-item.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [menu.active, menu.items]);

  let style: CSSProperties | undefined;
  if (!sheet && menu.anchor) {
    const rect = menu.anchor;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8));
    const below = window.innerHeight - rect.bottom;
    style = below >= Math.min(MENU_MAX_HEIGHT, 220) || below >= rect.top
      ? { left, top: rect.bottom + 6, maxHeight: Math.min(MENU_MAX_HEIGHT, below - 14) }
      : { left, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(MENU_MAX_HEIGHT, rect.top - 14) };
  }

  const list = (
    <div
      ref={listRef}
      className={`page-block-menu${sheet ? ' is-sheet' : ''}`}
      style={style}
      role="listbox"
      aria-label="Blok invoegen"
      // De cursor blijft in de tekst; een klik kiest, hij verplaatst niets.
      onMouseDown={event => event.preventDefault()}
    >
      {sheet && <div className="page-block-menu-head">Blok invoegen</div>}
      {menu.items.length === 0
        ? <div className="page-block-empty">Geen blok gevonden</div>
        : menu.items.map((block, index) => (
          <button
            key={block.key}
            type="button"
            role="option"
            aria-selected={index === menu.active}
            className={`page-block-item${index === menu.active ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onClick={() => menu.pick(block)}
          >
            <span className="page-block-icon" aria-hidden="true">{ICONS[block.key]}</span>
            <span className="page-block-text">
              <span className="page-block-label">{block.label}</span>
              <span className="page-block-hint">{block.hint}</span>
            </span>
          </button>
        ))}
    </div>
  );

  if (!sheet) return list;
  return (
    <div className="page-block-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      {list}
    </div>
  );
}
