/**
 * De indeling van het dashboard (2026-11-24): welke blokken in welke volgorde
 * staan, en welke ingeklapt zijn. Op verzoek van de PO: "de blokken op het
 * dashboard in- en uitklapbaar, en de volgorde aan te passen".
 *
 * Bewust zonder imports: zo draait het rechtstreeks onder `npm test`, en kan
 * het scherm er niet stilletjes iets anders van maken dan de tests verwachten.
 */

/**
 * Hoe breed een blok staat. `main` en `side` horen bij elkaar: staan ze naast
 * elkaar in de volgorde, dan staan ze ook naast elkaar in beeld (de brede
 * kolom en de kolom van 330px). Staat een blok alleen, dan krijgt het de volle
 * breedte: een smalle kolom met een gat ernaast helpt niemand.
 */
export type DashBlockSize = 'full' | 'main' | 'side';

export const DASHBOARD_BLOCKS = [
  { id: 'stand', size: 'full' },
  { id: 'beslissingen', size: 'full' },
  { id: 'akkoord', size: 'full' },
  { id: 'vandaag', size: 'main' },
  { id: 'aandacht', size: 'side' },
  { id: 'weekacties', size: 'full' },
  { id: 'projecten', size: 'full' },
  { id: 'rapportages', size: 'main' },
  { id: 'inrichting', size: 'side' },
  { id: 'logboek', size: 'side' },
] as const satisfies ReadonlyArray<{ id: string; size: DashBlockSize }>;

export type DashBlockId = typeof DASHBOARD_BLOCKS[number]['id'];

/** De volgorde zoals het dashboard er altijd uitzag. */
export const DEFAULT_DASH_ORDER: DashBlockId[] = DASHBOARD_BLOCKS.map(block => block.id);

const SIZE = new Map<string, DashBlockSize>(DASHBOARD_BLOCKS.map(block => [block.id, block.size]));

export function dashBlockSize(id: DashBlockId): DashBlockSize {
  return SIZE.get(id) ?? 'full';
}

function isBlockId(value: unknown): value is DashBlockId {
  return typeof value === 'string' && SIZE.has(value);
}

export type DashLayout = { order: DashBlockId[]; collapsed: DashBlockId[] };

export const DEFAULT_DASH_LAYOUT: DashLayout = { order: DEFAULT_DASH_ORDER, collapsed: [] };

/**
 * Vult een bewaarde volgorde aan met blokken die er later bij kwamen. Een
 * nieuw blok komt op zijn standaardplek: direct na het blok dat er standaard
 * vóór staat. Zonder dit zou een nieuw blok voor iedereen met een eigen
 * indeling helemaal onderaan belanden, of verdwijnen.
 */
export function completeOrder(stored: readonly string[]): DashBlockId[] {
  const order: DashBlockId[] = [];
  for (const id of stored) if (isBlockId(id) && !order.includes(id)) order.push(id);
  DEFAULT_DASH_ORDER.forEach((id, index) => {
    if (order.includes(id)) return;
    let at = 0;
    for (let back = index - 1; back >= 0; back--) {
      const position = order.indexOf(DEFAULT_DASH_ORDER[back]);
      if (position >= 0) { at = position + 1; break; }
    }
    order.splice(at, 0, id);
  });
  return order;
}

/** Leest de bewaarde indeling. Alles wat niet klopt, valt terug op de standaard. */
export function parseDashLayout(raw: string | null | undefined): DashLayout {
  if (!raw) return { order: [...DEFAULT_DASH_ORDER], collapsed: [] };
  try {
    const value = JSON.parse(raw) as { order?: unknown; collapsed?: unknown };
    const order = completeOrder(Array.isArray(value?.order) ? value.order.filter((id): id is string => typeof id === 'string') : []);
    const collapsed = Array.isArray(value?.collapsed) ? [...new Set(value.collapsed.filter(isBlockId))] : [];
    return { order, collapsed };
  } catch {
    return { order: [...DEFAULT_DASH_ORDER], collapsed: [] };
  }
}

