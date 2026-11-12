/**
 * Tests voor de losse apps (Agenda, Financiën, Communicatie). Draaien met:  npm test
 *
 * Een app is een adres, een manifest en een lijst pagina's. Lopen die uit
 * elkaar, dan merk je het pas op een telefoon: de browser biedt installeren
 * niet aan (scope klopt niet met het adres), het icoon ontbreekt, of een
 * nieuwe pagina van Financiën staat niet in het menu van de app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appHomePage, availableApps, canonicalAppUrl, isPageInApp, STANDALONE_APPS, standaloneAppFromPath } from './standaloneApps.ts';
import { buildPermissions, PAGE_MODULE } from './permissions.ts';
import { PAGE_TITLES } from './workspaceTabs.ts';
import { installHint } from './installPrompt.ts';
import { breadcrumbTrail } from './breadcrumbs.ts';
import type { AppData } from '../types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = (id: string) => STANDALONE_APPS.find(a => a.id === id)!;

test('een adres hoort bij de goede app, met of zonder slash', () => {
  assert.equal(standaloneAppFromPath('/app/agenda/')?.id, 'agenda');
  assert.equal(standaloneAppFromPath('/app/agenda')?.id, 'agenda');
  assert.equal(standaloneAppFromPath('/app/financien/')?.id, 'financien');
  assert.equal(standaloneAppFromPath('/app/communicatie')?.id, 'communicatie');
  // De werkruimte, de publieke pagina's en de manifesten zelf zijn geen app.
  for (const other of ['/', '/app/', '/app/agendas', '/apps/agenda.webmanifest', '/portal', '/invoice/abc', '/agenda']) {
    assert.equal(standaloneAppFromPath(other), null, other);
  }
});

test('zonder slash zet de app hem erbij, en houdt hij de rest van het adres', () => {
  assert.equal(canonicalAppUrl(app('agenda'), { pathname: '/app/agenda', search: '?chat=1', hash: '#x' }), '/app/agenda/?chat=1#x');
  assert.equal(canonicalAppUrl(app('agenda'), { pathname: '/app/agenda/', search: '', hash: '' }), null);
});

test('elke pagina van de module hoort in zijn app, en niets daarbuiten', () => {
  const pagesOf = (module: string) => Object.entries(PAGE_MODULE).filter(([, m]) => m === module).map(([page]) => page).sort();
  // Een nieuwe pagina in Financiën staat zo vanzelf ook in het menu van de app.
  assert.deepEqual([...app('financien').pages].sort(), pagesOf('finance'));
  assert.deepEqual([...app('agenda').pages].sort(), pagesOf('calendar'));
  assert.deepEqual([...app('communicatie').pages].sort(), ['chat', 'communication', 'marketing']);
});

test('elke pagina van een app bestaat en hangt aan een module', () => {
  for (const a of STANDALONE_APPS) {
    for (const page of [...a.pages, ...a.home, ...a.dock.map(item => item.page)]) {
      assert.ok(PAGE_TITLES[page], `${a.id}: ${page} bestaat niet`);
      // Een pagina zonder module staat voor iedereen open (canOpenPage); dan
      // zou de app hem ook tonen aan wie de module dicht heeft.
      assert.ok(PAGE_MODULE[page], `${a.id}: ${page} hangt aan geen module`);
      assert.ok(isPageInApp(a, page), `${a.id}: ${page} staat niet in pages`);
    }
    assert.ok(a.dock.length >= 1 && a.dock.length <= 5, `${a.id}: duimbalk met ${a.dock.length} knoppen`);
    assert.equal(a.path, `/app/${a.id}/`);
  }
});

test('de boekhouder krijgt alleen de app Financiën, en die opent op Facturen', () => {
  const accountant = buildPermissions({ role: 'accountant' });
  assert.deepEqual(availableApps(accountant.canOpenPage).map(a => a.id), ['financien']);
  assert.equal(appHomePage(app('financien'), accountant.canOpenPage), 'invoices');
  assert.equal(appHomePage(app('agenda'), accountant.canOpenPage), null);
});

test('Communicatie opent op wat openstaat: zonder klanten op de chat', () => {
  const member = buildPermissions({ role: 'member', module_access: { clients: 'none', chat: 'write', marketing: 'none' } });
  assert.equal(appHomePage(app('communicatie'), member.canOpenPage), 'chat');
  const nothing = buildPermissions({ role: 'member', module_access: { clients: 'none', chat: 'none', marketing: 'none', calendar: 'none', finance: 'none' } });
  assert.deepEqual(availableApps(nothing.canOpenPage), []);
});

test('het manifest van elke app past bij zijn adres, en de iconen bestaan', () => {
  for (const a of STANDALONE_APPS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', a.manifest), 'utf8'));
    // id, scope en start_url gelijk aan het adres: anders installeert de
    // browser hem niet, of als een andere app.
    assert.equal(manifest.id, a.path, `${a.id}: id`);
    assert.equal(manifest.scope, a.path, `${a.id}: scope`);
    assert.equal(manifest.start_url, a.path, `${a.id}: start_url`);
    assert.equal(manifest.name, a.name, `${a.id}: name`);
    assert.equal(manifest.short_name, a.shortName, `${a.id}: short_name`);
    assert.equal(manifest.display, 'standalone');
    const sizes = new Set(manifest.icons.map((icon: { sizes: string }) => icon.sizes));
    assert.ok(sizes.has('192x192') && sizes.has('512x512'), `${a.id}: iconen 192 en 512`);
    assert.ok(manifest.icons.some((icon: { purpose: string }) => icon.purpose === 'maskable'), `${a.id}: maskable icoon`);
    for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(ROOT, 'public', icon.src)), `${a.id}: ${icon.src} ontbreekt`);
    assert.ok(fs.existsSync(path.join(ROOT, 'public', a.icon)), `${a.id}: ${a.icon} ontbreekt`);
  }
});

test('de service worker stuurt meldingen naar adressen die echt een app zijn', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  const paths = [...sw.matchAll(/'(\/app\/[^']+)'/g)].map(m => m[1]);
  assert.ok(paths.length > 0, 'geen app-adressen in sw.js');
  for (const p of paths) assert.ok(STANDALONE_APPS.some(a => a.path === p), `${p} in sw.js is geen app`);
});

test('de uitleg voor installeren past bij de browser', () => {
  const ua = (userAgent: string, maxTouchPoints = 0) => installHint({ userAgent, maxTouchPoints });
  assert.equal(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'ios');
  // Een iPad meldt zich als Mac, met een aanraakscherm.
  assert.equal(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 5), 'ios');
  assert.equal(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'), 'mac-safari');
  assert.equal(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'), 'chromium');
  assert.equal(ua('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 'chromium');
  assert.equal(ua('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'), 'other');
});

test('in een app begint het kruimelpad bij het begin van de app, niet bij het dashboard', () => {
  const data = { projects: [], clients: [{ id: 'c1', name: 'Bakkerij De Korenaar' }], galleries: [], companySettings: null } as unknown as AppData;
  const trail = (id: string, page: string, clientId: string | null = null) => {
    const a = app(id);
    return breadcrumbTrail({ page, projectId: null, clientId }, data, { page: a.home[0], label: a.shortName, pages: a.pages })
      .map(crumb => `${crumb.kind}:${crumb.label}${crumb.target ? `→${crumb.target.page}` : ''}`);
  };
  // Op het begin van de app: niets om naar terug te gaan.
  assert.deepEqual(trail('financien', 'invoices'), ['current:Facturen']);
  // Geen "Financiën › Financiën › Offertes": de menukop is de app zelf.
  assert.deepEqual(trail('financien', 'quotes'), ['home:Financiën→invoices', 'current:Offertes']);
  // Boekingslinks hangt onder de agenda; die staat al vooraan.
  assert.deepEqual(trail('agenda', 'meeting-booking'), ['home:Agenda→calendar', 'current:Boekingslinks']);
  // Een klant geopend vanuit de app: wel de kop en de lijst, en terug naar de app.
  assert.deepEqual(trail('financien', 'client', 'c1'), ['home:Financiën→invoices', 'section:Werk', 'page:Klanten→clients', 'current:Bakkerij De Korenaar']);
  // In de werkruimte verandert er niets.
  assert.deepEqual(breadcrumbTrail({ page: 'quotes', projectId: null, clientId: null }, data).map(c => c.label), ['Dashboard', 'Financiën', 'Offertes']);
});
