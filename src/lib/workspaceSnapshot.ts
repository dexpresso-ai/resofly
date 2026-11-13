/**
 * De vorige stand van de werkruimte, op dit apparaat.
 *
 * Tot november 2026 begon elke start van de app bij nul: "ResoFly is aan het
 * laden…" tot de organisatie en de kern binnen waren, ook als je alleen even
 * de agenda opende. Op een telefoon start een geïnstalleerde app bijna altijd
 * opnieuw, dus dat wachten kwam elke keer terug.
 *
 * Nu bewaart de app na elke geslaagde laadronde wat er in beeld stond: de
 * organisatie (met je rol en modulerechten), de kern en de groepen die al
 * geladen waren. Bij de volgende start staat dat er meteen, en haalt de app op
 * de achtergrond de nieuwe stand op. Dat is dezelfde stand als een app die een
 * uur open heeft gestaan: wijzigingen van collega's komen bij de eerstvolgende
 * ronde binnen. De groepen gelden als verouderd en worden ververst zodra een
 * pagina ze nodig heeft (src/lib/dataGroups.ts).
 *
 * Grenzen, en waarom:
 *  - Per gebruiker één organisatie: de laatst geopende. Alleen voor wie nu is
 *    ingelogd, en alleen als dat ook de organisatie is die de app gaat openen.
 *    Wat van een andere gebruiker is, gaat bij de start weg; bij uitloggen
 *    alles (src/lib/signOut.ts).
 *  - Alleen van dezelfde versie van de app. Een nieuwe versie kan een veld
 *    verwachten dat in een oude stand ontbreekt, en dan valt het scherm om
 *    voordat de nieuwe gegevens er zijn.
 *  - Hooguit twee weken oud: wie de app zo lang niet opende, wacht liever even
 *    dan dat hij een stand van toen ziet.
 *
 * Elke groep staat in een eigen record, zodat de losse apps (Agenda,
 * Financiën, Communicatie) elkaars groepen niet overschrijven: de agenda
 * bewaart de uren, Financiën de boekhouding.
 *
 * Elk record draagt de rechten waarmee het is opgehaald (`access`, de
 * accessKey uit main.tsx). Een groep komt alleen terug bij een kern met
 * dezelfde rechten, en bij het bewaren gaat elke groep weg die niet meer past.
 * Anders kon de boekhouding van iemand voor wie Financiën was dichtgezet, bij
 * elke start terugkomen (gevonden in de review, 13 november).
 */
import type { AppData, OrganizationContext } from '../types.ts';
import { DATA_GROUPS, GROUP_FIELDS, type DataGroup } from './dataGroups.ts';

/** De versie van de app: bij elke build een nieuwe (vite.config.ts). */
export const APP_BUILD: string = typeof __RESOFLY_BUILD__ === 'string' ? __RESOFLY_BUILD__ : 'onbekend';

export const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Hoe lang de start op de opslag wacht. Hangt IndexedDB (dat gebeurt in
 * Safari), dan laadt de app gewoon; dat duurt toch al langer dan dit.
 */
const READ_TIMEOUT_MS = 600;

/** Hoe lang openen mag duren. Daarna geldt de opslag als afwezig, ook bij bewaren en wissen. */
const OPEN_TIMEOUT_MS = 1500;

interface RecordBase {
  build: string;
  userId: string;
  organizationId: string;
  /** De rechten waarmee dit is opgehaald (accessKey in main.tsx). */
  access: string;
  savedAt: number;
}

export interface CoreRecord extends RecordBase {
  kind: 'kern';
  context: OrganizationContext;
  /** AppData zonder de velden van de groepen. */
  core: Partial<AppData>;
}

export interface GroupRecord extends RecordBase {
  kind: 'groep';
  group: DataGroup;
  data: Partial<AppData>;
}

export interface RestoredWorkspace {
  context: OrganizationContext;
  data: AppData;
  /** De groepen die in `data` zitten. */
  groups: DataGroup[];
  savedAt: number;
}

export interface SnapshotKey {
  userId: string;
  organizationId: string;
  build: string;
  now: number;
}

const GROUP_FIELD_SET: ReadonlySet<string> = new Set(DATA_GROUPS.flatMap(group => [...GROUP_FIELDS[group]]));

