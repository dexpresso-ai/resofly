/**
 * "De mailmappen zijn gewijzigd, buiten dit scherm om."
 *
 * Berichten en het klantdossier laden hun gesprekken en mappen zelf; ze zitten
 * niet in AppData. Een voorstel van Gerrie dat iemand goedkeurt (een map maken,
 * mail verplaatsen) ververst na afloop wel AppData, maar daar merkten die twee
 * schermen niets van: de verplaatste mail stond er tot je de pagina opnieuw
 * opende nog op zijn oude plek. De uitvoerders in `actions/mailFolders.ts`
 * roepen daarom dit aan, en `useMailFolders` luistert.
 *
 * Bewust zonder React en zonder Supabase, zodat het ook in `npm test` te laden is.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onMailFoldersChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function mailFoldersChanged(): void {
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* één kapotte luisteraar mag de rest niet stilzetten */ }
  }
}
