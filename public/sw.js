/*
 * ResoFly — service worker voor OS-/device-pushmeldingen.
 *
 * BEWUST GEEN fetch-handler: deze worker draait op scope "/" (ook voor de losse
 * apps onder /app/) en mag de app-routing
 * (/portal, /quote/:token, /invoice/:token, …) en de cross-origin R2/Supabase-calls
 * niet onderscheppen. Hij doet uitsluitend twee dingen: een push tonen en een klik
 * afhandelen.
 */

// Direct actief worden na installatie/update (geen tweede laadbeurt nodig).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_e) {
    data = { title: 'ResoFly', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'ResoFly';
  const options = {
    body: data.body || '',
    // Absolute paden zodat het icoon vanaf de site-root wordt geladen.
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/badge-72.png',
    // Zelfde tag → een nieuwe melding vervangt de vorige i.p.v. te stapelen.
    tag: data.tag || 'resofly',
    renotify: true,
    timestamp: Date.now(),
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/*
 * Losse apps (2026-11-12, src/lib/standaloneApps.ts): Agenda, Financiën en
 * Communicatie draaien elk in een eigen venster op /app/<naam>/. Een melding
 * hoort in het venster waar hij over gaat: een nieuwe mail of chat in
 * Communicatie, een boeking in Agenda, een betaalde factuur in Financiën. Het
 * soort staat vooraan in de tag ("chat:<id>", zie de migraties met web_push).
 *
 * Voorheen pakte een klik het eerste venster dat er was. Met losse apps kon dat
 * de app Agenda zijn, en dan opende een chatbericht in je agenda.
 */
const APP_FOR_KIND = { chat: '/app/communicatie/', email: '/app/communicatie/', booking: '/app/agenda/', invoice: '/app/financien/' };
const MODULE_APPS = ['/app/agenda/', '/app/financien/', '/app/communicatie/'];

/*
 * De werkruimte als app woont op /app/werkruimte/ (WORKSPACE_APP in
 * standaloneApps.ts). Een venster daar is de werkruimte, net als een venster op
 * "/". Een melding voor de werkruimte (/?chat=…) gaat in zo'n venster naar zijn
 * eigen adres: naar "/" zou hij buiten zijn app vallen en een adresbalk krijgen.
 * Is er geen venster, dan opent hij ook op dat adres; op Android komt hij zo in
 * de ResoFly-app terecht en niet in Chrome.
 */
const WORKSPACE_APP = '/app/werkruimte/';

const inModuleApp = (path) => MODULE_APPS.some((app) => path.startsWith(app));

function pathOf(url) {
  try { return new URL(url).pathname; } catch (_) { return '/'; }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = (event.notification.data && event.notification.data.url) || '/';
  // Alleen binnen de eigen app navigeren: een melding opent nooit een externe site.
  let targetUrl = '/';
  try {
    const resolved = new URL(rawUrl, self.location.origin);
    if (resolved.origin === self.location.origin) targetUrl = resolved.pathname + resolved.search + resolved.hash;
  } catch (_) {
    // Ongeldige url: gewoon naar de start.
  }
  const kind = String(event.notification.tag || '').split(':')[0];
  const appPath = APP_FOR_KIND[kind] || null;
  const targetPath = pathOf(new URL(targetUrl, self.location.origin).href);

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const windows = clientList.filter((client) => 'focus' in client);
      // 1. Het venster van de app waar de melding over gaat. De deeplink
      //    (?chat=…) gaat mee naar het adres van die app.
      const appWindow = appPath ? windows.find((client) => pathOf(client.url).startsWith(appPath)) : null;
      if (appWindow) {
        appWindow.focus();
        const search = new URL(targetUrl, self.location.origin).search;
        if ('navigate' in appWindow && search) appWindow.navigate(appPath + search).catch(() => {});
        return undefined;
      }
      // 2. Een venster op hetzelfde adres als de melding, of anders de werkruimte
      //    zelf. Nooit een losse app die er niets mee te maken heeft.
      const sameWindow = windows.find((client) => pathOf(client.url) === targetPath)
        || (inModuleApp(targetPath) ? null : windows.find((client) => !inModuleApp(pathOf(client.url))));
      const target = new URL(targetUrl, self.location.origin);
      const inWorkspaceApp = (path) => path.startsWith(WORKSPACE_APP);
      if (sameWindow) {
        sameWindow.focus();
        if ('navigate' in sameWindow && targetUrl && targetUrl !== '/') {
          const next = targetPath === '/' && inWorkspaceApp(pathOf(sameWindow.url)) ? WORKSPACE_APP + target.search + target.hash : targetUrl;
          sameWindow.navigate(next).catch(() => {});
        }
        return undefined;
      }
      // 3. Niets passends open: een nieuw venster op het adres van de melding,
      //    voor de werkruimte op het adres van de werkruimte-app.
      const fresh = targetPath === '/' ? WORKSPACE_APP + target.search + target.hash : targetUrl;
      if (self.clients.openWindow) return self.clients.openWindow(fresh);
      return undefined;
    }),
  );
});
