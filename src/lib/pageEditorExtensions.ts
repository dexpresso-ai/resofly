// ============================================================
// De extensies van de pagina-editor (stap 1A-3a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md).
//
// Bewust zonder React: pageEditorExtensions.test.ts bouwt hiermee het schema
// in Node en controleert dat de editor alleen blokken en opmaak kan maken die
// de database aanneemt (public.page_body_allowed, gespiegeld in pageSchema.ts).
// Maakt de editor iets wat daar niet in staat, dan weigert de database het
// opslaan en verliest de gebruiker zijn werk.
//
// Alle pakketten zijn MIT (Tiptap 3.35.1, nagekeken op 27 november 2026).
// ============================================================

import { StarterKit } from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { UniqueID } from '@tiptap/extension-unique-id';
import { isAllowedPageLink } from './pageSchema.ts';

/** Blokken met een vast id (attrs.id): waar Gerrie straks per blok iets voorstelt. */
export const PAGE_BLOCKS_WITH_ID = [
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule',
] as const;

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
    UniqueID.configure({ types: [...PAGE_BLOCKS_WITH_ID] }),
    Placeholder.configure({ placeholder: options.placeholder ?? 'Typ hier. Begin een regel met # voor een kop, - voor een lijst of [] voor een taak.' }),
  ];
}
