/**
 * Tests voor het lezen van een gedeeld document in het portaal en bij een
 * geheime link (stap 1C-2). Draaien met:  npm test
 *
 * Het belangrijkste: bij een pagina ziet de klant de gedeelde versie, nooit de
 * pagina zoals ze nu is, en bij twijfel niets. De databasetest
 * (tests/database/paginas_delen.sql) bewaakt dezelfde regel in
 * drive_share_items en in de trigger op drive_shares.
 *
 * De database is hier nagebootst: een tabel per naam, en eq/in filteren echt.
 * Zo telt ook dat elke vraag op de organisatie filtert.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedDocumentText } from './sharedPage.ts';

type Row = Record<string, unknown>;

/**
 * Genoeg van supabase-js voor sharedPage.ts: from().select().eq().in(), en
 * maybeSingle() of await; en rpc(). Een rpc geeft de rijen uit
 * tables['rpc:<naam>'] die bij de argumenten horen (hier: de deling).
 */
function fakeAdmin(tables: Record<string, Row[]>, failOn?: string) {
  const calls: string[] = [];
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(`rpc:${name}`);
      if (failOn === `rpc:${name}`) return { data: null, error: { message: `kapot: rpc:${name}` } };
      return { data: (tables[`rpc:${name}`] ?? []).filter(row => row.p_share_id === args.p_share_id), error: null };
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      const result = () => {
        calls.push(table);
        if (failOn === table) return { data: null, error: { message: `kapot: ${table}` } };
        return { data: (tables[table] ?? []).filter(row => filters.every(keep => keep(row))), error: null };
      };
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push(row => row[column] === value); return query; },
        in: (column: string, values: unknown[]) => { filters.push(row => values.includes(row[column])); return query; },
        maybeSingle: async () => {
          const { data, error } = result();
          return { data: data ? data[0] ?? null : null, error };
        },
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
      };
      return query;
    },
  };
}

const ORG = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const PAGE = '11111111-1111-4111-8111-111111111111';
const SUB = '22222222-2222-4222-8222-222222222222';
const OTHER_PAGE = '33333333-3333-4333-8333-333333333333';
const TEXT_DOC = '44444444-4444-4444-8444-444444444444';
const FILE = '55555555-5555-4555-8555-555555555555';
const FILE_B = '66666666-6666-4666-8666-666666666666';
const IMAGE = '99999999-9999-4999-8999-999999999999';
const SVG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SHARE = '77777777-7777-4777-8777-777777777777';
const VERSION = '88888888-8888-4888-8888-888888888888';

const text = (value: string) => ({ type: 'text', text: value });
const body = (...content: unknown[]) => ({ type: 'doc', content });
const paragraph = (value: string) => ({ type: 'paragraph', content: [text(value)] });

function world(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    documents: [
      { id: PAGE, organization_id: ORG, format: 'page', title: 'Werktitel van nu', content: 'levende tekst', archived_at: null },
      { id: TEXT_DOC, organization_id: ORG, format: 'html', title: 'Huisregels', content: '<p>Koffie is gratis.</p>', archived_at: null },
      { id: OTHER_PAGE, organization_id: ORG, format: 'page', title: 'Ander', content: 'x', archived_at: null },
    ],
    drive_shares: [{ id: SHARE, organization_id: ORG, item_type: 'document', item_id: PAGE, document_version_id: VERSION }],
    document_versions: [{
      id: VERSION, organization_id: ORG, document_id: PAGE, title: 'Werkwijze',
      body: body(
        paragraph('gedeelde tekst'),
        { type: 'subpage', attrs: { pageId: SUB } },
        { type: 'subpage', attrs: { pageId: PAGE } },
        { type: 'subpage', attrs: { pageId: 'geen-uuid' } },
        { type: 'fileBlock', attrs: { attachmentId: FILE } },
        { type: 'fileBlock', attrs: { attachmentId: FILE_B } },
        { type: 'image', attrs: { attachmentId: IMAGE, alt: 'Plattegrond' } },
        { type: 'image', attrs: { attachmentId: SVG, alt: 'Logo' } },
      ),
    }],
    // Wat de database nu nog bij het dossier rekent (shared_page_attachments).
    // FILE_B staat er niet in: dat bestand verhuisde naar een andere klant.
    'rpc:shared_page_attachments': [
      { p_share_id: SHARE, attachment_id: FILE, kind: 'fileBlock', name: 'Offerte.pdf', storage_key: `${ORG}/folder/x/offerte.pdf`, mime_type: 'application/pdf' },
      { p_share_id: SHARE, attachment_id: IMAGE, kind: 'image', name: 'plattegrond.png', storage_key: `${ORG}/document/${PAGE}/plattegrond.png`, mime_type: 'image/png' },
      { p_share_id: SHARE, attachment_id: SVG, kind: 'image', name: 'logo.svg', storage_key: `${ORG}/document/${PAGE}/logo.svg`, mime_type: 'image/svg+xml' },
    ],
    ...overrides,
  };
}

const share = { id: SHARE, organization_id: ORG };
const read = (tables: Record<string, Row[]>, documentId = PAGE, options = {}, withShare = share) =>
  sharedDocumentText(fakeAdmin(tables) as never, withShare, documentId, options);

