/*
 * ResoFly — service worker voor OS-/device-pushmeldingen.
 *
 * BEWUST GEEN fetch-handler: deze worker draait op scope "/" en mag de app-routing
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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Een bestaand app-venster hergebruiken (focussen) i.p.v. een tweede te openen.
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if ('navigate' in client && targetUrl && targetUrl !== '/') {
            client.navigate(targetUrl).catch(() => {});
          }
          return undefined;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    }),
  );
});
