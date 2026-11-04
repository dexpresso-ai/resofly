import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETING_ACTIONS } from './actions/marketing.ts';
import { ActionError, type ActionCtx, type ActionDef } from './actions/types.ts';
import { GALLERY_LAYOUT_DEFAULTS, applyGalleryLayoutPreset, normalizeGalleryLayout } from './galleryLayout.ts';

/**
 * Gerrie (en een gekoppelde AI) en de weergave van een galerij: de layout_-velden
 * van `gallery.update_settings` en `gallery.set_featured`. Met een nep-database:
 * plan() draait echt, alleen de rijen zijn verzonnen.
 */

const ORG = '0000000a-0000-0000-0000-000000000000';
const GALLERY = 'c0000000-0000-4000-8000-000000000001';
const PHOTO = 'c0000000-0000-4000-8000-000000000002';
const VIDEO = 'c0000000-0000-4000-8000-000000000003';

function fakeDb(rows: Record<string, Array<Record<string, unknown>>>) {
  return {
    from(table: string) {
      const list = rows[table] ?? [];
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const name of ['select', 'eq', 'in', 'is', 'order', 'limit', 'gte', 'lte', 'neq', 'not', 'or', 'ilike']) chain[name] = self;
      chain.maybeSingle = async () => ({ data: list[0] ?? null, error: null });
      chain.single = async () => ({ data: list[0] ?? null, error: null });
      chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: list, error: null });
      return chain;
    },
    rpc() { throw new Error('geen rpc in deze test'); },
  };
}

function ctx(rows: Record<string, Array<Record<string, unknown>>>): ActionCtx {
  return {
    organizationId: ORG, userId: '00000000-0000-0000-0000-0000000000a1', role: 'owner', today: '2026-11-04',
    db: fakeDb(rows),
    canRead: () => true,
    canWrite: () => true,
  };
}

function action(id: string): ActionDef {
  const found = MARKETING_ACTIONS.find((a) => a.id === id);
  assert.ok(found, `${id} bestaat niet`);
  return found;
}

const galleryRow = (layout: unknown, status = 'draft') => ({
  title: 'Bruiloft Sanne & Tim', status, allow_downloads: true, expires_at: null, layout,
});

test('weergave: een stijl met losse velden eroverheen, bovenop de huidige', async () => {
  const update = action('gallery.update_settings');
  const current = { video_layout: 'grid', video_size: 'large' };
  const plan = await update.plan!(ctx({ galleries: [galleryRow(current)] }), {
    gallery_id: GALLERY, layout_preset: 'lighttable', layout_columns: 3, layout_gap: 40,
  });
  const expected = { ...applyGalleryLayoutPreset(normalizeGalleryLayout(current), 'lighttable'), columns: 3, gap: 40 };
  assert.deepEqual((plan.payload.patch as Record<string, unknown>).layout, expected);
  assert.equal(expected.video_layout, 'grid', 'de video-instellingen blijven staan');
  assert.match(plan.sub, /weergave: afdrukken · 3 kolommen · 40 px tussenruimte · speels/);
  assert.equal(plan.risk, 'normal', 'een concept');
});

test('weergave: 0 kolommen is automatisch, en alleen wat gevraagd wordt verandert', async () => {
  const update = action('gallery.update_settings');
  const current = { ...GALLERY_LAYOUT_DEFAULTS, style: 'grid', columns: 5, playfulness: 1 };
  const plan = await update.plan!(ctx({ galleries: [galleryRow(current, 'published')] }), {
    gallery_id: GALLERY, layout_columns: 0, layout_playfulness: 3,
  });
  const layout = (plan.payload.patch as Record<string, unknown>).layout as Record<string, unknown>;
  assert.equal(layout.columns, null);
  assert.equal(layout.playfulness, 3);
  assert.equal(layout.style, 'grid', 'de indeling blijft');
  assert.equal(plan.risk, 'high', 'gepubliceerd: de klant ziet het meteen');
});

test('weergave: onzin wordt bij naam geweigerd', async () => {
  const update = action('gallery.update_settings');
  const rows = { galleries: [galleryRow({})] };
  for (const [input, pattern] of [
    [{ layout_gap: 100 }, /"layout_gap" moet een heel getal van 0 tot en met 64/],
    [{ layout_gap: 6.5 }, /"layout_gap" moet een heel getal/],
    [{ layout_columns: 9 }, /"layout_columns" moet een heel getal van 0 tot en met 8/],
    [{ layout_playfulness: -1 }, /"layout_playfulness"/],
    [{ layout_style: 'carrousel' }, /"layout_style" moet een van deze zijn/],
    [{ layout_preset: 'barok' }, /"layout_preset" moet een van deze zijn/],
  ] as const) {
    await assert.rejects(update.plan!(ctx(rows), { gallery_id: GALLERY, ...input }),
      (error: unknown) => error instanceof ActionError && pattern.test(error.message), JSON.stringify(input));
  }
});

test('zonder layout_-velden wordt de weergave niet eens gelezen', async () => {
  const update = action('gallery.update_settings');
  // Een galerij-rij zónder layout-kolom, zoals vóór de migratie.
  const plan = await update.plan!(ctx({ galleries: [{ title: 'Oud', status: 'draft', allow_downloads: false, expires_at: null }] }), {
    gallery_id: GALLERY, title: 'Nieuw',
  });
  assert.deepEqual(plan.payload.patch, { title: 'Nieuw' });
});

test('groot tonen: foto’s aan of uit, video’s geweigerd', async () => {
  const featured = action('gallery.set_featured');
  const photoRows = {
    galleries: [{ title: 'Bruiloft', status: 'published' }],
    gallery_items: [{ id: PHOTO, file_name: 'kus.jpg', gallery_id: GALLERY, media_type: 'photo' }],
  };
  const plan = await featured.plan!(ctx(photoRows), { gallery_id: GALLERY, item_ids: [PHOTO] });
  assert.equal(plan.title, '1 foto groot tonen in "Bruiloft"');
  assert.match(plan.sub, /kus\.jpg/);
  assert.match(plan.sub, /GEPUBLICEERD/);
  assert.deepEqual(plan.payload, { gallery_id: GALLERY, gallery_title: 'Bruiloft', item_ids: [PHOTO], featured: true });

  const off = await featured.plan!(ctx(photoRows), { gallery_id: GALLERY, item_ids: [PHOTO], featured: false });
  assert.equal(off.payload.featured, false);
  assert.match(off.title, /weer gewoon tonen/);

  const videoRows = {
    galleries: [{ title: 'Bruiloft', status: 'draft' }],
    gallery_items: [{ id: VIDEO, file_name: 'film.mp4', gallery_id: GALLERY, media_type: 'video' }],
  };
  await assert.rejects(featured.plan!(ctx(videoRows), { gallery_id: GALLERY, item_ids: [VIDEO] }),
    (error: unknown) => error instanceof ActionError && /film\.mp4" is een video/.test(error.message));

  const elsewhere = {
    galleries: [{ title: 'Bruiloft', status: 'draft' }],
    gallery_items: [{ id: PHOTO, file_name: 'kus.jpg', gallery_id: 'c0000000-0000-4000-8000-0000000000ff', media_type: 'photo' }],
  };
  await assert.rejects(featured.plan!(ctx(elsewhere), { gallery_id: GALLERY, item_ids: [PHOTO] }),
    (error: unknown) => error instanceof ActionError && /hoort bij een andere galerij/.test(error.message));
});