/** Mag deze stand nu in beeld? Van wie er is ingelogd, van de organisatie die opengaat, van deze versie, en niet te oud. */
export function recordUsable(record: RecordBase | null | undefined, key: SnapshotKey): boolean {
  if (!record) return false;
  if (record.userId !== key.userId || record.organizationId !== key.organizationId) return false;
  if (record.build !== key.build) return false;
  const age = key.now - record.savedAt;
  return age >= 0 && age <= SNAPSHOT_MAX_AGE_MS;
}

/**
 * De werkruimte uit een kern en de groepen die erbij horen. Geeft null als de
 * kern niet bruikbaar is, of niet bij de organisatie van zijn eigen context
 * hoort. Een groep die niet past, blijft weg: die laadt de pagina zelf.
 */
export function restoreWorkspace(
  core: CoreRecord | null | undefined,
  groups: readonly (GroupRecord | null | undefined)[],
  key: SnapshotKey,
  base: AppData,
): RestoredWorkspace | null {
  if (!core || core.kind !== 'kern' || !recordUsable(core, key)) return null;
  if (core.context?.activeOrganization?.id !== key.organizationId) return null;
  const data: AppData = { ...base };
  for (const [field, value] of Object.entries(core.core ?? {})) {
    if (!GROUP_FIELD_SET.has(field)) (data as unknown as Record<string, unknown>)[field] = value;
  }
  const restored: DataGroup[] = [];
  for (const record of groups) {
    if (!record || record.kind !== 'groep' || !DATA_GROUPS.includes(record.group) || !recordUsable(record, key)) continue;
    // Opgehaald met andere rechten dan de kern: misschien van een module die nu dicht is.
    if (typeof record.access !== 'string' || record.access !== core.access) continue;
    if (restored.includes(record.group)) continue;
    const fields = GROUP_FIELDS[record.group] as readonly string[];
    // Een groep is heel of hij is er niet: een pagina met de helft zou een lege lijst tonen.
    if (!fields.every(field => Array.isArray((record.data as Record<string, unknown> | undefined)?.[field]))) continue;
    for (const field of fields) (data as unknown as Record<string, unknown>)[field] = (record.data as Record<string, unknown>)[field];
    restored.push(record.group);
  }
  return { context: core.context, data, groups: DATA_GROUPS.filter(group => restored.includes(group)), savedAt: core.savedAt };
}

/** De kern van `data`: alles behalve de velden van de groepen. */
export function coreOf(data: AppData): Partial<AppData> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) if (!GROUP_FIELD_SET.has(field)) out[field] = value;
  return out as Partial<AppData>;
}

/** De velden van één groep. */
export function groupOf(data: AppData, group: DataGroup): Partial<AppData> {
  const out: Record<string, unknown> = {};
  for (const field of GROUP_FIELDS[group]) out[field] = (data as unknown as Record<string, unknown>)[field];
  return out as Partial<AppData>;
}

const coreKey = (userId: string) => `${userId}|kern`;
const groupKey = (userId: string, group: DataGroup) => `${userId}|groep|${group}`;

// ── IndexedDB ────────────────────────────────────────────────────────────────

const DB_NAME = 'resofly-werkruimte';
const STORE = 'stand';
let dbPromise: Promise<IDBDatabase | null> | null = null;

/**
 * De database, of null als die er niet is of niet op tijd opengaat. Een
 * mislukte of te trage poging wordt niet onthouden: de volgende probeert het
 * opnieuw. Zonder tijdslimiet bleef Uitloggen hangen als IndexedDB hing, want
 * dat wacht op het wissen.
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const attempt: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>(resolve => {
    const fail = () => { if (dbPromise === attempt) dbPromise = null; resolve(null); };
    const timer = setTimeout(fail, OPEN_TIMEOUT_MS);
    try {
      if (typeof indexedDB === 'undefined') { clearTimeout(timer); fail(); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const db = request.result;
        const forget = () => { if (dbPromise === attempt) dbPromise = null; };
        // Een nieuwere versie in een ander venster wil de database ombouwen: loslaten.
        db.onversionchange = () => { db.close(); forget(); };
        // Safari verbreekt de verbinding soms ("Connection to Indexed Database server lost").
        db.onclose = forget;
        resolve(db);
      };
      request.onerror = () => { clearTimeout(timer); fail(); };
      request.onblocked = () => { clearTimeout(timer); fail(); };
    } catch {
      // Privévenster of afgeschermde opslag: dan zonder vorige stand.
      clearTimeout(timer);
      fail();
    }
  });
  dbPromise = attempt;
  return attempt;
}

/** Na een fout in een transactie: misschien is de verbinding dood. De volgende keer een nieuwe. */
function forgetDb() {
  dbPromise = null;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** De vorige stand voor deze gebruiker en organisatie, of null. Wacht nooit langer dan READ_TIMEOUT_MS. */
export async function readSnapshot(userId: string, organizationId: string, base: AppData): Promise<RestoredWorkspace | null> {
  const read = (async () => {
    const db = await openDb();
    if (!db) return null;
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const [core, groups] = await Promise.all([
      requestValue(store.get(coreKey(userId)) as IDBRequest<CoreRecord | undefined>),
      Promise.all(DATA_GROUPS.map(group => requestValue(store.get(groupKey(userId, group)) as IDBRequest<GroupRecord | undefined>))),
    ]);
    return restoreWorkspace(core, groups, { userId, organizationId, build: APP_BUILD, now: Date.now() }, base);
  })().catch(() => { forgetDb(); return null; });
  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), READ_TIMEOUT_MS));
  return Promise.race([read, timeout]);
}

