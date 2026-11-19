/**
 * Een onderdeel dat los geladen wordt (pdf-lib, de lettertypen, het
 * klantportaal) en na een nieuwe versie niet meer te halen is.
 *
 * Waarom: Cloudflare Pages serveert alleen de bestanden van de laatste deploy.
 * Een venster dat al openstond, verwijst nog naar de oude bestandsnamen; vraagt
 * het zo'n bestand op, dan krijgt het index.html terug en mislukt de import.
 * Zonder dit faalde dan bijvoorbeeld "Download PDF" met een technische melding,
 * tot je zelf op het idee kwam de pagina te herladen.
 *
 * Vite meldt elke mislukte dynamische import als `vite:preloadError`. We kijken
 * dan of er echt een nieuwe versie staat (een andere hoofdbundel in index.html).
 * Zo ja, dan vragen we of je wilt herladen; niet vanzelf, want een open venster
 * met niet-opgeslagen invoer zou dan zonder waarschuwing verdwijnen. Zo nee
 * (de verbinding hapert), dan zeggen we niets: de handeling meldt zelf dat hij
 * mislukte, en een tweede poging werkt dan gewoon.
 */

/** De hoofdbundel waarmee deze pagina draait, uit de scripttag van index.html. */
function currentEntry(): string | null {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return script ? new URL(script.src, location.href).pathname : null;
}

/** De hoofdbundel die index.html nu noemt, of null als dat niet te zeggen is. */
async function deployedEntry(): Promise<string | null> {
  const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) return null;
  const html = await response.text();
  const match = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/.exec(html);
  return match ? new URL(match[1], location.href).pathname : null;
}

let asking = false;

export function installChunkReload(): void {
  window.addEventListener('vite:preloadError', () => {
    if (asking) return;
    const running = currentEntry();
    // In de dev-server (geen /assets/) valt er niets te vergelijken.
    if (!running) return;
    asking = true;
    deployedEntry()
      .then(deployed => {
        if (!deployed || deployed === running) return;
        const reload = window.confirm(
          'Er staat een nieuwe versie van ResoFly klaar. Dit onderdeel laadt pas na herladen.\n\n'
          + 'Nu herladen? Wat je nog niet hebt opgeslagen, gaat dan verloren.',
        );
        if (reload) window.location.reload();
      })
      .catch(() => { /* geen verbinding: de handeling meldt zelf dat hij mislukte */ })
      .finally(() => { asking = false; });
  });
}
