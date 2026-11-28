// Pure stukjes van de Word-export van een pagina (pageWordExport.ts), los van
// de database, zodat `npm test` ze kan nalopen.

type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[] };

/** De subpagina's, bestanden en afbeeldingen waar de pagina naar wijst. */
export function pageReferences(body: unknown): { pages: string[]; files: string[]; images: string[] } {
  const found = { pages: new Set<string>(), files: new Set<string>(), images: new Set<string>() };
  const walk = (node: Node | null | undefined) => {
    if (!node || typeof node !== 'object') return;
    const id = (name: string) => (typeof node.attrs?.[name] === 'string' ? (node.attrs[name] as string) : '');
    if (node.type === 'subpage' && id('pageId')) found.pages.add(id('pageId'));
    if (node.type === 'fileBlock' && id('attachmentId')) found.files.add(id('attachmentId'));
    if (node.type === 'image' && id('attachmentId')) found.images.add(id('attachmentId'));
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(body as Node);
  return { pages: [...found.pages], files: [...found.files], images: [...found.images] };
}

/** Een bestandsnaam die overal kan: "Werkwijze & afspraken" wordt "Werkwijze-afspraken.docx". */
export function wordFileName(title: string): string {
  const base = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${base || 'pagina'}.docx`;
}
