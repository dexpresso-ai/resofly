/**
 * Tests voor "Volledige werkruimte" in een losse app. Draaien met:  npm test
 *
 * Tot 16 november opende de knop een pop-up met het adres van de werkruimte, ook
 * als de ResoFly-app geïnstalleerd was. Nu opent hij de app, of zegt hij eerst
 * dat je die moet installeren. Of dat lukt, hangt af van wat elk platform
 * toelaat; de regels daarvoor staan hier vast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  askBrowserForWorkspaceApp, forgetWorkspaceAppInstalled, INSTALL_PARAM, isAndroid, openInApp, planWorkspaceOpen,
  rememberWorkspaceAppInstalled, takeInstallRequest, WORKSPACE_INSTALL_URL, workspaceAppSeenInstalled, workspaceAppStatus,
} from './openWorkspaceApp.ts';
import { STANDALONE_APPS, WORKSPACE_APP } from './standaloneApps.ts';
import type { InstallHint } from './installPrompt.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readPublic = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'));

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

test('in een gewoon browsertabblad gaat de knop gewoon naar de werkruimte', () => {
  for (const hint of ['ios', 'mac-safari', 'chromium', 'other'] as InstallHint[]) {
    for (const status of ['installed', 'not-installed', 'unknown'] as const) {
      assert.equal(planWorkspaceOpen({ runningInstalled: false, hint, status }), 'same-tab', `${hint}/${status}`);
    }
  }
});

test('als app: openen als ResoFly er staat, anders eerst de melding om te installeren', () => {
  assert.equal(planWorkspaceOpen({ runningInstalled: true, hint: 'chromium', status: 'installed' }), 'open-app');
  assert.equal(planWorkspaceOpen({ runningInstalled: true, hint: 'chromium', status: 'not-installed' }), 'install-first');
  // Waar we niet kunnen kijken, gaat de link open. Staat ResoFly in het Dock,
  // dan opent macOS hem daar; anders Safari, met de uitleg om te installeren.
  assert.equal(planWorkspaceOpen({ runningInstalled: true, hint: 'mac-safari', status: 'unknown' }), 'open-app');
  assert.equal(planWorkspaceOpen({ runningInstalled: true, hint: 'other', status: 'unknown' }), 'open-app');
});

test('op een iPhone of iPad altijd de uitleg: daar kan de ene app de andere niet openen', () => {
  for (const status of ['installed', 'not-installed', 'unknown'] as const) {
    assert.equal(planWorkspaceOpen({ runningInstalled: true, hint: 'ios', status }), 'home-screen');
  }
});

test('alleen Chrome en Edge weten of ResoFly er staat', () => {
  for (const hint of ['ios', 'mac-safari', 'other'] as InstallHint[]) {
    assert.equal(workspaceAppStatus({ hint, seenInstalled: true, browserSays: true }), 'unknown', hint);
  }
  assert.equal(workspaceAppStatus({ hint: 'chromium', seenInstalled: true, browserSays: null }), 'installed');
  assert.equal(workspaceAppStatus({ hint: 'chromium', seenInstalled: false, browserSays: true }), 'installed');
  assert.equal(workspaceAppStatus({ hint: 'chromium', seenInstalled: false, browserSays: null }), 'not-installed');
  assert.equal(workspaceAppStatus({ hint: 'chromium', seenInstalled: false, browserSays: false }), 'not-installed');
  // Op de computer zegt de browser altijd nee vanuit een andere app (hij kijkt
  // alleen binnen de eigen scope). Dan telt wat de werkruimte-app zelf meldde.
  assert.equal(workspaceAppStatus({ hint: 'chromium', seenInstalled: true, browserSays: false }), 'installed');
});

test('de werkruimte-app laat een vlag achter die de losse apps kunnen lezen', () => {
  const store = memoryStore();
  assert.equal(workspaceAppSeenInstalled(store), false);
  rememberWorkspaceAppInstalled(store);
  assert.equal(workspaceAppSeenInstalled(store), true);
  forgetWorkspaceAppInstalled(store);
  assert.equal(workspaceAppSeenInstalled(store), false);
  // Geen opslag (privémodus): geen fout, en dan weten we het niet.
  const broken = { getItem: () => { throw new Error('nee'); }, setItem: () => { throw new Error('nee'); }, removeItem: () => { throw new Error('nee'); } };
  assert.doesNotThrow(() => rememberWorkspaceAppInstalled(broken));
  assert.equal(workspaceAppSeenInstalled(broken), false);
  assert.equal(workspaceAppSeenInstalled(null), false);
});

test('de browser vragen: alleen een ja voor het manifest van de werkruimte telt', async () => {
  const nav = (result: unknown) => ({ getInstalledRelatedApps: async () => { if (result instanceof Error) throw result; return result as never; } });
  assert.equal(await askBrowserForWorkspaceApp({}), null);
  assert.equal(await askBrowserForWorkspaceApp(undefined), null);
  assert.equal(await askBrowserForWorkspaceApp(nav(new Error('kapot'))), null);
  assert.equal(await askBrowserForWorkspaceApp(nav([])), false);
  assert.equal(await askBrowserForWorkspaceApp(nav([{ platform: 'webapp', url: 'https://staging.resofly.com/apps/agenda.webmanifest' }])), false);
  assert.equal(await askBrowserForWorkspaceApp(nav([{ platform: 'play', id: 'nl.resofly' }])), false);
  assert.equal(await askBrowserForWorkspaceApp(nav([{ platform: 'webapp', url: 'https://staging.resofly.com/manifest.webmanifest' }])), true);
});

test('Android herkennen aan de browser', () => {
  assert.equal(isAndroid('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36'), true);
  assert.equal(isAndroid('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36'), false);
});

test('openen is een klik op een link in een nieuw venster, geen pop-up', () => {
  // window.open met een derde argument is een pop-up, en die stuurt Chrome
  // niet door naar de geïnstalleerde app. Een link met target="_blank" wel.
  const events: string[] = [];
  const link = {
    href: '', target: '', rel: '', style: {} as Record<string, string>,
    click() { events.push(`click ${this.href} ${this.target} ${this.rel}`); },
    remove() { events.push('remove'); },
  };
  const doc = {
    createElement: (tag: string) => { assert.equal(tag, 'a'); return link; },
    body: { appendChild: (el: unknown) => { assert.equal(el, link); events.push('append'); return el; } },
  } as unknown as Document;
  openInApp(WORKSPACE_APP.path, doc);
  assert.deepEqual(events, ['append', `click ${WORKSPACE_APP.path} _blank noopener`, 'remove']);
});

test('via ResoFly installeren komt de vraag mee in het adres, en gaat hij er daarna weer uit', () => {
  assert.ok(WORKSPACE_INSTALL_URL.startsWith(WORKSPACE_APP.path), 'het adres valt binnen de werkruimte-app');
  assert.equal(new URL(WORKSPACE_INSTALL_URL, 'https://x').searchParams.has(INSTALL_PARAM), true);
  assert.deepEqual(takeInstallRequest('?installeren=1'), { requested: true, search: '' });
  assert.deepEqual(takeInstallRequest('?installeren=1&chat=abc'), { requested: true, search: '?chat=abc' });
  assert.deepEqual(takeInstallRequest('?chat=abc'), { requested: false, search: '?chat=abc' });
  assert.deepEqual(takeInstallRequest(''), { requested: false, search: '' });
});

test('elke losse app mag op Android vragen of de ResoFly-app er staat', () => {
  // Zonder related_applications in het manifest van de losse app, en zonder
  // een regel in assetlinks.json voor dat manifest, antwoordt Chrome altijd
  // met een lege lijst.
  const links = readPublic('.well-known/assetlinks.json') as Array<{ relation: string[]; target: { namespace: string; site: string } }>;
  const sites = links.filter(l => l.relation.includes('delegate_permission/common.query_webapk') && l.target.namespace === 'web').map(l => new URL(l.target.site));
  const origins = [...new Set(sites.map(s => s.origin))];
  assert.ok(origins.includes('https://staging.resofly.com'), 'staging ontbreekt in assetlinks.json');
  for (const app of STANDALONE_APPS) {
    const manifest = readPublic(app.manifest);
    assert.ok(
      (manifest.related_applications ?? []).some((r: { platform: string; url: string }) => r.platform === 'webapp' && r.url === WORKSPACE_APP.manifest),
      `${app.id}: de ResoFly-app staat niet in related_applications`,
    );
    // Geen voorkeur voor de andere app: dan zou Chrome deze niet meer willen installeren.
    assert.notEqual(manifest.prefer_related_applications, true, `${app.id}: prefer_related_applications`);
    for (const origin of origins) {
      assert.ok(sites.some(s => s.href === `${origin}${app.manifest}`), `${origin}${app.manifest} ontbreekt in assetlinks.json`);
    }
  }
});

test('de werkruimte-app kan zichzelf herkennen, en een tweede klik haalt hem naar voren', () => {
  const manifest = readPublic(WORKSPACE_APP.manifest);
  // In de browser op Android vraagt /app/werkruimte/ zo of de app nog bestaat.
  assert.ok(manifest.related_applications.some((r: { platform: string; url: string }) => r.platform === 'webapp' && r.url === WORKSPACE_APP.manifest));
  assert.notEqual(manifest.prefer_related_applications, true);
  // Open je hem nog eens terwijl hij al openstaat, dan komt dat venster naar
  // voren in plaats van een tweede venster.
  assert.equal(manifest.launch_handler?.client_mode?.[0], 'focus-existing');
});
