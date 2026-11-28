// De PDF van een pagina (stap 1B-5): /internal/office/convert-page.
//
// page-export bouwt de DOCX met de rechten van wie exporteert en stuurt hem
// mee; de worker zet hem om via Collabora en geeft de PDF terug. Deze test
// draait de echte worker (index.ts) met een nagebootste Collabora, en kijkt:
//  - alleen met het interne geheim, een geldige organisatie en een echte .docx;
//  - Collabora krijgt het bestand met het conversiegeheim, en wat geen PDF is,
//    gaat niet de deur uit;
//  - er komt niets in R2 (zie de uitleg bij handleInternalPageConvertPdf);
//  - het contractpad zet nog steeds alleen contracten om.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const INTERNAL = 'intern-geheim';
const CONVERT = 'conversie-geheim';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Genoeg van een .docx voor de worker: een zip-kop en wat bytes. */
const docx = (tekst: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode(tekst)]);

type Antwoord = 'pdf' | 'geen-pdf' | 'fout';

function setup(antwoord: Antwoord = 'pdf') {
  const collabora: Array<{ url: string; geheim: string | null; naam: string | null; bytes: Uint8Array }> = [];
  const r2Writes: string[] = [];
  const env = {
    MEDIA_BUCKET: {
      async put(key: string) { r2Writes.push(key); return { size: 0 }; },
      async get(key: string) { return key.includes('/document/') ? { httpMetadata: { contentType: DOCX }, arrayBuffer: async () => docx('ander').buffer } : null; },
      async head() { return null; },
    },
    APP_ENV: 'staging',
    ALLOWED_ORIGINS: 'https://app.test',
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role',
    INTERNAL_UPLOAD_SECRET: INTERNAL,
    MEDIA_SIGNING_SECRET: 'teken-geheim',
    COLLABORA_URL: 'https://office.test/',
    OFFICE_CONVERT_SECRET: CONVERT,
    OFFICE_SERVER: {
      async fetch(url: string, init: RequestInit) {
        const form = init.body as FormData;
        const data = form.get('data') as File;
        collabora.push({
          url,
          geheim: new Headers(init.headers).get('x-resofly-convert'),
          naam: data?.name ?? null,
          bytes: new Uint8Array(await data.arrayBuffer()),
        });
        if (antwoord === 'fout') return new Response('kapot', { status: 500 });
        if (antwoord === 'geen-pdf') return new Response('<html>fout</html>', { status: 200 });
        return new Response(new TextEncoder().encode('%PDF-1.7 nep-pdf'), { status: 200, headers: { 'content-type': 'application/pdf' } });
      },
    },
  };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  async function convert(body: Uint8Array | string, headers: Record<string, string> = {}) {
    const res = await worker.fetch(new Request('https://media.test/internal/office/convert-page', {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL}`, 'x-organization-id': ORG, 'content-type': DOCX, ...headers },
      body,
    }), env as any, ctx as any);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, type: res.headers.get('content-type'), bytes, text: new TextDecoder().decode(bytes) };
  }
  async function convertContract(storageKey: string) {
    const res = await worker.fetch(new Request('https://media.test/internal/office/convert-pdf', {
      method: 'POST',
      headers: { authorization: `Bearer ${INTERNAL}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: ORG, storageKey }),
    }), env as any, ctx as any);
    return { status: res.status, text: await res.text() };
  }
  return { convert, convertContract, collabora, r2Writes };
}

test('een pagina: de DOCX gaat met het conversiegeheim naar Collabora, de PDF komt terug, en er komt niets in R2', async () => {
  const w = setup();
  const res = await w.convert(docx('Handboek'));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.type, 'application/pdf');
  assert.equal(res.text, '%PDF-1.7 nep-pdf');
  assert.equal(w.collabora.length, 1);
  assert.equal(w.collabora[0].url, 'https://office.test/cool/convert-to/pdf');
  assert.equal(w.collabora[0].geheim, CONVERT);
  assert.equal(w.collabora[0].naam, 'bron.docx');
  assert.deepEqual(w.collabora[0].bytes, docx('Handboek'));
  assert.deepEqual(w.r2Writes, []);
});

test('zonder het interne geheim, of zonder geldige organisatie: niets naar Collabora', async () => {
  const w = setup();
  for (const [headers, status] of [
    [{ authorization: 'Bearer fout' }, 403],
    [{ authorization: '' }, 401],
    [{ 'x-organization-id': 'geen-uuid' }, 400],
    [{ 'x-organization-id': '' }, 400],
  ] as Array<[Record<string, string>, number]>) {
    assert.equal((await w.convert(docx('x'), headers)).status, status, JSON.stringify(headers));
  }
  assert.equal(w.collabora.length, 0);
});

test('alleen een echte .docx: geen ander type, geen leeg bestand, geen bestand zonder zip-kop', async () => {
  const w = setup();
  assert.equal((await w.convert(docx('x'), { 'content-type': 'application/pdf' })).status, 415);
  assert.equal((await w.convert(new Uint8Array(0))).status, 400);
  assert.equal((await w.convert('gewone tekst')).status, 415);
  assert.equal(w.collabora.length, 0);
});

test('wat Collabora teruggeeft en geen PDF is, of een fout van Collabora: 502, en geen bestand', async () => {
  for (const antwoord of ['geen-pdf', 'fout'] as const) {
    const res = await setup(antwoord).convert(docx('x'));
    assert.equal(res.status, 502, antwoord);
    assert.doesNotMatch(res.text, /%PDF/, antwoord);
  }
});

test('het contractpad zet nog steeds alleen een contract om', async () => {
  const w = setup();
  const res = await w.convertContract(`${ORG}/document/x/handboek.docx`);
  assert.equal(res.status, 403);
  assert.match(res.text, /Alleen een contractbestand/);
  assert.equal(w.collabora.length, 0);
});