/** Per record wat er de laatste keer is weggeschreven, zodat een groep die niet veranderde niet opnieuw gaat. */
const lastWritten = new Map<string, readonly unknown[]>();
const sameRefs = (a: readonly unknown[] | undefined, b: readonly unknown[]) => !!a && a.length === b.length && a.every((value, i) => value === b[i]);

export interface SnapshotInput {
  userId: string;
  organizationId: string;
  /** De rechten waarmee `data` is opgehaald (accessKey in main.tsx). */
  access: string;
  context: OrganizationContext;
  data: AppData;
  /** De groepen die geladen zijn. */
  groups: readonly DataGroup[];
}

/** De stand van nu bewaren. Een fout (opslag vol, geblokkeerd) is geen fout van de app: dan de volgende keer zonder. */
export async function saveSnapshot(input: SnapshotInput): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const savedAt = Date.now();
    const base = { build: APP_BUILD, userId: input.userId, organizationId: input.organizationId, access: input.access, savedAt };
    const writes: Array<[string, CoreRecord | GroupRecord, readonly unknown[]]> = [];
    const core = coreOf(input.data);
    const coreRefs = [input.organizationId, input.access, input.context, ...Object.values(core)];
    // De kern gaat altijd: zijn savedAt zegt hoe oud de stand is.
    writes.push([coreKey(input.userId), { ...base, kind: 'kern', context: input.context, core }, coreRefs]);
    for (const group of input.groups) {
      const data = groupOf(input.data, group);
      const refs = [input.organizationId, input.access, ...Object.values(data)];
      const key = groupKey(input.userId, group);
      if (sameRefs(lastWritten.get(key), refs)) continue;
      writes.push([key, { ...base, kind: 'groep', group, data }, refs]);
    }
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const [key, record] of writes) store.put(record, key);
    // De andere groepen blijven alleen als ze nog bij deze kern passen: zelfde
    // organisatie, rechten en versie. Een groep van een vorige organisatie of
    // van een module die nu dicht is, gaat weg.
    for (const group of DATA_GROUPS) {
      if (input.groups.includes(group)) continue;
      const key = groupKey(input.userId, group);
      const request = store.get(key) as IDBRequest<GroupRecord | undefined>;
      request.onsuccess = () => {
        const record = request.result;
        if (record && (record.organizationId !== input.organizationId || record.access !== input.access || record.build !== APP_BUILD)) {
          store.delete(key);
          lastWritten.delete(key);
        }
      };
    }
    await done(tx);
    for (const [key, , refs] of writes) lastWritten.set(key, refs);
  } catch (error) {
    forgetDb();
    console.warn('De stand van de werkruimte kon niet op dit apparaat worden bewaard.', error);
  }
}

/** Alles weg (uitloggen), of alles behalve van deze gebruiker (een andere gebruiker logt in). */
export async function clearSnapshots(keepUserId?: string): Promise<void> {
  lastWritten.clear();
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    if (!keepUserId) {
      store.clear();
    } else {
      const keys = await requestValue(store.getAllKeys());
      for (const key of keys) if (typeof key !== 'string' || !key.startsWith(`${keepUserId}|`)) store.delete(key);
    }
    await done(tx);
    // Nog eens: een bewaarronde die vóór het wissen klaar was, kan zijn
    // boekhouding net daarna hebben bijgewerkt. Dan dacht de volgende ronde
    // dat een groep er nog stond, en sloeg hem over.
    lastWritten.clear();
  } catch (error) {
    forgetDb();
    console.warn('De bewaarde stand van de werkruimte kon niet worden gewist.', error);
  }
}
