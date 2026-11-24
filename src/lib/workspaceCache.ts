/**
 * Starten uit de cache: de werkruimte van de vorige keer meteen tonen, en op
 * de achtergrond verversen.
 *
 * Waarom: ook met alles vooruit (lib/opstartverzoeken.ts) wachtte het eerste
 * scherm op de hele ronde naar de database en daarna op de eerste render.
 * Op een telefoon was dat bij een tweede start nog ~1,1-1,3 s, en op een
 * trage verbinding of met een drukke database veel meer.
 *
 * Wat er bewaard wordt, per gebruiker en organisatie (IndexedDB, op dit
 * apparaat): het lidmaatschap en de organisatie (OrganizationContext, zonder
 * het abonnementsoverzicht), de kern van de werkruimte (CoreData, zonder het
 * briefpapier) en de gegevensgroepen van de pagina die openstond. Niet meer.
 *
 * De regels:
 *  - de database blijft de baas. De ronde naar de database loopt zoals
 *    altijd; zodra die binnen is, vervangt hij alles. Tot dan kun je alleen
 *    kijken: opslaan, versturen en boeken wachten (orgCanWrite in main.tsx).
 *    Geld en bewaarplicht (regel 6) gaan zo nooit uit van oude gegevens;
 *  - organization_id komt nooit uit de cache (regel 1). Het lidmaatschap
 *    bepaalt welke organisatie het wordt. Kiest dat een andere, of zijn de
 *    rechten veranderd (rol, modules, status), dan gaat de cache weg en laadt
 *    de werkruimte zoals bij een eerste start (regel 3);
 *  - alleen met een sessie, alleen voor dezelfde gebruiker, hooguit 7 dagen
 *    oud, en alleen met dezelfde versie van deze opslag;
 *  - uitloggen (hier of elders) wist alles, van iedereen op dit apparaat.
 *
 * Verander je de vorm van AppData of OrganizationContext zo dat oude gegevens
 * de app kunnen laten struikelen (een veld van type wisselen), verhoog dan
 * WORKSPACE_CACHE_VERSIE. Een nieuw veld hoeft niet: wat ontbreekt, vult de
 * app aan met de lege waarde.
 */
import type { AppData, OrganizationContext, OrganizationMembershipView } from '../types.ts';
import type { CoreData, DataGroup } from './dataGroups.ts';

export const WORKSPACE_CACHE_VERSIE = 1;
export const WORKSPACE_CACHE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const DB_NAAM = 'resofly-werkruimte';
const STORE = 'werkruimte';

export interface WorkspaceCacheEntry {
  v: number;
  userId: string;
  orgId: string;
  at: number;
  /** Rol, modules en status van het lidmaatschap toen dit werd bewaard. */
  rechten: string;
  organizationContext: OrganizationContext;
  core: CoreData;
  /** Alleen de groepen van de pagina die openstond. */
  groups: Partial<Record<DataGroup, Partial<AppData>>>;
}

/** Wat de rechten van dit lid bepaalt. Verandert dit, dan geldt de cache niet meer. */
export function rechtenVan(membership: Pick<OrganizationMembershipView, 'role' | 'status' | 'module_access' | 'accountant_can_book'> | null | undefined): string {
  if (!membership) return '';
  const modules = membership.module_access && typeof membership.module_access === 'object'
    ? Object.keys(membership.module_access).sort().map(key => `${key}=${String((membership.module_access as Record<string, unknown>)[key])}`).join(',')
    : '';
  return `${membership.role}|${membership.status ?? ''}|${modules}|${membership.accountant_can_book ? 'boekt' : ''}`;
}

/** De cache, als hij voor deze gebruiker en organisatie nu bruikbaar is. Anders null. */
export function bruikbareCache(entry: unknown, { userId, orgId, now = Date.now() }: { userId: string; orgId: string; now?: number }): WorkspaceCacheEntry | null {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Partial<WorkspaceCacheEntry>;
  if (e.v !== WORKSPACE_CACHE_VERSIE) return null;
  if (e.userId !== userId || e.orgId !== orgId) return null;
  if (typeof e.at !== 'number' || now - e.at > WORKSPACE_CACHE_MAX_MS || e.at > now + 60_000) return null;
  const context = e.organizationContext;
  // De bewaarde organisatie en het lidmaatschap moeten bij elkaar en bij de sleutel passen.
  if (!context || context.activeOrganization?.id !== orgId || !context.activeMembership) return null;
  if (context.activeMembership.organization_id !== orgId || context.activeMembership.user_id !== userId) return null;
  if (e.rechten !== rechtenVan(context.activeMembership)) return null;
  if (!e.core || typeof e.core !== 'object' || !e.groups || typeof e.groups !== 'object') return null;
  return e as WorkspaceCacheEntry;
}

export function cacheSleutel(userId: string, orgId: string): string {
  return `${userId}:${orgId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAAM, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB geblokkeerd'));
  });
}

function klaar(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('afgebroken'));
  });
}

/** Leest de cache; null als er geen bruikbare is, of IndexedDB er niet is (privévenster). */
export async function readWorkspaceCache(userId: string, orgId: string): Promise<WorkspaceCacheEntry | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    try {
      const entry = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(cacheSleutel(userId, orgId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return bruikbareCache(entry, { userId, orgId });
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Bewaart de cache, en ruimt meteen op wat ouder is dan 7 dagen. */
export async function writeWorkspaceCache(entry: WorkspaceCacheEntry): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.put(entry, cacheSleutel(entry.userId, entry.orgId));
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return;
        const value = c.value as Partial<WorkspaceCacheEntry> | undefined;
        if (!value || typeof value.at !== 'number' || entry.at - value.at > WORKSPACE_CACHE_MAX_MS) c.delete();
        c.continue();
      };
      await klaar(tx);
    } finally {
      db.close();
    }
  } catch {
    // Vol of geblokkeerd: dan start de volgende keer gewoon zonder cache.
  }
}

/** Eén organisatie van één gebruiker weg (andere organisatie gekozen, rechten veranderd). */
export async function dropWorkspaceCache(userId: string, orgId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(cacheSleutel(userId, orgId));
      await klaar(tx);
    } finally {
      db.close();
    }
  } catch { /* niets te doen */ }
}

/** Uitloggen: alles weg, van iedereen op dit apparaat. */
export async function clearWorkspaceCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>(resolve => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAAM);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Een ander venster heeft hem nog open: het verwijderen gaat door zodra
      // dat sluit. Daar wachten we niet op.
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}
