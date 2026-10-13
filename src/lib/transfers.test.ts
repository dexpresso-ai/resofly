import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSFER_MAX_FILE_BYTES,
  expiryForServer,
  fileRefusal,
  formatBytes,
  parseLooseEmails,
  recipientInputs,
  recipientStatus,
  remainingLabel,
  selectionClient,
  transferRecipientOptions,
  transferState,
} from './transfers.ts';
import { resolveShareContext } from './shares.ts';
import type { AppData, FileTransferRecipient } from '../types';

/**
 * Bestanden versturen in het scherm: wie er in de ontvangerlijst staat, wat er
 * al vóór het uploaden geweigerd wordt, en hoe een ontvanger erbij staat. De
 * grens zelf ligt in de database; dit is de spiegel waardoor je er niet
 * tegenaan loopt.
 */

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function data(): AppData {
  return {
    clients: [
      { id: CLIENT, name: 'Bakker BV', contact_name: 'Joost de Vries', email: 'Info@Bakker.nl' },
      { id: OTHER, name: 'Smit', contact_name: null, email: null },
    ],
    clientContacts: [
      { id: 'c1', client_id: CLIENT, name: 'Anna', email: 'anna@bakker.nl', is_active: true, gives_portal_access: false, role: 'Inkoop' },
      { id: 'c2', client_id: CLIENT, name: 'Oud', email: 'oud@bakker.nl', is_active: false, gives_portal_access: true, role: null },
      { id: 'c3', client_id: CLIENT, name: 'Dubbel', email: 'info@bakker.nl', is_active: true, gives_portal_access: true, role: null },
      { id: 'c4', client_id: OTHER, name: 'Elders', email: 'x@smit.nl', is_active: true, gives_portal_access: true, role: null },
    ],
    folders: [
      { id: 'f1', client_id: CLIENT, project_id: null },
      { id: 'f2', client_id: OTHER, project_id: null },
    ],
    notes: [{ id: 'n0', client_id: null, project_id: null }],
    documents: [],
    attachments: [
      { id: 'a1', entity_type: 'folder', entity_id: 'f1' },
      { id: 'a2', entity_type: 'folder', entity_id: 'f2' },
    ],
    projects: [],
    tasks: [],
    tickets: [],
  } as unknown as AppData;
}

test('ontvangers: hoofdadres en actieve contactpersonen van díe klant, elk adres één keer', () => {
  const options = transferRecipientOptions(data(), CLIENT);
  assert.deepEqual(options.map((o) => o.key), ['client', 'contact:c1']);
  assert.equal(options[0].email, 'info@bakker.nl');
  assert.equal(options[0].name, 'Joost de Vries');
  assert.equal(options[1].portal, false, 'portaaltoegang is niet nodig om iets te ontvangen');
  assert.deepEqual(transferRecipientOptions(data(), OTHER).map((o) => o.key), ['contact:c4'], 'zonder geldig hoofdadres alleen de contactpersoon');
  assert.deepEqual(transferRecipientOptions(data(), null), []);
  assert.deepEqual(recipientInputs(options), [
    { kind: 'client', expectedEmail: 'info@bakker.nl' },
    { kind: 'contact', clientContactId: 'c1', expectedEmail: 'anna@bakker.nl' },
  ]);
});

test('een selectie hoort bij één klant; twee dossiers door elkaar wordt geen zending', () => {
  const d = data();
  const resolve = (type: Parameters<typeof resolveShareContext>[1], id: string) => resolveShareContext(d, type, id);
  assert.deepEqual(selectionClient([{ type: 'attachment', id: 'a1' }, { type: 'folder', id: 'f1' }], resolve), { clientId: CLIENT, clientName: 'Bakker BV', mixed: false });
  assert.equal(selectionClient([{ type: 'attachment', id: 'a1' }, { type: 'attachment', id: 'a2' }], resolve).mixed, true);
  assert.deepEqual(selectionClient([{ type: 'note', id: 'n0' }], resolve), { clientId: null, clientName: null, mixed: false });
});

