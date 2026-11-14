// Dubbele bestanden in een galerij-album: herkennen vóór het uploaden, en een
// vrije naam kiezen als de gebruiker het bestand toch wil hebben.
//
// "Dubbel" betekent: dezelfde bestandsnaam als een bestand dat al in het album
// staat, of als een eerder bestand in dezelfde upload. Hoofdletters tellen niet
// mee, en Unicode wordt eerst gelijkgetrokken (NFC). Zonder dat laatste zag
// "Café.jpg" van een Mac (NFD) er hetzelfde uit als "Café.jpg" van Windows,
// maar was het voor de vergelijking een ander bestand. En zonder hoofdletters
// gelijk te trekken botsten "IMG_0001.JPG" en "img_0001.jpg" pas in de zip of
// bij de klant die alles uitpakt op een Mac.
//
// De database bewaakt dezelfde regel (migratie 20261114150000). Deze module is
// er om het vóór het uploaden te zien, zodat de gebruiker kan kiezen en er
// geen gigabytes voor niets naar Cloudflare gaan.

export type ExistingGalleryFile = { file_name: string; size_bytes?: number | null };
export type IncomingGalleryFile = { name: string; size: number };

export type GalleryDuplicateChoice = 'skip' | 'rename';

export type GalleryDuplicate = {
  /** Plek in de lijst met nieuwe bestanden. */
  index: number;
  name: string;
  /** 'album': staat al in het album. 'batch': zit eerder in dezelfde upload. */
  kind: 'album' | 'batch';
  /**
   * Even groot als het bestand waarmee hij botst. Dan is het vrijwel zeker
   * hetzelfde bestand nog een keer; anders is het een ander beeld met toevallig
   * dezelfde naam (twee camera's die allebei bij IMG_0001 beginnen).
   */
  sameSize: boolean;
};

export type GalleryUploadPlanEntry = {
  /** Plek in de lijst met nieuwe bestanden. */
  index: number;
  /** De naam waaronder het bestand in het album komt. */
  name: string;
  renamed: boolean;
};

export type GalleryUploadPlan = {
  entries: GalleryUploadPlanEntry[];
  skipped: number;
  renamed: number;
  /** Dubbele bestanden waarvoor nog geen keuze is gemaakt; die gaan niet mee. */
  undecided: number;
};

/** De naam zoals hij wordt bewaard: zonder spaties eromheen en in NFC. */
export function cleanGalleryFileName(name: string): string {
  return String(name ?? '').trim().normalize('NFC');
}

/** De sleutel waarop twee namen als dezelfde gelden. */
export function galleryFileNameKey(name: string): string {
  return cleanGalleryFileName(name).toLowerCase();
}

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  // Een punt vooraan ("…/.jpg") is geen extensie; zo doet de zip het ook.
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' };
}

/**
 * Een naam die nog niet bezet is: "IMG_0001.jpg" wordt "IMG_0001-2.jpg", en is
 * die er ook al, "IMG_0001-3.jpg". Met een streepje en niet "(2)": de worker
 * maakt van haakjes en spaties een underscore, en dan stond er in de zip en in
 * R2 "IMG_0001_2_.jpg".
 *
 * `taken` bevat sleutels (galleryFileNameKey), geen namen.
 */
export function freeGalleryFileName(name: string, taken: ReadonlySet<string>): string {
  const { stem, ext } = splitName(cleanGalleryFileName(name));
  // `taken` is eindig, dus deze lus eindigt altijd.
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!taken.has(galleryFileNameKey(candidate))) return candidate;
  }
}

/**
 * Welke van de nieuwe bestanden botsen met het album of met elkaar. Het eerste
 * bestand met een bepaalde naam is nooit dubbel binnen de upload zelf; pas het
 * tweede is dat.
 */
export function findGalleryDuplicates(
  files: readonly IncomingGalleryFile[],
  existing: readonly ExistingGalleryFile[],
): GalleryDuplicate[] {
  const inAlbum = new Map<string, Set<number>>();
  for (const row of existing) {
    const key = galleryFileNameKey(row.file_name);
    const sizes = inAlbum.get(key) ?? new Set<number>();
    if (typeof row.size_bytes === 'number') sizes.add(row.size_bytes);
    inAlbum.set(key, sizes);
  }
  const inBatch = new Map<string, Set<number>>();
  const duplicates: GalleryDuplicate[] = [];
  files.forEach((file, index) => {
    const key = galleryFileNameKey(file.name);
    const albumSizes = inAlbum.get(key);
    const batchSizes = inBatch.get(key);
    if (albumSizes) {
      duplicates.push({ index, name: file.name, kind: 'album', sameSize: albumSizes.has(file.size) });
    } else if (batchSizes) {
      duplicates.push({ index, name: file.name, kind: 'batch', sameSize: batchSizes.has(file.size) });
    }
    const sizes = batchSizes ?? new Set<number>();
    sizes.add(file.size);
    inBatch.set(key, sizes);
  });
  return duplicates;
}

/**
 * Wat er na de keuzes van de gebruiker wordt geüpload, en onder welke naam.
 * Een nieuwe naam ontwijkt alles wat al in het album staat, alle bestanden uit
 * deze upload die hun eigen naam houden, en de nieuwe namen die al eerder in
 * deze upload zijn uitgedeeld. Zo kan een hernoemd bestand nooit de naam
 * pakken van een bestand dat verderop in dezelfde upload zit.
 */
export function planGalleryUpload(
  files: readonly IncomingGalleryFile[],
  existing: readonly ExistingGalleryFile[],
  duplicates: readonly GalleryDuplicate[],
  choices: ReadonlyMap<number, GalleryDuplicateChoice>,
): GalleryUploadPlan {
  const duplicateAt = new Set(duplicates.map(d => d.index));
  const taken = new Set<string>(existing.map(row => galleryFileNameKey(row.file_name)));
  files.forEach((file, index) => {
    if (!duplicateAt.has(index)) taken.add(galleryFileNameKey(file.name));
  });

  const entries: GalleryUploadPlanEntry[] = [];
  let skipped = 0;
  let renamed = 0;
  let undecided = 0;
  files.forEach((file, index) => {
    if (!duplicateAt.has(index)) {
      entries.push({ index, name: cleanGalleryFileName(file.name), renamed: false });
      return;
    }
    const choice = choices.get(index);
    if (choice === 'skip') { skipped += 1; return; }
    if (choice !== 'rename') { undecided += 1; return; }
    const name = freeGalleryFileName(file.name, taken);
    taken.add(galleryFileNameKey(name));
    entries.push({ index, name, renamed: true });
    renamed += 1;
  });
  return { entries, skipped, renamed, undecided };
}

/** Moet gelijk blijven aan de hint in 20261114150000_galerij_dubbele_namen.sql. */
export const GALLERY_NAME_TAKEN_HINT = 'gallery_items_file_name_taken';

/**
 * Weigerde de database de naam omdat hij in dit album al bestaat? Dat gebeurt
 * alleen als iemand anders (of een ander tabblad) hem tussen de controle en het
 * opslaan pakte. De trigger zet daarvoor een eigen hint, zodat dit niet wordt
 * verward met een andere unieke sleutel.
 */
export function isGalleryNameTaken(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, hint } = error as { code?: unknown; hint?: unknown };
  return code === '23505' && hint === GALLERY_NAME_TAKEN_HINT;
}
