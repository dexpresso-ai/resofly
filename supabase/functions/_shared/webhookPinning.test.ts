import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliver, redactForKey, type ClaimedDelivery } from './webhookDelivery.ts';
import { TransportError, type PinnedRequest, type PinnedResponse } from './webhookTransport.ts';
import { encryptSecret, verifySignature } from './webhooks.ts';

/**
 * DNS-rebinding: een naam die bij onze controle naar een openbaar adres wijst
 * en bij het versturen naar 127.0.0.1. Daartegen helpt alleen dat we verbinden
 * met precies het adres dat we keurden. Deze tests draaien de echte deliver()
 * met een nagespeelde database, DNS en verbinding, en kijken WAARMEE er
 * verbonden wordt.
 */

const KEY = 'test-encryption-key';
const SECRET = 'whsec_testgeheim';

/** Een nagespeelde database: onthoudt de uitkomsten die deliver() vastlegt. */
function fakeAdmin() {
  const finished: Record<string, unknown>[] = [];
  const admin = {
    rpc: async (name: string, params: Record<string, unknown>) => {
      if (name === 'finish_webhook_delivery') finished.push(params);
      return { data: null, error: null };
    },
    from: () => { throw new Error('een eindpunt van de organisatie hoort geen sleutel op te zoeken'); },
  };
  return { admin: admin as never, finished };
}

async function delivery(url: string): Promise<ClaimedDelivery> {
  return {
    delivery_id: 'd1', endpoint_id: 'e1', organization_id: 'o1', attempts: 1, url, api_key_id: null,
    secret_encrypted: await encryptSecret(SECRET, KEY),
    event_id: 'ev1', event_type: 'client.created', event_module: 'clients',
    event_payload: { object: { id: 'c1', name: 'Klant BV' } }, event_created_at: '2026-10-03T12:00:00Z',
  };
}

/** Een verbinding die vastlegt waarmee er verbonden werd, en antwoordt zoals opgegeven. */
function recordingTransport(answer: (request: PinnedRequest) => PinnedResponse | Error) {
  const calls: PinnedRequest[] = [];
  const transport = async (request: PinnedRequest): Promise<PinnedResponse> => {
    calls.push(request);
    const result = answer(request);
    if (result instanceof Error) throw result;
    return result;
  };
  return { transport, calls };
}

const ok = (): PinnedResponse => ({ status: 200, body: new TextEncoder().encode('{"ok":true}') });

test('er wordt verbonden met het adres dat gekeurd is — de naam wordt niet opnieuw opgezocht', async () => {
  const { admin, finished } = fakeAdmin();
  let lookups = 0;
  // Een "rebinding"-naam: de eerste keer openbaar, daarna 127.0.0.1.
  const resolve = async () => (lookups++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
  const { transport, calls } = recordingTransport(ok);
  const outcome = await deliver(admin, await delivery('https://rebind.example.com/hook'), { encryptionKey: KEY, transport, resolve });
  assert.equal(outcome.status, 'delivered');
  assert.equal(lookups, 1, 'na de controle hoort er niet nog eens opgezocht te worden');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, '93.184.216.34');
  assert.equal(calls[0].url.hostname, 'rebind.example.com', 'TLS controleert het certificaat nog steeds tegen de naam');
  assert.equal(finished[0].p_ok, true);
});