test('weigeren vóór het uploaden: programma’s, te groot, leeg', () => {
  assert.match(fileRefusal({ name: 'setup.EXE', size: 10 }) ?? '', /\.exe/);
  assert.match(fileRefusal({ name: 'film.mov', size: TRANSFER_MAX_FILE_BYTES + 1 }) ?? '', /1 GB/);
  assert.match(fileRefusal({ name: 'leeg.txt', size: 0 }) ?? '', /leeg/);
  assert.equal(fileRefusal({ name: 'offerte.pdf', size: 1000 }), null);
  assert.equal(fileRefusal({ name: 'film.mov', size: TRANSFER_MAX_FILE_BYTES }), null, 'precies 1 GB mag');
});

test('vervaldatum naar de server: dagen of een gekozen dag', () => {
  assert.equal(expiryForServer('7', ''), 7);
  assert.equal(expiryForServer('custom', '2026-11-12'), '2026-11-12');
  assert.equal(expiryForServer('custom', ''), null);
  assert.equal(expiryForServer('onzin', ''), null);
});

test('de stand van een zending', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  assert.equal(transferState({ status: 'draft', expires_at: '2026-11-01T00:00:00Z', purged_at: null }, now), 'draft');
  assert.equal(transferState({ status: 'sent', expires_at: '2026-11-01T00:00:00Z', purged_at: null }, now), 'active');
  assert.equal(transferState({ status: 'sent', expires_at: '2026-10-01T00:00:00Z', purged_at: null }, now), 'expired', 'over de datum, ook vóór de opruimtaak');
  assert.equal(transferState({ status: 'revoked', expires_at: '2026-11-01T00:00:00Z', purged_at: null }, now), 'revoked');
  assert.equal(remainingLabel('2026-10-25T12:00:00Z', now), 'nog 12 dagen');
  assert.equal(remainingLabel('2026-10-13T17:00:00Z', now), 'nog 5 uur');
  assert.equal(remainingLabel('2026-10-13T11:00:00Z', now), 'verlopen');
});

test('hoe een ontvanger erbij staat', () => {
  const base: FileTransferRecipient = {
    id: 'r', organization_id: 'o', transfer_id: 't', kind: 'client', client_contact_id: null,
    email: 'info@bakker.nl', name: 'Joost', client_email_id: null, notified_at: '2026-10-13T10:00:00Z',
    notify_error: null, delivery_status: 'sent', first_opened_at: null, last_opened_at: null, open_count: 0,
    first_downloaded_at: null, last_downloaded_at: null, download_count: 0, revoked_at: null, created_at: '',
  };
  assert.equal(recipientStatus(base).label, 'Verstuurd');
  assert.equal(recipientStatus({ ...base, delivery_status: 'delivered' }).label, 'Afgeleverd');
  assert.equal(recipientStatus({ ...base, delivery_status: 'bounced' }).tone, 'danger');
  assert.equal(recipientStatus({ ...base, first_opened_at: 'x' }).label, 'Geopend');
  assert.equal(recipientStatus({ ...base, first_downloaded_at: 'x', download_count: 3 }).label, 'Gedownload (3×)');
  assert.equal(recipientStatus({ ...base, revoked_at: 'x', first_downloaded_at: 'x' }).label, 'Ingetrokken');
  assert.equal(recipientStatus({ ...base, notified_at: null, notify_error: 'Resend 500' }).label, 'Mail niet verstuurd');
  // Te vaak een foute code: dat moet de afzender zien, ook als er al gedownload is.
  assert.equal(recipientStatus({ ...base, code_blocked_at: 'x', first_downloaded_at: 'x' }).tone, 'danger');
});

test('losse adressen en bytes', () => {
  assert.deepEqual(parseLooseEmails('A@x.nl, b@y.nl; a@x.nl\nkapot'), { emails: ['a@x.nl', 'b@y.nl'], invalid: ['kapot'] });
  assert.equal(formatBytes(1536), '1,5 KB');
  assert.equal(formatBytes(0), '0 B');
});
