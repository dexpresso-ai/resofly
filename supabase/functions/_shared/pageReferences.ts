// Waar een pagina naar wijst: haar subpagina's, bestanden en afbeeldingen.
//
// Staat in _shared omdat de app (de Word-export, src/lib/pageExportParts.ts)
// en de server (het portaal, dat alleen afbeeldingen uit de gedeelde versie
// tekent) dezelfde lijst nodig hebben. Een edge function kan niet bij src/.

type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[] };

/** Zo diep nest geen pagina uit de editor; een diepere body (via de API) stopt hier. */
const MAX_DEPTH = 64;

/** De subpagina's, bestanden en afbeeldingen waar de pagina naar wijst. */
export function pageReferences(body: unknown): { pages: string[]; files: string[]; images: string[] } {
  const found = { pages: new Set<string>(), files: new Set<string>(), images: new Set<string>() };
  const walk = (node: Node | null | undefined, depth: number) => {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) return;
    const id = (name: string) => (typeof node.attrs?.[name] === 'string' ? (node.attrs[name] as string) : '');
    if (node.type === 'subpage' && id('pageId')) found.pages.add(id('pageId'));
    if (node.type === 'fileBlock' && id('attachmentId')) found.files.add(id('attachmentId'));
    if (node.type === 'image' && id('attachmentId')) found.images.add(id('attachmentId'));
    if (Array.isArray(node.content)) node.content.forEach(child => walk(child, depth + 1));
  };
  walk(body as Node, 0);
  return { pages: [...found.pages], files: [...found.files], images: [...found.images] };
}
