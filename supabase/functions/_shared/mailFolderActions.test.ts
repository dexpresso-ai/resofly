import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from './actions/index.ts';
import { MAIL_FOLDER_ACTIONS } from './actions/mailFolders.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';

/**
 * Gerrie en de mailmappen (Berichten → mappen per klant).
 *
 * Met een nep-database die echt filtert: plan() en read() draaien zoals op de
 * server, alleen de rijen zijn verzonnen. Wat hier staat, zijn de regels die de
 * gebruiker niet mag merken door een kaart die bij het akkoord alsnog strandt
 * (een dubbele naam, een zesde laag, een map van een andere klant), én de grens
 * die nergens anders zo direct te zien is: elke query van deze handelingen
 * filtert op de organisatie uit de sessie.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const OTHER_ORG = '0000000b-0000-0000-0000-000000000000';
const ME = '00000000-0000-4000-8000-0000000000a1';
const uid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const BAKKER = uid(1);
const GARAGE = uid(2);
const VREEMD = uid(3);
const F_OFFERTES = uid(11);
const F_PROJECT = uid(12);
const F_FEEDBACK = uid(13);
const F_GARAGE = uid(14);
const T_OFFERTE = uid(21);
const T_LOGO = uid(22);
const T_FACTUUR = uid(23);
const T_APK = uid(24);
const T_VREEMD = uid(25);

type Row = Record<string, unknown>;

function world(extra: { folders?: Row[] } = {}): Record<string, Row[]> {
  const folder = (fid: string, client: string, parent: string | null, name: string, org = ORG) => ({ id: fid, organization_id: org, client_id: client, parent_id: parent, name });
  const thread = (tid: string, client: string, subject: string, folderId: string | null, org = ORG) => ({
    id: tid, organization_id: org, client_id: client, subject, folder_id: folderId,
    last_message_at: '2026-11-10T10:00:00Z', message_count: 2, last_email_direction: 'inbound', last_from_name: 'Joost', last_preview: 'Tekst',
  });
  const threads = [
    thread(T_OFFERTE, BAKKER, 'Offerte huisstijl', F_OFFERTES),
    thread(T_LOGO, BAKKER, 'Logo-varianten', F_FEEDBACK),
    thread(T_FACTUUR, BAKKER, 'Factuur oktober', null),
    thread(T_APK, GARAGE, 'APK', null),
    thread(T_VREEMD, VREEMD, 'Geheim', null, OTHER_ORG),
  ];
  return {
    clients: [
      { id: BAKKER, organization_id: ORG, name: 'Bakkerij De Korenaar' },
      { id: GARAGE, organization_id: ORG, name: 'Garage Jansen' },
      { id: VREEMD, organization_id: OTHER_ORG, name: 'Klant van een ander' },
    ],
    client_email_folders: [
      folder(F_OFFERTES, BAKKER, null, 'Offertes'),
      folder(F_PROJECT, BAKKER, null, 'Project huisstijl'),
      folder(F_FEEDBACK, BAKKER, F_PROJECT, 'Feedback'),
      folder(F_GARAGE, GARAGE, null, 'Onderhoud'),
      folder(uid(15), VREEMD, null, 'Andermans map', OTHER_ORG),
      ...(extra.folders ?? []),
    ],
    client_email_threads: threads,
    client_email_thread_overview: threads,
  };
}

/** Elke query, met de filters die erop zaten. */
interface Seen { table: string; filters: Array<[string, string, unknown]> }

