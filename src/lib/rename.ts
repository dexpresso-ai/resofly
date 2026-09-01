/**
 * Hernoemen in de verkenner (de Inhoud-pagina en het klantdossier-tabblad "Bestanden"),
 * met de regels die je uit Windows/OneDrive kent:
 *
 * - Je bewerkt de naam zónder de extensie: die staat er wel, maar alleen het stuk
 *   ervóór is geselecteerd zodra je begint te typen.
 * - Laat je de extensie weg, dan plakken we de oude er weer aan. Zonder `.docx`
 *   opent de online editor het bestand niet meer, en dat mag geen ongelukje zijn.
 * - Typ je bewust een ándere extensie, dan meldt `extensionChanged` dat, zodat de
 *   aanroeper er net als de Verkenner eerst voor kan waarschuwen.
 *
 * Mappen, notities en documenten dragen geen bestandsnaam maar een titel; die
 * roepen dit aan met `keepExtension = false` en houden dus nergens last van.
 */

/** Tekens die Windows in een bestandsnaam weigert — ze belanden ook in `a.download`. */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

/** De extensie inclusief punt (`.docx`), of `''` als de naam er geen heeft. */
export function fileExtension(name: string): string {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  // `.gitignore` is een naam, geen extensie: een punt op positie 0 telt niet mee.
  return !match || match.index === 0 ? '' : match[0];
}

/** De naam zonder extensie — precies het stuk dat bij het hernoemen geselecteerd staat. */
export function fileStem(name: string): string {
  const ext = fileExtension(name);
  return ext ? name.slice(0, -ext.length) : name;
}

export type RenameResult =
  | { changed: false }
  | { changed: true; name: string; extensionChanged: boolean };

/**
 * Wat een getypte naam wordt. Leeg of ongewijzigd levert `changed: false` op —
 * dan hoeft er niets naar de database.
 */
export function resolveRename(oldName: string, typed: string, keepExtension = false): RenameResult {
  const cleaned = typed.replace(ILLEGAL_CHARS, '').trim().replace(/\.+$/, '').trim();
  if (!cleaned) return { changed: false };

  if (!keepExtension) {
    return cleaned === oldName ? { changed: false } : { changed: true, name: cleaned, extensionChanged: false };
  }

  const oldExt = fileExtension(oldName);
  const name = oldExt && !fileExtension(cleaned) ? cleaned + oldExt : cleaned;
  if (name === oldName) return { changed: false };
  return {
    changed: true,
    name,
    extensionChanged: fileExtension(name).toLowerCase() !== oldExt.toLowerCase(),
  };
}
