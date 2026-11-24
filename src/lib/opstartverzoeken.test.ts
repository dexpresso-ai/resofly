/**
 * De opstartverzoeken (het inline script in index.html en lib/opstartverzoeken.ts):
 * een vooruit verstuurd leesverzoek mag de app alleen krijgen als hij precies
 * hetzelfde vraagt, met hetzelfde token, en maar één keer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { clearOpstartLijsten, herhaalbaar, opstartSleutel, OPSTART_LIJST_PREFIX, OPSTART_LIJST_VERSIE, supabaseFetch, type Vooruitgehaald } from './opstartverzoeken.ts';

const BASE = 'https://abc.supabase.co';
const TASKS = `${BASE}/rest/v1/tasks?select=*&organization_id=eq.o1&order=created_at.desc%2Cid.asc&offset=0&limit=1000`;

/** Het inline script uit index.html, gedraaid met een nagebootste browser. */
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const INLINE = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(code => code.includes('__resoflyOpstart'));

function draaiStartscript({ path = '/', storage = {} as Record<string, string>, url = BASE, key = 'anon-key', now = Date.now() } = {}) {
  const fetches: Array<{ url: string; headers: Record<string, string> }> = [];
  const win: { __resoflyOpstart?: Vooruitgehaald } = {};
  const meta: Record<string, string> = { 'resofly-supabase-url': url, 'resofly-supabase-key': key };
  const context = {
    location: { pathname: path },
    document: { querySelector: (sel: string) => { const name = /name="([^"]+)"/.exec(sel)?.[1] ?? ''; return name in meta ? { getAttribute: () => meta[name] } : null; } },
    localStorage: { getItem: (k: string) => storage[k] ?? null },
    fetch: (u: string, init: { headers: Record<string, string> }) => { fetches.push({ url: u, headers: init.headers }); return Promise.resolve(new Response('[]')); },
    Date: { now: () => now }, URL, Map, JSON, Array,
    window: win,
  };
  vm.runInNewContext(INLINE!, context);
  return { fetches, vooruit: win.__resoflyOpstart };
}

function sessie(userId: string, token: string, expiresInS = 3600) {
  return JSON.stringify({ access_token: token, expires_at: Math.floor(Date.now() / 1000) + expiresInS, user: { id: userId } });
}

test('het inline script vuurt de bewaarde leesverzoeken af, met dezelfde sleutel als de app', () => {
  assert.ok(INLINE, 'inline opstartscript in index.html');
  const lijst = { v: OPSTART_LIJST_VERSIE, at: Date.now(), requests: [
    { url: TASKS, accept: null, prefer: 'count=exact' },
    { url: `${BASE}/rest/v1/company_settings?select=*`, accept: 'application/vnd.pgrst.object+json', prefer: null },
    { url: 'https://kwaad.example/rest/v1/x', accept: null, prefer: null },
  ] };
  const { fetches, vooruit } = draaiStartscript({ storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: JSON.stringify(lijst) } });
  // Het adres van een andere host gaat nooit weg.
  assert.deepEqual(fetches.map(f => f.url), [TASKS, `${BASE}/rest/v1/company_settings?select=*`]);
  assert.equal(fetches[0].headers.Authorization, 'Bearer tok');
  assert.equal(fetches[0].headers.apikey, 'anon-key');
  assert.equal(fetches[0].headers.Prefer, 'count=exact');
  assert.equal(fetches[1].headers.Accept, 'application/vnd.pgrst.object+json');
  assert.equal(vooruit?.token, 'tok');
  assert.deepEqual([...(vooruit?.entries.keys() ?? [])], [opstartSleutel(TASKS, null, 'count=exact'), opstartSleutel(`${BASE}/rest/v1/company_settings?select=*`, 'application/vnd.pgrst.object+json', null)]);
});

test('het inline script doet niets zonder sessie, met een bijna verlopen token, een oude lijst of buiten de werkruimte', () => {
  const lijst = (at = Date.now()) => JSON.stringify({ v: OPSTART_LIJST_VERSIE, at, requests: [{ url: TASKS, accept: null, prefer: null }] });
  const geval = (opties: Parameters<typeof draaiStartscript>[0]) => draaiStartscript(opties).fetches.length;
  assert.equal(geval({ storage: { [OPSTART_LIJST_PREFIX + 'u1']: lijst() } }), 0, 'geen sessie');
  assert.equal(geval({ storage: { 'sb-abc-auth-token': sessie('u1', 'tok', 60), [OPSTART_LIJST_PREFIX + 'u1']: lijst() } }), 0, 'token bijna verlopen');
  assert.equal(geval({ storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: lijst(Date.now() - 8 * 24 * 3600 * 1000) } }), 0, 'lijst ouder dan 7 dagen');
  assert.equal(geval({ storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u2']: lijst() } }), 0, 'lijst van een andere gebruiker');
  assert.equal(geval({ path: '/quote/abc', storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: lijst() } }), 0, 'publieke pagina');
  assert.equal(geval({ path: '/portal', storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: lijst() } }), 0, 'portaal');
  assert.equal(geval({ url: '%VITE_SUPABASE_URL%', storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: lijst() } }), 0, 'geen adres ingevuld');
  assert.equal(geval({ path: '/app/agenda/', storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: lijst() } }), 1, 'losse app');
  // Een kapotte lijst houdt niets tegen.
  assert.equal(geval({ storage: { 'sb-abc-auth-token': sessie('u1', 'tok'), [OPSTART_LIJST_PREFIX + 'u1']: '{kapot' } }), 0, 'kapotte lijst');
});

