// ============================================================
// De bouwstenen van een pagina (docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md, §3).
//
// SPIEGEL van public.page_body_allowed() in
// supabase/migrations/20261127130000_paginas_datamodel.sql. De database keurt
// elke pagina af met een blok, opmaak of link die hier niet in staat, langs
// elke schrijfweg (app, Gerrie, MCP, API). De editor (stap 1A-3) mag dus alleen
// deze typen maken. pageSchema.test.ts houdt de twee lijsten gelijk: een nieuw
// bloktype vraagt een nieuwe migratie én een regel hier.
//
// De namen zijn die van Tiptap. Afbeeldingen en bestanden verwijzen naar een
// bestand in ResoFly (attachmentId), nooit naar een adres van buiten: in een
// klantpagina zou dat een volgpixel zijn.
// ============================================================

export const PAGE_NODE_TYPES = [
  'doc', 'paragraph', 'text', 'hardBreak', 'heading',
  'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem',
  'blockquote', 'codeBlock', 'horizontalRule',
  'table', 'tableRow', 'tableHeader', 'tableCell',
  'image', 'fileBlock', 'callout', 'details', 'detailsSummary', 'detailsContent',
  'columns', 'column', 'tableOfContents', 'subpage',
] as const;

export const PAGE_MARK_TYPES = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'highlight'] as const;

/** Waar een link in een pagina heen mag. Dezelfde regel als in de database. */
export const PAGE_LINK_PATTERN = '^(https?:|mailto:|tel:|/|#)';

export type PageNodeType = (typeof PAGE_NODE_TYPES)[number];
export type PageMarkType = (typeof PAGE_MARK_TYPES)[number];

/** Mag deze link in een pagina? */
export function isAllowedPageLink(href: string): boolean {
  return new RegExp(PAGE_LINK_PATTERN, 'i').test(href);
}

/** Een lege pagina, zoals de database hem aanneemt. */
export function emptyPageBody(): { type: 'doc'; content: Array<{ type: 'paragraph' }> } {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