function fakeDb(rows: Record<string, Row[]>, seen: Seen[]) {
  return {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      seen.push({ table, filters });
      let limit = Infinity;
      const run = () => {
        let out = rows[table] ?? [];
        for (const [op, column, value] of filters) {
          out = out.filter((r) => {
            const v = r[column];
            if (op === 'eq') return v === value;
            if (op === 'in') return (value as unknown[]).includes(v);
            if (op === 'is') return (v ?? null) === value;
            if (op === 'ilike') return new RegExp(String(value).replace(/\\/g, '').replace(/%/g, '.*'), 'i').test(String(v ?? ''));
            return true;
          });
        }
        return out.slice(0, limit);
      };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.limit = (n: number) => { limit = n; return chain; };
      for (const op of ['eq', 'in', 'is', 'ilike']) chain[op] = (column: string, value: unknown) => { filters.push([op, column, value]); return chain; };
      chain.maybeSingle = async () => ({ data: run()[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: run(), error: null });
      return chain;
    },
    rpc() { throw new Error('de mailmappen roepen bij het klaarzetten geen rpc aan'); },
  };
}

function setup(extra: { folders?: Row[] } = {}) {
  const seen: Seen[] = [];
  const ctx: ActionCtx = { organizationId: ORG, userId: ME, role: 'member', today: '2026-11-12', db: fakeDb(world(extra), seen) };
  return { ctx, seen };
}