test('een naam die nu naar binnen wijst: niets verstuurd, het eindpunt gaat uit', async () => {
  const { admin, finished } = fakeAdmin();
  const { transport, calls } = recordingTransport(ok);
  const outcome = await deliver(admin, await delivery('https://intern.example.com/hook'), {
    encryptionKey: KEY, transport, resolve: async () => ['93.184.216.34', '169.254.169.254'],
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(calls.length, 0);
  assert.match(String(finished[0].p_disable_reason), /intern adres/);
});

test('een naam zonder adres: niets verstuurd, later opnieuw', async () => {
  const { admin, finished } = fakeAdmin();
  const { transport, calls } = recordingTransport(ok);
  const outcome = await deliver(admin, await delivery('https://weg.example.com/hook'), { encryptionKey: KEY, transport, resolve: async () => [] });
  assert.equal(outcome.status, 'retrying');
  assert.equal(calls.length, 0);
  assert.equal(finished[0].p_disable_reason, null);
  assert.ok(Number(finished[0].p_retry_in_seconds) > 0);
});

test('geen verbinding met het eerste adres: het volgende goedgekeurde adres, nooit een ander', async () => {
  const { admin } = fakeAdmin();
  const { transport, calls } = recordingTransport((request) => (request.address === '93.184.216.34'
    ? new TransportError('Connection refused', 'connect') : ok()));
  const outcome = await deliver(admin, await delivery('https://twee.example.com/hook'), {
    encryptionKey: KEY, transport, resolve: async () => ['93.184.216.34', '93.184.216.35'],
  });
  assert.equal(outcome.status, 'delivered');
  assert.deepEqual(calls.map((call) => call.address), ['93.184.216.34', '93.184.216.35']);
});

test('een eindpunt dat wel opnam maar vastliep, krijgt geen tweede bericht via een ander adres', async () => {
  const { admin } = fakeAdmin();
  const { transport, calls } = recordingTransport(() => new TransportError('Geen antwoord', 'timeout'));
  const outcome = await deliver(admin, await delivery('https://traag.example.com/hook'), {
    encryptionKey: KEY, transport, resolve: async () => ['93.184.216.34', '93.184.216.35'],
  });
  assert.equal(outcome.status, 'retrying');
  assert.match(String(outcome.error), /Geen antwoord binnen 10 seconden/);
  assert.equal(calls.length, 1);
});

test('een doorverwijzing wordt niet gevolgd', async () => {
  const { admin } = fakeAdmin();
  const { transport, calls } = recordingTransport(() => ({ status: 302, body: new Uint8Array(0) }));
  const outcome = await deliver(admin, await delivery('https://door.example.com/hook'), {
    encryptionKey: KEY, transport, resolve: async () => ['93.184.216.34'],
  });
  assert.equal(outcome.status, 'retrying');
  assert.match(String(outcome.error), /doorverwijzing volgen we niet/);
  assert.equal(calls.length, 1);
});

test('verstuurd wordt precies wat ondertekend is', async () => {
  const { admin } = fakeAdmin();
  const { transport, calls } = recordingTransport(ok);
  await deliver(admin, await delivery('https://sig.example.com/hook'), { encryptionKey: KEY, transport, resolve: async () => ['93.184.216.34'] });
  const sent = calls[0];
  assert.ok(await verifySignature(SECRET, sent.headers['ResoFly-Signature'], sent.body));
  assert.equal(JSON.parse(sent.body).id, sent.headers['ResoFly-Event-Id']);
  assert.ok(sent.maxBodyBytes <= 4000 && sent.timeoutMs <= 10_000);
});

// ── Wat een sleutel zonder Financiën in een bericht ziet ────────────────────

const noFinance = (module: string) => module !== 'finance';

test('een tarief in een bericht: null voor een sleutel zonder Financiën', () => {
  const payload = { object: { id: 'p1', name: 'Project', hourly_rate_cents: 9500 } };
  assert.deepEqual(redactForKey('project.created', payload, noFinance), { object: { id: 'p1', name: 'Project', hourly_rate_cents: null } });
  assert.equal(redactForKey('project.created', payload, () => true), payload, 'wie alles mag, krijgt het bericht ongewijzigd');
});

test('veranderde alleen het tarief, dan is er voor die sleutel niets gebeurd', () => {
  const payload = {
    object: { id: 't1', minutes: 60, hourly_rate_cents: 12000 },
    changed: ['hourly_rate_cents'],
    previous: { hourly_rate_cents: 9500 },
  };
  assert.equal(redactForKey('time_entry.updated', payload, noFinance), null);
  const both = { ...payload, changed: ['hourly_rate_cents', 'minutes'], previous: { hourly_rate_cents: 9500, minutes: 30 } };
  assert.deepEqual(redactForKey('time_entry.updated', both, noFinance), {
    object: { id: 't1', minutes: 60, hourly_rate_cents: null },
    changed: ['minutes'],
    previous: { minutes: 30 },
  });
});

test('een klantwaarde ook; en een onderwerp zonder zulke velden blijft zoals het is', () => {
  assert.deepEqual(redactForKey('client.updated', { object: { value_eur: 5000 }, changed: ['value_eur', 'name'], previous: { value_eur: 1, name: 'a' } }, noFinance),
    { object: { value_eur: null }, changed: ['name'], previous: { name: 'a' } });
  const ticket = { object: { id: 'x', title: 'Vraag' } };
  assert.equal(redactForKey('ticket.created', ticket, noFinance), ticket);
});