test('alleen leesverzoeken op de eigen database zonder datum worden onthouden', () => {
  assert.equal(herhaalbaar(TASKS, BASE), true);
  assert.equal(herhaalbaar(`${BASE}/auth/v1/user`, BASE), false);
  assert.equal(herhaalbaar('https://ander.supabase.co/rest/v1/tasks?select=*', BASE), false);
  assert.equal(herhaalbaar(`${BASE}/rest/v1/organization_invitations?or=(expires_at.is.null,expires_at.gt.2026-11-24T08%3A00%3A00.000Z)`, BASE), false);
  assert.equal(herhaalbaar(`${BASE}/rest/v1/time_entries?date=gte.2026-11-23`, BASE), false);
  // Groepstabellen hangen af van de beginpagina: niet vooruit.
  assert.equal(herhaalbaar(`${BASE}/rest/v1/bank_transactions?select=*&organization_id=eq.o1`, BASE), false);
  assert.equal(herhaalbaar(`${BASE}/rest/v1/journal_lines?select=*`, BASE), false);
});

function metVooruit(token: string, entries: Map<string, Promise<Response>>, at = Date.now()) {
  (globalThis as unknown as { window: { __resoflyOpstart?: unknown } }).window = globalThis as never;
  (globalThis as unknown as { __resoflyOpstart: unknown }).__resoflyOpstart = { at, token, entries };
}

function stubFetch() {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response('[{"bron":"server"}]');
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('een gelijk verzoek krijgt het vooruitgehaalde antwoord, één keer', async () => {
  const stub = stubFetch();
  try {
    metVooruit('tok', new Map([[opstartSleutel(TASKS, null, 'count=exact'), Promise.resolve(new Response('[{"bron":"vooruit"}]'))]]));
    const headers = { Authorization: 'Bearer tok', Prefer: 'count=exact' };
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers })).json(), [{ bron: 'vooruit' }]);
    assert.equal(stub.calls.length, 0);
    // Tweede keer: naar de server.
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers })).json(), [{ bron: 'server' }]);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test('een ander token, andere Prefer, een herhaling of schrijven gaat naar de server', async () => {
  const stub = stubFetch();
  try {
    const vooruit = () => new Map([[opstartSleutel(TASKS, null, 'count=exact'), Promise.resolve(new Response('[{"bron":"vooruit"}]'))]]);
    metVooruit('tok', vooruit());
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers: { Authorization: 'Bearer ander', Prefer: 'count=exact' } })).json(), [{ bron: 'server' }]);
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers: { Authorization: 'Bearer tok' } })).json(), [{ bron: 'server' }]);
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers: { Authorization: 'Bearer tok', Prefer: 'count=exact', 'X-Retry-Count': '1' } })).json(), [{ bron: 'server' }]);
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'POST', headers: { Authorization: 'Bearer tok', Prefer: 'count=exact' } })).json(), [{ bron: 'server' }]);
    // Te oud: niet meer gebruiken.
    metVooruit('tok', vooruit(), Date.now() - 60_000);
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers: { Authorization: 'Bearer tok', Prefer: 'count=exact' } })).json(), [{ bron: 'server' }]);
    assert.equal(stub.calls.length, 5);
  } finally { stub.restore(); }
});

test('mislukte het vooruit, dan vraagt de app het alsnog zelf', async () => {
  const stub = stubFetch();
  try {
    const mislukt = Promise.reject(new TypeError('Failed to fetch'));
    mislukt.catch(() => undefined);
    metVooruit('tok', new Map([[opstartSleutel(TASKS, null, null), mislukt]]));
    assert.deepEqual(await (await supabaseFetch(TASKS, { method: 'GET', headers: { Authorization: 'Bearer tok' } })).json(), [{ bron: 'server' }]);
    assert.equal(stub.calls.length, 1);
  } finally { stub.restore(); }
});

test('uitloggen wist alle lijsten en wat er vooruit klaarstond', () => {
  const store = new Map<string, string>([[OPSTART_LIJST_PREFIX + 'u1', '{}'], [OPSTART_LIJST_PREFIX + 'u2', '{}'], ['resofly.theme', 'dark']]);
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  } as Storage;
  metVooruit('tok', new Map());
  clearOpstartLijsten();
  assert.deepEqual([...store.keys()], ['resofly.theme']);
  assert.equal((globalThis as unknown as { __resoflyOpstart?: unknown }).__resoflyOpstart, undefined);
});