export function serializeDashLayout(layout: DashLayout): string {
  return JSON.stringify({ v: 1, order: layout.order, collapsed: layout.collapsed });
}

/** Is dit de standaardindeling? Dan valt er niets te herstellen. */
export function isDefaultDashLayout(layout: DashLayout): boolean {
  return layout.collapsed.length === 0 && layout.order.every((id, index) => id === DEFAULT_DASH_ORDER[index]);
}

/**
 * Zet een blok op plek `toIndex` tussen de blokken die in beeld zijn. Blokken
 * die deze persoon niet ziet (geen recht op de module, of nog niets te tonen)
 * houden hun plek in de bewaarde volgorde; anders schoof het wisselen van
 * Vandaag en Aandacht ook de rapportages van een collega met meer rechten op.
 */
export function moveDashBlock(order: readonly DashBlockId[], id: DashBlockId, toIndex: number, visible: ReadonlySet<DashBlockId>): DashBlockId[] {
  const shown = order.filter(block => visible.has(block));
  const from = shown.indexOf(id);
  if (from < 0) return [...order];
  const next = shown.filter(block => block !== id);
  const at = Math.max(0, Math.min(next.length, Math.round(toIndex)));
  next.splice(at, 0, id);
  let cursor = 0;
  return order.map(block => (visible.has(block) ? next[cursor++] : block));
}

/** Eén plek omhoog (-1) of omlaag (+1) tussen de blokken in beeld. */
export function stepDashBlock(order: readonly DashBlockId[], id: DashBlockId, delta: number, visible: ReadonlySet<DashBlockId>): DashBlockId[] {
  const shown = order.filter(block => visible.has(block));
  const from = shown.indexOf(id);
  if (from < 0) return [...order];
  return moveDashBlock(order, id, from + delta, visible);
}

export function toggleDashBlock(layout: DashLayout, id: DashBlockId): DashLayout {
  return layout.collapsed.includes(id)
    ? { ...layout, collapsed: layout.collapsed.filter(block => block !== id) }
    : { ...layout, collapsed: [...layout.collapsed, id] };
}

export type DashRow =
  | { kind: 'single'; id: DashBlockId }
  /** Een brede kolom met één of meer smalle blokken ernaast. `sideFirst`: de
   *  smalle kolom staat links, omdat je die blokken vóór het brede zette. */
  | { kind: 'pair'; main: DashBlockId; side: DashBlockId[]; sideFirst: boolean };

/**
 * Van volgorde naar rijen. Een breed blok (`main`) neemt de smalle blokken
 * (`side`) die er direct op volgen naast zich; smalle blokken direct vóór een
 * breed blok staan er links naast. Alle andere blokken staan op een eigen rij.
 * Zo ziet de standaardvolgorde er precies uit als het dashboard vóór deze
 * ronde: Vandaag met Aandacht ernaast, en de rapportages met de inrichting en
 * het logboek.
 */
export function dashRows(ids: readonly DashBlockId[]): DashRow[] {
  const rows: DashRow[] = [];
  let index = 0;
  while (index < ids.length) {
    const id = ids[index];
    const size = dashBlockSize(id);
    if (size === 'main') {
      const side: DashBlockId[] = [];
      let next = index + 1;
      while (next < ids.length && dashBlockSize(ids[next]) === 'side') side.push(ids[next++]);
      rows.push(side.length > 0 ? { kind: 'pair', main: id, side, sideFirst: false } : { kind: 'single', id });
      index = next;
      continue;
    }
    if (size === 'side') {
      let end = index;
      while (end < ids.length && dashBlockSize(ids[end]) === 'side') end++;
      if (end < ids.length && dashBlockSize(ids[end]) === 'main') {
        rows.push({ kind: 'pair', main: ids[end], side: ids.slice(index, end), sideFirst: true });
        index = end + 1;
        continue;
      }
      for (const sideId of ids.slice(index, end)) rows.push({ kind: 'single', id: sideId });
      index = end;
      continue;
    }
    rows.push({ kind: 'single', id });
    index++;
  }
  return rows;
}
