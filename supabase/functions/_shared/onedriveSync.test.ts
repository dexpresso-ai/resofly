/**
 * De regels van de kopie van Inhoud in OneDrive (onedriveSync.ts). Draaien
 * met:  npm test
 *
 * Wat hier fout gaat: een koppeling die meer kan dan nodig, een terugkeeradres
 * waar een ander de code ontvangt, een naam die OneDrive weigert (en dan stopt
 * de kopie), een financieel bestand dat toch meegaat, of een fout van
 * Microsoft die als "gelukt" telt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOAuthState, signOAuthState } from './calendarOAuth.ts';
import {
  MAX_JOB_ATTEMPTS,
  NO_CLIENT_FOLDER,
  ONEDRIVE_RETURN_PARAMS,
  buildOneDriveAuthorizeUrl,
  classifyGraphResponse,
  contentVersion,
  decryptToken,
  documentFileName,
  encryptToken,
  hasFilesScope,
  isDriveId,
  mirrorableKey,
  nextAttemptDelaySeconds,
  numberedName,
  onedriveRefreshScopes,
  onedriveScopes,
  onedriveStateSecret,
  rootFolderName,
  safeDriveName,
  strictReturnTo,
} from './onedriveSync.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';
const APP = 'https://app.resofly.nl';

test('Microsoft: de eigen OneDrive en een vernieuwtoken, niet meer', () => {
  const scopes = onedriveScopes();
  assert.ok(scopes.includes('Files.ReadWrite'));
  assert.ok(scopes.includes('offline_access'));
  assert.ok(!scopes.some(s => /\.All$/.test(s)), 'geen rechten op wat anderen delen of op SharePoint');
  assert.ok(!scopes.some(s => /Calendars|Contacts/.test(s)), 'geen agendarechten');
});

test('zonder het recht op bestanden telt de koppeling niet', () => {
  assert.equal(hasFilesScope(['User.Read', 'openid']), false);
  assert.equal(hasFilesScope(['https://graph.microsoft.com/Files.ReadWrite']), true);
  assert.equal(hasFilesScope(null), false);
});

test('vernieuwen vraagt alleen wat er gegeven is', () => {
  assert.deepEqual(onedriveRefreshScopes([]), onedriveScopes());
  const kept = onedriveRefreshScopes(['Files.ReadWrite', 'User.Read']);
  assert.ok(kept.includes('offline_access') && kept.includes('Files.ReadWrite') && kept.includes('User.Read'));
  assert.ok(!kept.includes('email'));
});

test('de toestemmingslink', () => {
  const url = new URL(buildOneDriveAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x.supabase.co/functions/v1/onedrive-sync', state: 's', tenant: 'organizations', loginHint: 'eigenaar@bedrijf.nl' }));
  assert.equal(url.hostname, 'login.microsoftonline.com');
  assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('scope'), onedriveScopes().join(' '));
  assert.equal(url.searchParams.get('response_mode'), 'query');
  assert.equal(url.searchParams.get('login_hint'), 'eigenaar@bedrijf.nl');
  const zonder = new URL(buildOneDriveAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://r', state: 's', tenant: '' }));
  assert.equal(zonder.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(zonder.searchParams.get('prompt'), 'select_account');
});

test('een state van de agenda geldt hier niet, en andersom', async () => {
  const secret = 'een-lang-geheim-van-minstens-32-tekens!!';
  const now = Math.floor(Date.now() / 1000);
  const state = { provider: 'microsoft' as const, userId: USER, organizationId: ORG, returnTo: `${APP}/`, nonce: NONCE, iat: now, exp: now + 600 };
  const agenda = await signOAuthState(state, secret);
  const onedrive = await signOAuthState(state, onedriveStateSecret(secret));
  assert.equal((await checkOAuthState(agenda, onedriveStateSecret(secret), [APP])).ok, false);
  assert.equal((await checkOAuthState(onedrive, secret, [APP])).ok, false);
  assert.equal((await checkOAuthState(onedrive, onedriveStateSecret(secret), [APP])).ok, true);
  assert.equal(onedriveStateSecret(''), '');
});

test('het terugkeeradres: alleen de ingestelde adressen, geen previews', () => {
  const cleaned = new URL(strictReturnTo(`${APP}/?onedrive_code=x&onedrive_state=y&onedrive_error=z&tab=1`, [APP]));
  for (const key of ONEDRIVE_RETURN_PARAMS) assert.equal(cleaned.searchParams.has(key), false);
  assert.equal(cleaned.searchParams.get('tab'), '1');
  assert.throws(() => strictReturnTo('https://iets.resofly.pages.dev/', [APP]), /niet toegestaan/, 'een preview telt niet');
  assert.throws(() => strictReturnTo('https://evil.example/', [APP]), /niet toegestaan/);
  assert.throws(() => strictReturnTo('javascript:alert(1)', [APP]), /Ongeldig/);
  assert.throws(() => strictReturnTo('', [APP]), /Ongeldig/);
  assert.equal(new URL(strictReturnTo('http://localhost:5173/x', [])).origin, 'http://localhost:5173', 'zonder instelling alleen lokaal');
  assert.throws(() => strictReturnTo(`${APP}/`, []), /niet toegestaan/);
  assert.equal(new URL(strictReturnTo('https://user:pw@app.resofly.nl/', [APP])).username, '');
});

test('namen die OneDrive accepteert', () => {
  assert.equal(safeDriveName('Offerte: v2 / "definitief"?'), 'Offerte- v2 - -definitief--');
  assert.equal(safeDriveName('  rapport.  '), 'rapport');
  assert.equal(safeDriveName('CON'), '_CON');
  assert.equal(safeDriveName('nul.txt'), '_nul.txt');
  assert.equal(safeDriveName('~$tijdelijk.docx'), '_tijdelijk.docx');
  assert.equal(safeDriveName('map_vti_x'), 'map_vti-x');
  assert.equal(safeDriveName('desktop.ini'), '_desktop.ini');
  assert.equal(safeDriveName(''), 'Naamloos');
  assert.equal(safeDriveName('\u0000\u0007'), 'Naamloos');
  const lang = safeDriveName(`${'a'.repeat(400)}.pdf`);
  assert.ok(lang.length <= 200 && lang.endsWith('.pdf'), 'lang, maar de extensie blijft');
});

test('een tweede bestand met dezelfde naam', () => {
  assert.equal(numberedName('rapport.pdf', 2), 'rapport (2).pdf');
  assert.equal(numberedName('Klanten', 3), 'Klanten (3)');
});

test('een Office-document krijgt zijn extensie', () => {
  assert.equal(documentFileName('Offerte website', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', null), 'Offerte website.docx');
  assert.equal(documentFileName('Begroting.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', null), 'Begroting.xlsx');
  assert.equal(documentFileName('Pitch', 'application/octet-stream', `${ORG}/document/abc-pitch.pptx`), 'Pitch.pptx', 'anders uit de sleutel');
  assert.equal(documentFileName('', null, null), 'Document');
});

test('de map van de organisatie', () => {
  assert.equal(rootFolderName('Studio Lopik'), 'ResoFly - Studio Lopik');
  assert.equal(rootFolderName(''), 'ResoFly');
  assert.equal(rootFolderName('A/B: C'), 'ResoFly - A-B- C');
  assert.equal(NO_CLIENT_FOLDER, 'Zonder klant');
});

test('een nieuwe versie uit de editor telt als nieuwe inhoud', () => {
  const a = contentVersion({ storage_key: 'k', edit_version: 1, size_bytes: 10 });
  assert.notEqual(a, contentVersion({ storage_key: 'k', edit_version: 2, size_bytes: 10 }));
  assert.notEqual(a, contentVersion({ storage_key: 'k2', edit_version: 1, size_bytes: 10 }));
  assert.equal(a, contentVersion({ storage_key: 'k', edit_version: 1, size_bytes: 10 }));
});

test('id\'s van Microsoft zijn nooit een pad', () => {
  assert.equal(isDriveId('01ABCDEF2345GHIJ'), true);
  assert.equal(isDriveId('D1B2C3!123'), true);
  assert.equal(isDriveId('b!x-y_z'), true);
  assert.equal(isDriveId('..'), false);
  assert.equal(isDriveId('a..b'), false);
  assert.equal(isDriveId('...'), false);
  assert.equal(isDriveId('a/b'), false);
  assert.equal(isDriveId(''), false);
  assert.equal(isDriveId('x'.repeat(513)), false);
});

test('alleen bestanden uit Inhoud gaan naar OneDrive, nooit financiële stukken', () => {
  assert.equal(mirrorableKey(`${ORG}/folder/f1/abc-logo.png`, ORG), true);
  assert.equal(mirrorableKey(`${ORG}/document/abc-plan.docx`, ORG), true);
  for (const segment of ['invoice-pdfs', 'quote-pdfs', 'contract-pdfs', 'annual-account-pdfs', 'e-invoices', 'invoice', 'purchase_invoice', 'gallery', 'transfer']) {
    assert.equal(mirrorableKey(`${ORG}/${segment}/x.pdf`, ORG), false, segment);
  }
  assert.equal(mirrorableKey(`22222222-2222-4222-8222-222222222222/folder/x.pdf`, ORG), false, 'een andere organisatie');
  assert.equal(mirrorableKey(`${ORG}/folder/../invoice-pdfs/x.pdf`, ORG), false);
  assert.equal(mirrorableKey(null, ORG), false);
});

test('antwoorden van Microsoft: wat telt als gelukt, weg, opnieuw of mislukt', () => {
  assert.deepEqual(classifyGraphResponse(201, {}), { kind: 'ok' });
  assert.deepEqual(classifyGraphResponse(204, null), { kind: 'ok' });
  assert.deepEqual(classifyGraphResponse(404, {}), { kind: 'gone' });
  assert.deepEqual(classifyGraphResponse(409, { error: { code: 'nameAlreadyExists' } }), { kind: 'conflict' });
  assert.equal(classifyGraphResponse(401, {}).kind, 'reconnect');
  assert.equal(classifyGraphResponse(507, {}).kind, 'full');
  assert.equal(classifyGraphResponse(403, { error: { code: 'quotaLimitReached' } }).kind, 'full');
  const throttled = classifyGraphResponse(429, {}, '120');
  assert.equal(throttled.kind, 'retry');
  assert.equal(throttled.kind === 'retry' && throttled.retryAfterSeconds, 120);
  assert.equal(classifyGraphResponse(423, {}).kind, 'retry');
  assert.equal(classifyGraphResponse(503, {}, 'onzin').kind, 'retry');
  assert.equal(classifyGraphResponse(0, null).kind, 'retry');
  assert.equal(classifyGraphResponse(400, { error: { code: 'invalidRequest', message: 'Bad name' } }).kind, 'failed');
});

test('opnieuw proberen wacht steeds langer, en minstens wat Microsoft vraagt', () => {
  assert.equal(nextAttemptDelaySeconds(1), 60);
  assert.equal(nextAttemptDelaySeconds(2), 120);
  assert.equal(nextAttemptDelaySeconds(50), 6 * 3600);
  assert.equal(nextAttemptDelaySeconds(1, 300), 300);
  assert.equal(nextAttemptDelaySeconds(1, 10 ** 9), 24 * 3600);
  assert.ok(MAX_JOB_ATTEMPTS >= 3);
});

test('tokens versleutelen en weer lezen, en niet met een andere sleutel', async () => {
  const key = 'sleutel-van-minstens-zestien-tekens';
  const encrypted = await encryptToken('EwB-geheim', key);
  assert.notEqual(encrypted, 'EwB-geheim');
  assert.equal(await decryptToken(encrypted, key), 'EwB-geheim');
  await assert.rejects(() => decryptToken(encrypted, 'een-andere-sleutel-van-zestien'));
  await assert.rejects(() => encryptToken('x', 'kort'));
});
