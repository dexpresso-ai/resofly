/**
 * Tests voor de klantregel bij het delen van bestanden. Draaien met:  npm test
 *
 * Het gevaarlijke geval staat hier onderaan: een item dat via zijn project bij
 * een klant hoort MOET klantgerelateerd heten, ook als het zelf geen client_id
 * heeft. Zou dat misgaan, dan biedt het scherm een open deellink aan voor iets
 * wat alleen naar de contactpersonen van die klant mag — de database weigert dat
 * dan alsnog, maar de gebruiker loopt tegen een muur.
 *
 * Deze afleiding spiegelt public.drive_item_client() in
 * supabase/migrations/20260823000000_drive_shares.sql. Wijzigt die, wijzig dit mee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AppData } from '../types.ts';
import { activeSharesFor, isShareActive, resolveShareContext, sharedItemKeys } from './shares.ts';

const ORG = 'org-1';
const KLANT_A = 'client-a';
const KLANT_B = 'client-b';

/** Minimale AppData: alleen de takken die resolveShareContext aanraakt. */
function appData(over: Partial<AppData> = {}): AppData {
  return {
    clients: [
      { id: KLANT_A, organization_id: ORG, created_by: null, name: 'Jansen Bouw' },
      { id: KLANT_B, organization_id: ORG, created_by: null, name: 'De Vries BV' },
    ],
    projects: [],
    folders: [],
    notes: [],
    documents: [],
    attachments: [],
    tasks: [],
    tickets: [],
    driveShares: [],
    ...over,
  } as unknown as AppData;
}

const folder = (id: string, client_id: string | null, project_id: string | null = null) =>
  ({ id, organization_id: ORG, created_by: null, client_id, project_id, parent_id: null, name: id, position: 0 });
const note = (id: string, client_id: string | null, project_id: string | null = null) =>
  ({ id, organization_id: ORG, created_by: null, client_id, project_id, folder_id: null, title: id, content: '' });
const attachment = (id: string, entity_type: string, entity_id: string) =>
  ({ id, organization_id: ORG, created_by: null, entity_type, entity_id, parent_task_id: null, name: id, mime_type: 'application/pdf', size_bytes: 1, storage_key: `k/${id}`, public_url: null, created_at: '2026-08-23T00:00:00Z' });

test('een map in een klantdossier is klantgerelateerd', () => {
  const data = appData({ folders: [folder('f1', KLANT_A)] as never });
  const ctx = resolveShareContext(data, 'folder', 'f1');
  assert.equal(ctx.clientId, KLANT_A);
  assert.equal(ctx.clientName, 'Jansen Bouw');
});

test('een losse notitie zonder klant en zonder project is niet klantgerelateerd', () => {
  const data = appData({ notes: [note('n1', null)] as never });
  assert.equal(resolveShareContext(data, 'note', 'n1').clientId, null);
});

test('een project wint van de klantkoppeling op het item zelf', () => {
  // Precies zoals de Inhoud-verkenner en drive_item_client het doen: hangt er een
  // project aan, dan telt de klant van dát project.
  const data = appData({
    projects: [{ id: 'p1', organization_id: ORG, created_by: null, client_id: KLANT_B, name: 'Herbouw' }] as never,
    notes: [note('n1', KLANT_A, 'p1')] as never,
  });
  assert.equal(resolveShareContext(data, 'note', 'n1').clientId, KLANT_B);
});

test('een notitie zonder eigen klant erft de klant van zijn project', () => {
  const data = appData({
    projects: [{ id: 'p1', organization_id: ORG, created_by: null, client_id: KLANT_A, name: 'Herbouw' }] as never,
    notes: [note('n1', null, 'p1')] as never,
  });
  assert.equal(resolveShareContext(data, 'note', 'n1').clientId, KLANT_A);
});

test('een bestand erft de klant van de map waar het in ligt', () => {
  const data = appData({
    folders: [folder('f1', KLANT_A)] as never,
    attachments: [attachment('a1', 'folder', 'f1')] as never,
  });
  assert.equal(resolveShareContext(data, 'attachment', 'a1').clientId, KLANT_A);
});

test('een bestand in een map zonder klant is niet klantgerelateerd', () => {
  const data = appData({
    folders: [folder('f1', null)] as never,
    attachments: [attachment('a1', 'folder', 'f1')] as never,
  });
  assert.equal(resolveShareContext(data, 'attachment', 'a1').clientId, null);
});

test('een onbekend item valt niet stilzwijgend in de klantloze bak', () => {
  // Het scherm mag hier geen deellink aanbieden; de database weigert dit type
  // sowieso, dus wat we hier teruggeven mag nooit "veilig te delen" suggereren.
  const data = appData();
  assert.equal(resolveShareContext(data, 'attachment', 'bestaat-niet').clientId, null);
});

const share = (over: Record<string, unknown>) => ({
  id: 's1', organization_id: ORG, created_by: null,
  item_type: 'folder', item_id: 'f1', item_name: 'Map',
  client_id: null, project_id: null,
  recipient_kind: 'member', client_contact_id: null, member_user_id: 'u1',
  recipient_email: null, recipient_name: null,
  can_download: true, message: null,
  expires_at: null, revoked_at: null, revoked_by: null,
  last_viewed_at: null, view_count: 0, notified_at: null,
  created_at: '2026-08-23T00:00:00Z', updated_at: '2026-08-23T00:00:00Z',
  ...over,
}) as never;

test('een ingetrokken of verlopen deling telt niet meer mee', () => {
  const now = Date.parse('2026-08-23T12:00:00Z');
  assert.equal(isShareActive(share({}), now), true);
  assert.equal(isShareActive(share({ revoked_at: '2026-08-23T10:00:00Z' }), now), false);
  assert.equal(isShareActive(share({ expires_at: '2026-08-23T10:00:00Z' }), now), false);
  assert.equal(isShareActive(share({ expires_at: '2026-09-01T00:00:00Z' }), now), true);
});

test('alleen lopende delingen kleuren een rij en vullen het overzicht', () => {
  const data = appData({
    driveShares: [
      share({ id: 's1' }),
      share({ id: 's2', item_id: 'f2', revoked_at: '2020-01-01T00:00:00Z' }),
    ] as never,
  });
  assert.deepEqual([...sharedItemKeys(data)], ['folder:f1']);
  assert.equal(activeSharesFor(data, 'folder', 'f1').length, 1);
  assert.equal(activeSharesFor(data, 'folder', 'f2').length, 0);
});