function action(id: string): ActionDef {
  const found = MAIL_FOLDER_ACTIONS.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

const plan = (id: string, input: Record<string, unknown>, extra?: { folders?: Row[] }) => {
  const { ctx } = setup(extra);
  return action(id).plan!(ctx, input);
};
const read = (id: string, input: Record<string, unknown>) => {
  const { ctx } = setup();
  return action(id).read!(ctx, input) as Promise<Record<string, unknown>>;
};

async function refuses(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ActionError, `geen ActionError: ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

// ── De lijst ──────────────────────────────────────────────────────────────

test('alle mailmaphandelingen staan in de registry, onder Klanten', () => {
  const ids = MAIL_FOLDER_ACTIONS.map((a) => a.id).sort();
  assert.deepEqual(ids, ['mail_folder.create', 'mail_folder.delete', 'mail_folder.list', 'mail_folder.move', 'mail_folder.rename', 'mail_thread.list', 'mail_thread.move']);
  for (const def of MAIL_FOLDER_ACTIONS) {
    assert.ok(ACTIONS.some((a) => a.id === def.id), `${def.id} zit niet in ACTIONS`);
    assert.equal(def.module, 'clients', def.id);
  }
});

test('een voorstel heet "werk", niet "mail": er gaat niets de deur uit', async () => {
  // Op de beslislijst wordt de knop bij kind 'mail' "Akkoord, versturen".
  const kaart = await plan('mail_folder.create', { client_id: BAKKER, name: 'Facturen' });
  assert.equal(kaart.kind, 'work');
  const verplaatsen = await plan('mail_thread.move', { thread_ids: [T_FACTUUR], folder_id: F_OFFERTES });
  assert.equal(verplaatsen.kind, 'work');
});

// ── Lezen ────────────────────────────────────────────────────────────────

test('mail_folder.list: paden, lagen en hoeveel gesprekken erin staan', async () => {
  const result = await read('mail_folder.list', { client_id: BAKKER });
  const folders = result.folders as Array<Record<string, unknown>>;
  assert.deepEqual(folders.map((f) => `${f.path}|${f.depth}|${f.threads}`), [
    'Offertes|1|1', 'Project huisstijl|1|0', 'Project huisstijl / Feedback|2|1',
  ]);
  assert.equal(result.unfiled_threads, 1);
  assert.equal(result.client_name, 'Bakkerij De Korenaar');
});

test('mail_folder.list: een klant van een andere organisatie bestaat niet', async () => {
  await refuses(read('mail_folder.list', { client_id: VREEMD }), /Klant niet gevonden/);
});

test('mail_thread.list: met de map erbij, en te filteren', async () => {
  const all = await read('mail_thread.list', { client_id: BAKKER });
  const threads = all.threads as Array<Record<string, unknown>>;
  assert.deepEqual(threads.map((t) => `${t.subject}|${t.folder ?? '-'}`).sort(), [
    'Factuur oktober|-', 'Logo-varianten|Project huisstijl / Feedback', 'Offerte huisstijl|Offertes',
  ]);
  const unfiled = await read('mail_thread.list', { client_id: BAKKER, unfiled_only: true });
  assert.deepEqual((unfiled.threads as Array<Record<string, unknown>>).map((t) => t.thread_id), [T_FACTUUR]);
  const inFolder = await read('mail_thread.list', { client_id: BAKKER, folder_id: F_FEEDBACK });
  assert.deepEqual((inFolder.threads as Array<Record<string, unknown>>).map((t) => t.thread_id), [T_LOGO]);
  const search = await read('mail_thread.list', { client_id: BAKKER, query: 'factuur' });
  assert.deepEqual((search.threads as Array<Record<string, unknown>>).map((t) => t.thread_id), [T_FACTUUR]);
  await refuses(read('mail_thread.list', { client_id: BAKKER, folder_id: F_FEEDBACK, unfiled_only: true }), /óf een map/);
});

// ── Een map maken ─────────────────────────────────────────────────────────

test('mail_folder.create: de kaart zegt bij welke klant en waar', async () => {
  const kaart = await plan('mail_folder.create', { client_id: BAKKER, name: '  Facturen   2026 ', parent_id: F_PROJECT });
  assert.equal(kaart.title, 'Mailmap maken: Facturen 2026');
  assert.match(kaart.sub, /Bakkerij De Korenaar · in "Project huisstijl"/);
  assert.deepEqual(kaart.payload, { client_id: BAKKER, client_name: 'Bakkerij De Korenaar', name: 'Facturen 2026', parent_id: F_PROJECT });
});

test('mail_folder.create: een naam die er al staat (ook met andere hoofdletters) wordt hergebruikt, geen tweede', async () => {
  await refuses(plan('mail_folder.create', { client_id: BAKKER, name: 'offertes' }), new RegExp(`al een map "Offertes" bovenaan \\(folder_id ${F_OFFERTES}\\)`));
  // Op een andere plek mag dezelfde naam wel.
  const kaart = await plan('mail_folder.create', { client_id: BAKKER, name: 'Offertes', parent_id: F_PROJECT });
  assert.equal(kaart.payload.parent_id, F_PROJECT);
});

test('mail_folder.create: niet in een map van een andere klant, en niet dieper dan vijf lagen', async () => {
  await refuses(plan('mail_folder.create', { client_id: BAKKER, name: 'X', parent_id: F_GARAGE }), /hoort niet bij deze klant/);
  const deep = [
    { id: uid(31), organization_id: ORG, client_id: BAKKER, parent_id: F_FEEDBACK, name: 'L3' },
    { id: uid(32), organization_id: ORG, client_id: BAKKER, parent_id: uid(31), name: 'L4' },
    { id: uid(33), organization_id: ORG, client_id: BAKKER, parent_id: uid(32), name: 'L5' },
  ];
  await refuses(plan('mail_folder.create', { client_id: BAKKER, name: 'L6', parent_id: uid(33) }, { folders: deep }), /hooguit 5 lagen/);
  const ok = await plan('mail_folder.create', { client_id: BAKKER, name: 'L5b', parent_id: uid(32) }, { folders: deep });
  assert.equal(ok.payload.name, 'L5b');
  await refuses(plan('mail_folder.create', { client_id: BAKKER, name: 'x'.repeat(81) }), /hooguit 80 tekens/);
});

// ── Hernoemen, verplaatsen, verwijderen ───────────────────────────────────

test('mail_folder.rename: niet naar de eigen naam, niet naar die van een buurman', async () => {
  await refuses(plan('mail_folder.rename', { folder_id: F_OFFERTES, name: 'Offertes' }), /heet al zo/);
  await refuses(plan('mail_folder.rename', { folder_id: F_OFFERTES, name: 'project HUISSTIJL' }), /al een map "Project huisstijl"/);
  const kaart = await plan('mail_folder.rename', { folder_id: F_FEEDBACK, name: 'Feedback klant' });
  assert.equal(kaart.title, 'Mailmap hernoemen: Project huisstijl / Feedback');
  assert.equal(kaart.payload.was, 'Feedback');
  await refuses(plan('mail_folder.rename', { folder_id: uid(15), name: 'X' }), /niet gevonden/);
});

test('mail_folder.move: niet in zichzelf, niet in een eigen submap, niet naar een andere klant', async () => {
  await refuses(plan('mail_folder.move', { folder_id: F_PROJECT, parent_id: F_PROJECT }), /niet in zichzelf/);
  await refuses(plan('mail_folder.move', { folder_id: F_PROJECT, parent_id: F_FEEDBACK }), /eigen submappen/);
  await refuses(plan('mail_folder.move', { folder_id: F_OFFERTES, parent_id: F_GARAGE }), /dezelfde klant/);
  await refuses(plan('mail_folder.move', { folder_id: F_FEEDBACK, parent_id: F_PROJECT }), /staat al in "Project huisstijl"/);
  const naarBoven = await plan('mail_folder.move', { folder_id: F_FEEDBACK });
  assert.match(naarBoven.sub, /naar bovenaan/);
  const erin = await plan('mail_folder.move', { folder_id: F_OFFERTES, parent_id: F_FEEDBACK });
  assert.equal(erin.payload.target, 'Project huisstijl / Feedback');
});

test('mail_folder.move: een map mét submappen telt mee voor de diepte', async () => {
  const deep = [
    { id: uid(31), organization_id: ORG, client_id: BAKKER, parent_id: F_FEEDBACK, name: 'L3' },
    { id: uid(32), organization_id: ORG, client_id: BAKKER, parent_id: uid(31), name: 'L4' },
  ];
  // Project (3 lagen eronder: Feedback, L3, L4 → hoogte 4) onder Offertes (laag 1) = 5: mag.
  const ok = await plan('mail_folder.move', { folder_id: F_PROJECT, parent_id: F_OFFERTES }, { folders: deep });
  assert.equal(ok.payload.parent_id, F_OFFERTES);
  // Offertes onder L4 (laag 4) = 5: mag; onder een vijfde laag niet.
  const vijf = [...deep, { id: uid(33), organization_id: ORG, client_id: BAKKER, parent_id: uid(32), name: 'L5' }];
  await refuses(plan('mail_folder.move', { folder_id: F_OFFERTES, parent_id: uid(33) }, { folders: vijf }), /dieper dan 5 lagen/);
});

test('mail_folder.delete: altijd langs een mens, en de kaart zegt dat er geen mail verloren gaat', async () => {
  const def = action('mail_folder.delete');
  assert.equal(def.risk, 'high');
  const kaart = await plan('mail_folder.delete', { folder_id: F_PROJECT });
  assert.equal(kaart.humanOnly, true);
  assert.match(kaart.warning ?? '', /1 submap gaat naar "Zonder map"; er gaat geen mail verloren/);
  const sub = await plan('mail_folder.delete', { folder_id: F_FEEDBACK });
  assert.match(sub.warning ?? '', /1 gesprek gaat naar "Project huisstijl"/);
});

// ── Gesprekken verplaatsen ────────────────────────────────────────────────

test('mail_thread.move: naar een bestaande map, met de onderwerpen op de kaart', async () => {
  const kaart = await plan('mail_thread.move', { thread_ids: [T_FACTUUR, T_LOGO], folder_id: F_OFFERTES });
  assert.equal(kaart.title, '2 mailgesprekken verplaatsen');
  assert.match(kaart.sub, /Bakkerij De Korenaar · naar "Offertes" · Factuur oktober · Logo-varianten/);
  assert.deepEqual(kaart.payload.thread_ids, [T_FACTUUR, T_LOGO], 'in de volgorde van de vraag');
  assert.equal(kaart.payload.folder_id, F_OFFERTES);
  assert.equal(kaart.payload.new_folder_name, null);
});

test('mail_thread.move: wat er al staat, gaat niet nog eens mee', async () => {
  const kaart = await plan('mail_thread.move', { thread_ids: [T_OFFERTE, T_FACTUUR], folder_id: F_OFFERTES });
  assert.deepEqual(kaart.payload.thread_ids, [T_FACTUUR]);
  assert.equal(kaart.title, 'Gesprek verplaatsen: Factuur oktober');
  await refuses(plan('mail_thread.move', { thread_ids: [T_OFFERTE], folder_id: F_OFFERTES }), /staat al in "Offertes"/);
});

test('mail_thread.move: een nieuwe map in één kaart, of de bestaande als die er al is', async () => {
  const nieuw = await plan('mail_thread.move', { thread_ids: [T_FACTUUR], new_folder_name: 'Facturen', new_folder_parent_id: F_PROJECT });
  assert.equal(nieuw.payload.folder_id, null);
  assert.equal(nieuw.payload.new_folder_name, 'Facturen');
  assert.equal(nieuw.payload.new_folder_parent_id, F_PROJECT);
  assert.match(nieuw.sub, /naar nieuwe map "Project huisstijl \/ Facturen"/);
  const bestaand = await plan('mail_thread.move', { thread_ids: [T_FACTUUR], new_folder_name: 'OFFERTES' });
  assert.equal(bestaand.payload.folder_id, F_OFFERTES);
  assert.equal(bestaand.payload.new_folder_name, null);
});

test('mail_thread.move: zonder doel terug naar "Zonder map"', async () => {
  const kaart = await plan('mail_thread.move', { thread_ids: [T_OFFERTE] });
  assert.equal(kaart.payload.folder_id, null);
  assert.match(kaart.sub, /naar "Zonder map"/);
});

test('mail_thread.move: één klant per voorstel, en alleen gesprekken uit deze organisatie', async () => {
  await refuses(plan('mail_thread.move', { thread_ids: [T_FACTUUR, T_APK], folder_id: F_OFFERTES }), /verschillende klanten/);
  await refuses(plan('mail_thread.move', { thread_ids: [T_APK], folder_id: F_OFFERTES }), /hoort niet bij de klant van deze gesprekken/);
  await refuses(plan('mail_thread.move', { thread_ids: [T_VREEMD], folder_id: F_OFFERTES }), /bestaat niet in deze organisatie/);
  await refuses(plan('mail_thread.move', { thread_ids: [T_FACTUUR], folder_id: F_OFFERTES, new_folder_name: 'X' }), /niet allebei/);
  await refuses(plan('mail_thread.move', { thread_ids: [T_FACTUUR], new_folder_parent_id: F_PROJECT }), /hoort bij new_folder_name/);
});

// ── De grens ─────────────────────────────────────────────────────────────

test('elke query van deze handelingen filtert op de organisatie uit de sessie', async () => {
  const { ctx, seen } = setup();
  const runs: Array<Promise<unknown>> = [
    action('mail_folder.list').read!(ctx, { client_id: BAKKER }),
    action('mail_thread.list').read!(ctx, { client_id: BAKKER, query: 'x' }),
    action('mail_folder.create').plan!(ctx, { client_id: BAKKER, name: 'Nieuw', parent_id: F_PROJECT }),
    action('mail_folder.rename').plan!(ctx, { folder_id: F_FEEDBACK, name: 'Anders' }),
    action('mail_folder.move').plan!(ctx, { folder_id: F_FEEDBACK }),
    action('mail_folder.delete').plan!(ctx, { folder_id: F_PROJECT }),
    action('mail_thread.move').plan!(ctx, { thread_ids: [T_FACTUUR], new_folder_name: 'Facturen' }),
  ];
  await Promise.all(runs);
  assert.ok(seen.length >= 15, `verwacht een flink aantal queries, gezien: ${seen.length}`);
  const unscoped = seen.filter((q) => !q.filters.some(([op, column, value]) => op === 'eq' && column === 'organization_id' && value === ORG));
  assert.deepEqual(unscoped.map((q) => q.table), [], 'deze queries filteren niet op de organisatie');
});