test('een tekstdocument: de opgeslagen HTML, zoals voorheen', async () => {
  assert.deepEqual(await read(world(), TEXT_DOC), { title: 'Huisregels', html: '<p>Koffie is gratis.</p>' });
});

test('een pagina: de gedeelde versie, nooit de titel of tekst van nu', async () => {
  const result = await read(world());
  assert.equal(result?.title, 'Werkwijze');
  assert.match(result?.html ?? '', /<p>gedeelde tekst<\/p>/);
  assert.doesNotMatch(result?.html ?? '', /levende tekst|Werktitel/);
});

test('bestanden en afbeeldingen: alleen wat de database nu nog bij het dossier rekent', async () => {
  const html = (await read(world()))?.html ?? '';
  assert.match(html, /Bijlage: Offerte\.pdf/);
  assert.doesNotMatch(html, /Van een ander|FILE_B/);
  // Zonder iemand die tekent: de afbeeldingen als "[Afbeelding: …]".
  assert.match(html, /\[Afbeelding: Plattegrond\]/);
  assert.doesNotMatch(html, /<img/);
});

test('afbeeldingen: getekend door de aanroeper, alleen veilige beeldtypes, en een fout houdt de pagina niet tegen', async () => {
  let asked: Array<{ id: string; key: string; name: string }> = [];
  const images = async (files: Array<{ id: string; key: string; name: string }>) => {
    asked = files;
    return Object.fromEntries(files.map(file => [file.id, `https://media.example/signed/${file.name}?t=1&inline=1`]));
  };
  const html = (await read(world(), PAGE, { images }))?.html ?? '';
  // Geen svg: dat kan script bevatten, en de worker toont het niet inline.
  assert.deepEqual(asked.map(file => file.id), [IMAGE]);
  assert.match(html, /<img src="https:\/\/media\.example\/signed\/plattegrond\.png\?t=1&amp;inline=1" alt="Plattegrond" loading="lazy">/);
  assert.match(html, /\[Afbeelding: Logo\]/);
  // Tekenen mislukt: de pagina komt er toch, met "[Afbeelding]".
  const failing = await read(world(), PAGE, { images: async () => { throw new Error('opslag weg'); } });
  assert.match(failing?.html ?? '', /gedeelde tekst.*\[Afbeelding: Plattegrond\]/s);
  // Een adres van buiten de https-regel komt er nooit in (renderPageHtml).
  const http = await read(world(), PAGE, { images: async () => ({ [IMAGE]: 'http://media.example/x' }) });
  assert.doesNotMatch(http?.html ?? '', /<img/);
});

test('subpagina\'s: alleen wat de aanroeper zichtbaar noemt; zonder hem geen enkele', async () => {
  assert.doesNotMatch((await read(world()))?.html ?? '', /rf-subpage/);
  let asked: string[] = [];
  const result = await read(world(), PAGE, {
    subpages: async (ids: string[]) => { asked = ids; return { [SUB]: { title: 'Gedeelde subpagina' } }; },
  });
  // Geen ongeldig id en niet de pagina zelf: die vragen nooit iets op.
  assert.deepEqual(asked, [SUB]);
  assert.match(result?.html ?? '', /<p class="rf-subpage">→ Gedeelde subpagina<\/p>/);
});

test('bij twijfel niets: geen versie, een andere pagina, een andere organisatie, de prullenbak', async () => {
  const base = world();
  const cases: Array<[string, Record<string, Row[]>, string?, typeof share?]> = [
    ['deling zonder versie', { ...base, drive_shares: [{ ...base.drive_shares[0], document_version_id: null }] }],
    ['versie van een andere pagina', { ...base, document_versions: [{ ...base.document_versions[0], document_id: OTHER_PAGE }] }],
    ['versie van een andere organisatie', { ...base, document_versions: [{ ...base.document_versions[0], organization_id: ORG_B }] }],
    ['deling van een andere organisatie', { ...base, drive_shares: [{ ...base.drive_shares[0], organization_id: ORG_B }] }],
    ['deling van een andere pagina', base, OTHER_PAGE],
    ['pagina van een andere organisatie', base, PAGE, { id: SHARE, organization_id: ORG_B }],
    ['pagina in de prullenbak', { ...base, documents: base.documents.map(doc => (doc.id === PAGE ? { ...doc, archived_at: '2026-11-28T10:00:00Z' } : doc)) }],
    ['versie bestaat niet meer', { ...base, document_versions: [] }],
    ['geen geldig id', base, 'geen-uuid'],
  ];
  for (const [label, tables, documentId, withShare] of cases) {
    assert.equal(await read(tables, documentId ?? PAGE, {}, withShare ?? share), null, label);
  }
});

test('een fout van de database gaat door, en wordt niet stil "niets"', async () => {
  for (const table of ['documents', 'drive_shares', 'document_versions', 'rpc:shared_page_attachments']) {
    await assert.rejects(sharedDocumentText(fakeAdmin(world(), table) as never, share, PAGE), { message: `kapot: ${table}` }, table);
  }
});

test('een ongeldig id vraagt niets op', async () => {
  const admin = fakeAdmin(world());
  assert.equal(await sharedDocumentText(admin as never, share, 'x\' or 1=1'), null);
  assert.deepEqual(admin.calls, []);
});
