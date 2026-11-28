// ============================================================
// @-vermeldingen in een pagina (stap 2-1a, docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md §18).
//
// Een vermelding (de knoop `mention`) bewaart alleen de soort en het id,
// nooit een naam: wie Inhoud mag lezen maar Klanten of Financiën niet, leest de
// body van een pagina wel (migratie 20261128160000). De naam komt pas bij het
// tonen, met de rechten van wie kijkt. Wie hem niet mag zien, of als het niet
// meer bestaat, ziet de soort: "klant", "factuur".
//
// Puur en gedeeld: de editor en Word in de app, de PDF op de server
// (page-export), en wat de klant ziet (pageHtml.ts).
// ============================================================

/** De soorten, in de volgorde van public.page_body_allowed() ('mention_kinds'). */
export const MENTION_KINDS = ['client', 'project', 'task', 'invoice', 'member'] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/** Wat je ziet in plaats van de naam. */
export const MENTION_KIND_WORDS: Readonly<Record<MentionKind, string>> = {
  client: 'klant',
  project: 'project',
  task: 'taak',
  invoice: 'factuur',
  member: 'collega',
};

export type MentionRef = { kind: MentionKind; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Een soort uit de lijst, of null. */
export function mentionKind(value: unknown): MentionKind | null {
  return (MENTION_KINDS as readonly unknown[]).includes(value) ? value as MentionKind : null;
}

/** De soort en het id van een knoop `mention`, of null als hij niet klopt. */
export function mentionOf(node: unknown): MentionRef | null {
  if (!node || typeof node !== 'object') return null;
  const { type, attrs } = node as { type?: unknown; attrs?: unknown };
  if (type !== 'mention' || !attrs || typeof attrs !== 'object') return null;
  const kind = mentionKind((attrs as { kind?: unknown }).kind);
  const id = (attrs as { id?: unknown }).id;
  if (!kind || typeof id !== 'string' || !UUID.test(id)) return null;
  return { kind, id: id.toLowerCase() };
}

/** Eén sleutel per vermelding, voor een opzoeklijst met namen. */
export function mentionKey(ref: MentionRef): string {
  return `${ref.kind}:${ref.id.toLowerCase()}`;
}

/** De vermeldingen in een of meer bodies, elk één keer, in de volgorde waarin ze staan. */
export function mentionsIn(bodies: unknown[]): MentionRef[] {
  const seen = new Map<string, MentionRef>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 100 || !node || typeof node !== 'object') return;
    const ref = mentionOf(node);
    if (ref && !seen.has(mentionKey(ref))) seen.set(mentionKey(ref), ref);
    const content = (node as { content?: unknown }).content;
    if (Array.isArray(content)) for (const child of content) walk(child, depth + 1);
  };
  for (const body of bodies) walk(body, 0);
  return [...seen.values()];
}

/** Wat er in de tekst staat: de naam als die er is, anders de soort. */
export function mentionText(ref: MentionRef | null, names?: Readonly<Record<string, string>> | null): string {
  if (!ref) return 'vermelding';
  const name = names ? Object.prototype.hasOwnProperty.call(names, mentionKey(ref)) ? names[mentionKey(ref)] : undefined : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : MENTION_KIND_WORDS[ref.kind];
}
