import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSenderIdentity } from './sendingDomain.ts';

/**
 * Welke afzender en welke Reply-To krijgt een mail? De keuze gebeurt bij elk
 * verzendpad (offerte, factuur, klantmail, campagne) met deze ene functie.
 */

type Row = Record<string, unknown>;

/** Net genoeg van supabase-js: from().select().eq()…order() en maybeSingle(), gefilterd op eq. */
function fakeAdmin(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () => (tables[table] ?? []).filter((row) => filters.every(([key, value]) => row[key] === value));
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
        order: () => builder,
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
      };
      return builder;
    },
  } as never;
}

const ORG = 'org-1';
const PLATFORM = 'ResoFly <no-reply@mail.resofly.nl>';
const PLATFORM_REPLY = 'hallo@resofly.nl';

function domain(overrides: Row = {}): Row {
  return {
    id: 'd1', organization_id: ORG, domain: 'bakkerij.nl', from_email: 'info@bakkerij.nl', from_name: 'Bakkerij',
    status: 'verified', is_default: false, created_at: '2026-10-01T00:00:00Z', ...overrides,
  };
}

test('zonder geverifieerd domein: het standaardadres met de standaard Reply-To', async () => {
  for (const rows of [[], [domain({ status: 'pending' })], [domain({ organization_id: 'andere-org' })]]) {
    const sender = await resolveSenderIdentity(fakeAdmin({ organization_email_domains: rows }), ORG, PLATFORM, PLATFORM_REPLY);
    assert.deepEqual(sender, { from: PLATFORM, replyTo: PLATFORM_REPLY, domainId: null, fromEmail: null });
  }
});

test('met eigen domein: antwoorden komen bij de organisatie, niet bij ResoFly', async () => {
  const sender = await resolveSenderIdentity(fakeAdmin({ organization_email_domains: [domain()] }), ORG, PLATFORM, PLATFORM_REPLY);
  assert.equal(sender.from, '"Bakkerij" <info@bakkerij.nl>');
  assert.equal(sender.replyTo, 'info@bakkerij.nl');
  assert.equal(sender.fromEmail, 'info@bakkerij.nl');
  assert.equal(sender.domainId, 'd1');
});

test('een domein zonder (bruikbaar) afzenderadres wordt overgeslagen, een ander domein niet', async () => {
  const rows = [
    domain({ id: 'leeg', domain: 'leeg.nl', from_email: null, is_default: true }),
    domain({ id: 'raar', domain: 'raar.nl', from_email: 'a>,"x"@raar.nl' }),
    domain({ id: 'goed', domain: 'goed.nl', from_email: 'post@goed.nl', from_name: 'Goed' }),
  ];
  const sender = await resolveSenderIdentity(fakeAdmin({ organization_email_domains: rows }), ORG, PLATFORM, PLATFORM_REPLY);
  assert.equal(sender.from, '"Goed" <post@goed.nl>');
  assert.equal(sender.domainId, 'goed');

  const alleenLeeg = await resolveSenderIdentity(fakeAdmin({ organization_email_domains: [rows[0]] }), ORG, PLATFORM, PLATFORM_REPLY);
  assert.equal(alleenLeeg.from, PLATFORM);
  assert.equal(alleenLeeg.replyTo, PLATFORM_REPLY);
});

test('een adres dat niet op het eigen domein staat, telt niet', async () => {
  const sender = await resolveSenderIdentity(
    fakeAdmin({ organization_email_domains: [domain({ from_email: 'ceo@ander-bedrijf.nl' })] }), ORG, PLATFORM, PLATFORM_REPLY);
  assert.equal(sender.from, PLATFORM);
});

test('persoonlijke afzender: naam altijd, adres alleen op een geverifieerd domein van de eigen organisatie', async () => {
  const tables = (personal: Row) => ({
    organization_email_domains: [domain(), domain({ id: 'x', organization_id: 'andere-org', domain: 'ander.nl', from_email: 'info@ander.nl' })],
    user_sender_identities: [{ organization_id: ORG, user_id: 'u1', ...personal }],
  });

  const eigen = await resolveSenderIdentity(fakeAdmin(tables({ from_name: 'Jan', from_email: 'jan@bakkerij.nl' })), ORG, PLATFORM, PLATFORM_REPLY, 'u1');
  assert.equal(eigen.from, '"Jan" <jan@bakkerij.nl>');
  assert.equal(eigen.replyTo, 'jan@bakkerij.nl');

  // Het domein van een andere organisatie in hetzelfde Resend-account: alleen de naam telt.
  const ander = await resolveSenderIdentity(fakeAdmin(tables({ from_name: 'Jan', from_email: 'ceo@ander.nl' })), ORG, PLATFORM, PLATFORM_REPLY, 'u1');
  assert.equal(ander.from, '"Jan" <info@bakkerij.nl>');

  // Een adres met tekens die een tweede afzender in de header smokkelen: genegeerd.
  const smokkel = await resolveSenderIdentity(fakeAdmin(tables({ from_name: 'Jan', from_email: 'x>,"y"@bakkerij.nl' })), ORG, PLATFORM, PLATFORM_REPLY, 'u1');
  assert.equal(smokkel.from, '"Jan" <info@bakkerij.nl>');

  // De naam kan geen tweede adres worden.
  const naam = await resolveSenderIdentity(fakeAdmin(tables({ from_name: 'Evil" <ceo@ander.nl>, x', from_email: null })), ORG, PLATFORM, PLATFORM_REPLY, 'u1');
  assert.equal(naam.from, '"Evil ceo ander.nl x" <info@bakkerij.nl>');
});

test('een fout bij het ophalen valt stil terug op het standaardadres', async () => {
  const broken = { from: () => { throw new Error('database weg'); } } as never;
  const sender = await resolveSenderIdentity(broken, ORG, PLATFORM, PLATFORM_REPLY);
  assert.deepEqual(sender, { from: PLATFORM, replyTo: PLATFORM_REPLY, domainId: null, fromEmail: null });
});
