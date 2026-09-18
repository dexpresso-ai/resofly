import test from 'node:test';
import assert from 'node:assert/strict';
import {
  callConversation, callCounterpart, callDurationLabel, callPreview, callSubject,
  describeMatches, formatPhone, matchPhoneLocally, normalizePhoneE164, telHref,
} from './calls.ts';
import type { Client, ClientCall, ClientContact, Supplier } from '../types.ts';

/**
 * Tests voor de pure gesprekslaag. Het zwaartepunt ligt op de
 * nummer-normalisatie: die bepaalt of de app een bestaand contact herkent, en
 * een fout daarin werkt stil door — je ziet geen foutmelding, je ziet alleen
 * geen match.
 */

function call(patch: Partial<ClientCall> = {}): ClientCall {
  return {
    id: 'c1', organization_id: 'org', created_by: 'u1',
    client_id: null, contact_id: null, supplier_id: null, project_id: null, ticket_id: null,
    counterpart_name: null, phone_raw: null, phone_e164: null,
    direction: 'outbound', outcome: 'answered',
    started_at: '2026-09-18T10:00:00.000Z', ended_at: null, duration_seconds: null,
    subject: '', notes: null, source: 'manual',
    provider: null, provider_call_id: null, dedup_key: null, follow_up_task_id: null,
    metadata: {}, created_at: '2026-09-18T10:00:00.000Z', updated_at: '2026-09-18T10:00:00.000Z',
    ...patch,
  };
}

// ── Normalisatie ─────────────────────────────────────────────────────────────

test('dezelfde Nederlandse nummers komen op één waarde uit', () => {
  const expected = '+31612345678';
  for (const written of ['06-12345678', '06 12 34 56 78', '+31 6 12345678', '0031 6 12345678', '+31612345678', '612345678', '(06) 1234 5678']) {
    assert.equal(normalizePhoneE164(written), expected, `${written} hoort ${expected} te worden`);
  }
});

test('vaste nummers en servicenummers normaliseren mee', () => {
  assert.equal(normalizePhoneE164('010-1234567'), '+31101234567');
  assert.equal(normalizePhoneE164('085 123 4567'), '+31851234567');
  assert.equal(normalizePhoneE164('+31 (0)20 123 45 67'), '+31201234567');
});

test('dit is precies waar de bestaande dedupe-normalisatie tekortschiet', () => {
  // normalize_client_phone_value() gooit alle niet-cijfers weg: '+31 6 1234 5678'
  // wordt dan '31612345678' en '06-12345678' wordt '0612345678' — twee waarden.
  const stripNonDigits = (v: string) => v.replace(/[^0-9]+/g, '');
  assert.notEqual(stripNonDigits('+31 6 12345678'), stripNonDigits('06-12345678'));
  assert.equal(normalizePhoneE164('+31 6 12345678'), normalizePhoneE164('06-12345678'));
});

test('de trunk-0 tussen haakjes na het landnummer vervalt', () => {
  // '+31 (0)20 …' staat op ontelbare Nederlandse briefpapieren en websites.
  assert.equal(normalizePhoneE164('+31 (0)20 123 45 67'), '+31201234567');
  assert.equal(normalizePhoneE164('+31 (0)6 12345678'), '+31612345678');
  assert.equal(normalizePhoneE164('0031 (0)20 1234567'), '+31201234567');
  // Buiten Nederland blijven we van de 0 af: daar kan hij bij het nummer horen.
  assert.equal(normalizePhoneE164('+39 06 12345678'), '+390612345678');
});

test('buitenlandse nummers blijven heel', () => {
  assert.equal(normalizePhoneE164('+49 30 123456'), '+4930123456');
  assert.equal(normalizePhoneE164('0032 2 1234567'), '+3221234567');
});

test('afgeschermde en onbruikbare nummers geven null', () => {
  for (const value of ['', '   ', 'anonymous', 'Onbekend', 'ANONIEM', 'geheim', 'abc', '1234', '06-123']) {
    assert.equal(normalizePhoneE164(value), null, `${JSON.stringify(value)} hoort null te geven`);
  }
  assert.equal(normalizePhoneE164(null), null);
  assert.equal(normalizePhoneE164(undefined), null);
});

