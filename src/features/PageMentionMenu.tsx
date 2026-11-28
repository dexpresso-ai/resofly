// ============================================================
// De @-kiezer van de pagina-editor (stap 2-1b, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// Typ @ en een stuk van een naam: een lijst met klanten, projecten, taken,
// facturen en collega's, uit wat de app geladen heeft (dus alleen wat je mag
// lezen). Pijltjes, Enter, Tab en Escape zoals bij het blokmenu (`/`), en
// net als daar sluit een spatie de kiezer: zo blijft hij niet open hangen
// terwijl je verder typt. Een @ midden in een woord (jan@bedrijf.nl) opent
// hem niet. De terugknop van de telefoon sluit eerst de kiezer, niet de
// pagina.
//
// Wat je kiest, wordt een chip (de knoop `mention`) met alleen de soort en
// het id: zie stap 2-1a.
// ============================================================

import { useLayoutEffect, useRef } from 'react';
import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { Suggestion, exitSuggestion } from '@tiptap/suggestion';
import type { SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { Building2, FolderKanban, ListTodo, Receipt, UserRound } from 'lucide-react';
import type { MentionKind } from '../../supabase/functions/_shared/pageMentions.ts';
import type { MentionCandidate } from '../lib/pageMentionSearch';
import { mentionSearchOf } from '../lib/pageEditorExtensions';
import { useBackStep } from '../lib/useBackStep';
import { menuStyleAt } from './PageBlockMenu';

const ICONS: Record<MentionKind, JSX.Element> = {
  client: <Building2 size={17} />,
  project: <FolderKanban size={17} />,
  task: <ListTodo size={17} />,
  invoice: <Receipt size={17} />,
  member: <UserRound size={17} />,
};

export type MentionMenuState = {
  items: MentionCandidate[];
  active: number;
  anchor: DOMRect | null;
  pick: (candidate: MentionCandidate) => void;
};

/** Brug van de Suggestion-plugin (buiten React) naar de state van de editor. */
export type MentionBridge = {
  open: (props: SuggestionProps<MentionCandidate, MentionCandidate>) => void;
  update: (props: SuggestionProps<MentionCandidate, MentionCandidate>) => void;
  keyDown: (event: KeyboardEvent) => boolean;
  close: () => void;
};

export const MENTION_MENU_KEY = new PluginKey('pageMentionMenu');

/** De @-ingang. `bridge` is een ref, net als bij het blokmenu. */
export function mentionMenuExtension(bridge: { current: MentionBridge | null }) {
  return Extension.create({
    name: 'pageMentionMenu',
    addProseMirrorPlugins() {
      return [Suggestion<MentionCandidate, MentionCandidate>({
        editor: this.editor,
        pluginKey: MENTION_MENU_KEY,
        char: '@',
        // Een spatie sluit de kiezer: met spaties erin bleef hij open terwijl je
        // de rest van de zin typte. "@jan" vindt "Bakkerij Jansen" op het tweede woord.
        allowSpaces: false,
        // Alleen na een spatie of aan het begin van een regel: niet in jan@bedrijf.nl.
        allowedPrefixes: [' '],
        allow: ({ editor }) => editor.isEditable && !editor.isActive('codeBlock') && Boolean(mentionSearchOf(editor)),
        items: ({ query, editor }) => mentionSearchOf(editor)?.(query) ?? [],
        command: ({ editor, range, props }) => {
          editor.chain().focus().insertContentAt(range, [
            { type: 'mention', attrs: { kind: props.kind, id: props.id } },
            { type: 'text', text: ' ' },
          ]).run();
        },
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

/** Sluit de kiezer zonder te kiezen; wat je typte, blijft staan. */
export function closeMentionMenu(editor: Editor): void {
  exitSuggestion(editor.view, MENTION_MENU_KEY);
}

/** De lijst bij de cursor, in de stijl van het blokmenu. */
export function MentionMenu({ menu, onHover, onClose }: {
  menu: MentionMenuState;
  onHover: (index: number) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // De terugknop van de telefoon sluit de kiezer, niet de pagina.
  useBackStep(true, onClose);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.page-block-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [menu.active, menu.items]);
  return (
    <div
      ref={listRef}
      className="page-block-menu page-mention-menu"
      style={menuStyleAt(menu.anchor)}
      role="listbox"
      aria-label="Iets of iemand noemen"
      // De cursor blijft in de tekst; een klik kiest, hij verplaatst niets.
      onMouseDown={event => event.preventDefault()}
    >
      {menu.items.length === 0
        ? <div className="page-block-empty">Niets gevonden. Typ een deel van de naam.</div>
        : menu.items.map((candidate, index) => (
          <button
            key={`${candidate.kind}:${candidate.id}`}
            type="button"
            role="option"
            aria-selected={index === menu.active}
            className={`page-block-item${index === menu.active ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(index)}
            onClick={() => menu.pick(candidate)}
          >
            <span className="page-block-icon" aria-hidden="true">{ICONS[candidate.kind]}</span>
            <span className="page-block-text">
              <span className="page-block-label">{candidate.label}</span>
              <span className="page-block-hint">{candidate.hint}</span>
            </span>
          </button>
        ))}
    </div>
  );
}
