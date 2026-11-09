import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindFailureEndsSession, bindFailureMessage, bindFailureStatus, bindPortalSession, isPortalSecret, portalSessionScope,
  portalTokenScope, randomPortalCode, sessionIdFromToken, type BindFailure,
} from './portalSession.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION = '7fe8b35e-4435-46d2-bfe8-5f04e4078999';
const USER = 'd999fb01-390d-401f-9fea-de237c7a8766';

/** Een token zoals Supabase Auth het geeft; de handtekening doet hier niet ter zake. */
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}.handtekening`;
}

/** Een nep-Supabase die alleen rpc kent, en onthoudt wat er gevraagd werd. */
function fakeAdmin(answer: { data?: unknown; error?: unknown }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as Parameters<typeof portalSessionScope>[0] & { calls: typeof calls };
}

test('sessionIdFromToken: de sessie uit het token, en niets bij een vreemd token', () => {
  assert.equal(sessionIdFromToken(token({ sub: USER, session_id: SESSION, amr: [{ method: 'otp' }] })), SESSION);
  assert.equal(sessionIdFromToken(token({ sub: USER, session_id: SESSION.toUpperCase() })), SESSION, 'hoofdletters maken niet uit');
  assert.equal(sessionIdFromToken(token({ sub: USER })), null, 'zonder sessie (een service-sleutel)');
  assert.equal(sessionIdFromToken(token({ session_id: 'geen-uuid' })), null);
  assert.equal(sessionIdFromToken(token({ session_id: 42 })), null);
  assert.equal(sessionIdFromToken('geen.token'), null);
  assert.equal(sessionIdFromToken(''), null);
  assert.equal(sessionIdFromToken('a.%%%.b'), null);
});

test('portalSessionScope: alles, één organisatie, of niets', async () => {
  const alles = fakeAdmin({ data: { ok: true, organizationId: null } });
  assert.deepEqual(await portalSessionScope(alles, SESSION, USER, 'resofly.com'), { ok: true, organizationId: null });
  assert.deepEqual(alles.calls, [{ name: 'portal_session_scope', args: { p_session_id: SESSION, p_user_id: USER, p_base: 'resofly.com' } }]);

  assert.deepEqual(await portalSessionScope(fakeAdmin({ data: { ok: true, organizationId: ORG } }), SESSION, USER, 'resofly.com'),
    { ok: true, organizationId: ORG });
  assert.deepEqual(await portalSessionScope(fakeAdmin({ data: { ok: false, reason: 'host' } }), SESSION, USER, 'resofly.com'),
    { ok: false, reason: 'host' });
  assert.deepEqual(await portalSessionScope(fakeAdmin({ data: { ok: false, reason: 'iets' } }), SESSION, USER, 'resofly.com'),
    { ok: false, reason: 'unbound' });
  assert.deepEqual(await portalSessionScope(fakeAdmin({ data: null }), SESSION, USER, 'resofly.com'), { ok: false, reason: 'unbound' });
  // Een vreemd organisatie-id is nooit "alles".
  assert.deepEqual(await portalSessionScope(fakeAdmin({ data: { ok: true, organizationId: 'org-a' } }), SESSION, USER, 'resofly.com'),
    { ok: true, organizationId: null });
});

test('portalSessionScope: zonder sessie niets, en een storing is een fout (geen "alles")', async () => {
  const geen = fakeAdmin({ data: { ok: true, organizationId: null } });
  assert.deepEqual(await portalSessionScope(geen, null, USER, 'resofly.com'), { ok: false, reason: 'unbound' });
  assert.equal(geen.calls.length, 0, 'zonder sessie wordt er niets opgezocht');
  await assert.rejects(() => portalSessionScope(fakeAdmin({ error: { message: 'function does not exist' } }), SESSION, USER, 'resofly.com'));
});

test('bindPortalSession: geeft de aanvraag door en leest het antwoord', async () => {
  const admin = fakeAdmin({ data: { ok: true, organizationId: ORG } });
  const args = { sessionId: SESSION, userId: USER, requestHash: 'a'.repeat(64), verifierHashes: ['b'.repeat(64)], originOrganizationId: ORG };
  assert.deepEqual(await bindPortalSession(admin, args), { ok: true, organizationId: ORG });
  assert.deepEqual(admin.calls[0], {
    name: 'portal_session_bind',
    args: { p_session_id: SESSION, p_user_id: USER, p_request_hash: 'a'.repeat(64), p_verifier_hashes: ['b'.repeat(64)], p_origin_organization_id: ORG },
  });
  assert.deepEqual(await bindPortalSession(fakeAdmin({ data: { ok: false, reason: 'verifier' } }), args), { ok: false, reason: 'verifier' });
  assert.deepEqual(await bindPortalSession(fakeAdmin({ data: { ok: false, reason: 'raar' } }), args), { ok: false, reason: 'session' });
  await assert.rejects(() => bindPortalSession(fakeAdmin({ error: { message: 'kapot' } }), args));
});

test('bindFailure*: een zin zonder techniek, een status, en wanneer de inlog weg moet', () => {
  const reasons: BindFailure[] = ['session', 'bound', 'request', 'expired', 'verifier', 'origin', 'method'];
  for (const reason of reasons) {
    const text = bindFailureMessage(reason);
    assert.ok(text.length > 10 && !/session|verifier|origin|token|hash/i.test(text), `${reason}: ${text}`);
    assert.ok([403, 410].includes(bindFailureStatus(reason)));
  }
  assert.equal(bindFailureStatus('expired'), 410);
  // Een inlog die al ergens vastligt, gooien we niet weg: dan was dit een
  // tweede aanroep, of iemand die andermans inlog probeert te verbuigen.
  assert.equal(bindFailureEndsSession('bound'), false);
  for (const reason of reasons.filter(r => r !== 'bound')) assert.equal(bindFailureEndsSession(reason), true, reason);
});

test('randomPortalCode: acht cijfers, en de te hoge waarden worden overgeslagen', () => {
  for (let i = 0; i < 200; i += 1) assert.match(randomPortalCode(), /^\d{8}$/);
  // 4294967295 valt boven de grens (4200000000): die wordt overgeslagen.
  const values = [4_294_967_295, 4_200_000_000, 7];
  assert.equal(randomPortalCode(() => values.shift() as number), '00000007');
  assert.equal(randomPortalCode(() => 4_199_999_999), '99999999');
  assert.equal(randomPortalCode(() => 123_456_789), '23456789');
});

test('isPortalSecret: alleen base64url van 30 tot 100 tekens', () => {
  assert.equal(isPortalSecret('a'.repeat(43)), true);
  assert.equal(isPortalSecret('Ab3_kQ9-xYz12345678901234567890abcdefghijk'), true);
  for (const value of ['kort', 'a'.repeat(101), `${'a'.repeat(40)}=`, `${'a'.repeat(40)}/`, 42, null, undefined]) {
    assert.equal(isPortalSecret(value), false, String(value));
  }
});

test('portalTokenScope: één organisatie op één domein, of niets', async () => {
  const hash = 'c'.repeat(64);
  const goed = fakeAdmin({ data: { ok: true, userId: USER, organizationId: ORG, host: 'portaal.jansen.nl' } });
  assert.deepEqual(await portalTokenScope(goed, hash), { ok: true, userId: USER, organizationId: ORG, host: 'portaal.jansen.nl' });
  assert.deepEqual(goed.calls, [{ name: 'portal_token_scope', args: { p_token_hash: hash } }]);
  assert.deepEqual(await portalTokenScope(fakeAdmin({ data: { ok: false, reason: 'host' } }), hash), { ok: false, reason: 'host' });
  // Een antwoord zonder organisatie is nooit "alles".
  assert.deepEqual(await portalTokenScope(fakeAdmin({ data: { ok: true, userId: USER, organizationId: null, host: 'x.nl' } }), hash),
    { ok: false, reason: 'unbound' });
  const geen = fakeAdmin({ data: { ok: true } });
  assert.deepEqual(await portalTokenScope(geen, 'geen-hash'), { ok: false, reason: 'unbound' });
  assert.equal(geen.calls.length, 0, 'een rare hash wordt niet opgezocht');
  await assert.rejects(() => portalTokenScope(fakeAdmin({ error: { message: 'kapot' } }), hash));
});