test('een nummer met te veel cijfers is geen telefoonnummer', () => {
  assert.equal(normalizePhoneE164('+3161234567890123456'), null);
});

// ── Tonen ────────────────────────────────────────────────────────────────────

test('nummers krijgen hun vertrouwde Nederlandse vorm terug', () => {
  assert.equal(formatPhone('+31612345678'), '06 12 34 56 78');
  assert.equal(formatPhone('+31101234567'), '010 123 45 67');
  assert.equal(formatPhone('+31851234567'), '085 123 4567');
  // Netnummer van drie cijfers valt niet onder de tweecijferige lijst.
  assert.equal(formatPhone('+31113456789'), '0113 456 789');
});

test('een buitenlands nummer wordt niet naar Nederlands model verbogen', () => {
  assert.equal(formatPhone('+4930123456'), '+4930123456');
});

test('onleesbare invoer blijft staan zoals hij is', () => {
  assert.equal(formatPhone('doorkiesnummer 204'), 'doorkiesnummer 204');
  assert.equal(formatPhone(null), '');
});

test('telHref levert een bel-link met landnummer, of niets', () => {
  assert.equal(telHref('06-12345678'), 'tel:+31612345678');
  assert.equal(telHref('anoniem'), null);
});

test('gespreksduur leest als een mens hem zou uitspreken', () => {
  assert.equal(callDurationLabel(null), '—');
  assert.equal(callDurationLabel(0), '—');
  assert.equal(callDurationLabel(48), '48 sec');
  assert.equal(callDurationLabel(60), '1 min');
  assert.equal(callDurationLabel(252), '4 min 12 sec');
  assert.equal(callDurationLabel(3780), '1 u 03 min');
});

// ── Onderwerp, tegenpartij en preview ────────────────────────────────────────

test('met wie je sprak: naam vóór nummer, nummer vóór niets', () => {
  assert.equal(callCounterpart(call({ counterpart_name: 'Maria de Vries', phone_e164: '+31612345678' })), 'Maria de Vries');
  assert.equal(callCounterpart(call({ phone_e164: '+31612345678' })), '06 12 34 56 78');
  assert.equal(callCounterpart(call()), 'Onbekend nummer');
});

test('zonder eigen onderwerp bouwt het gesprek er zelf een', () => {
  assert.equal(callSubject(call({ counterpart_name: 'Maria', direction: 'outbound' })), 'Gebeld met Maria');
  assert.equal(callSubject(call({ counterpart_name: 'Maria', direction: 'inbound' })), 'Gebeld door Maria');
  assert.equal(callSubject(call({ counterpart_name: 'Maria', outcome: 'missed' })), 'Gemist — Maria');
  assert.equal(callSubject(call({ subject: 'Offerte doorgenomen', counterpart_name: 'Maria' })), 'Offerte doorgenomen');
});

test('de previewregel is de aantekening, anders de feiten', () => {
  assert.equal(callPreview(call({ notes: 'Wil de offerte voor vrijdag' })), 'Wil de offerte voor vrijdag');
  assert.equal(callPreview(call({ duration_seconds: 252 })), 'Uitgaand · Gesproken · 4 min 12 sec');
  assert.equal(callPreview(call({ outcome: 'missed', direction: 'inbound' })), 'Inkomend · Gemist');
});

test('een gesprek wordt een gespreksregel met de juiste sleutel en sorteertijd', () => {
  const row = callConversation(
    call({ id: 'abc', client_id: 'k1', started_at: '2026-09-17T09:30:00.000Z', counterpart_name: 'Maria', notes: 'Offerte' }),
    { clientName: 'Bakker BV' },
  );
  assert.equal(row.key, 'call:abc');
  assert.equal(row.kind, 'call');
  assert.equal(row.clientName, 'Bakker BV');
  assert.equal(row.lastAt, '2026-09-17T09:30:00.000Z');
  // Een gesprek heeft geen ongelezen-teller: je hebt het zelf gevoerd.
  assert.equal(row.unread, 0);
});

test('zonder klant heet het gesprek "Geen klant", zoals een los ticket', () => {
  assert.equal(callConversation(call(), { clientName: null }).clientName, 'Geen klant');
});

test('zoeken kijkt ook in het nummer en in wat er gezegd is', () => {
  const row = callConversation(
    call({ phone_e164: '+31612345678', counterpart_name: 'Maria' }),
    { clientName: 'Bakker BV', summary: 'Klant wil de levering een week opschuiven.', transcript: '…dan doen we het een week later…' },
  );
  assert.ok(row.searchText.includes('06 12 34 56 78'));
  assert.ok(row.searchText.includes('+31612345678'));
  assert.ok(row.searchText.includes('opschuiven'));
  assert.ok(row.searchText.includes('een week later'));
});

test('een mislukt gesprek valt op als probleem, een gemist gesprek niet', () => {
  assert.equal(callConversation(call({ outcome: 'failed' }), { clientName: null }).hasProblem, true);
  assert.equal(callConversation(call({ outcome: 'missed' }), { clientName: null }).hasProblem, false);
});

// ── Nummerherkenning ─────────────────────────────────────────────────────────

function client(patch: Partial<Client>): Client {
  return { id: 'k1', organization_id: 'org', created_by: null, name: 'Bakker BV', phone: null, contact_name: null, ...patch } as Client;
}
function contact(patch: Partial<ClientContact>): ClientContact {
  return {
    id: 'ct1', organization_id: 'org', created_by: null, client_id: 'k1', name: 'Maria de Vries',
    email: 'maria@bakker.nl', phone: null, role: null, gives_portal_access: false, is_active: true,
    created_at: '', updated_at: '', ...patch,
  };
}
function supplier(patch: Partial<Supplier>): Supplier {
  return {
    id: 's1', organization_id: 'org', created_by: null, name: 'Drukkerij Jansen',
    phone: null, contact_name: null, supplier_code: null, email: null, ...patch,
  } as Supplier;
}

test('een nummer vindt zijn contact, ongeacht hoe beide genoteerd zijn', () => {
  const matches = matchPhoneLocally('+31 6 12345678', {
    clients: [client({ phone: '06-12345678' })],
    contacts: [],
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match_kind, 'client');
  assert.equal(matches[0].display_name, 'Bakker BV');
});

test('één kantoornummer bij meerdere mensen geeft ALLE treffers, niet de eerste', () => {
  const matches = matchPhoneLocally('010-1234567', {
    clients: [client({ phone: '010 123 45 67' })],
    contacts: [
      contact({ id: 'ct1', name: 'Maria de Vries', phone: '+31101234567' }),
      contact({ id: 'ct2', name: 'Jan Bakker', phone: '010-1234567' }),
    ],
  });
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(m => m.match_kind), ['client', 'client_contact', 'client_contact']);
  assert.equal(matches[1].client_name, 'Bakker BV');
});

test('een contactpersoon die niet meer actief is telt niet mee', () => {
  const matches = matchPhoneLocally('06-12345678', {
    clients: [],
    contacts: [contact({ phone: '06-12345678', is_active: false })],
  });
  assert.deepEqual(matches, []);
});

test('leveranciers doen mee als ze meegegeven worden', () => {
  const matches = matchPhoneLocally('020-1234567', {
    clients: [],
    contacts: [],
    suppliers: [supplier({ phone: '+31201234567' })],
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].match_kind, 'supplier');
});

test('een afgeschermd nummer levert nooit een match op', () => {
  const matches = matchPhoneLocally('anonymous', {
    clients: [client({ phone: '06-12345678' })],
    contacts: [contact({ phone: '06-12345678' })],
  });
  assert.deepEqual(matches, []);
});

test('de samenvatting van de treffers zegt of er iets te kiezen valt', () => {
  assert.equal(describeMatches([]), 'Geen bekend contact met dit nummer');
  const one = matchPhoneLocally('06-12345678', { clients: [client({})], contacts: [contact({ phone: '06-12345678' })] });
  assert.equal(describeMatches(one), 'Maria de Vries (Bakker BV)');
  const many = matchPhoneLocally('010-1234567', {
    clients: [client({ phone: '010-1234567' })],
    contacts: [contact({ phone: '010-1234567' })],
  });
  assert.equal(describeMatches(many), '2 contacten met dit nummer — kies er één');
});
