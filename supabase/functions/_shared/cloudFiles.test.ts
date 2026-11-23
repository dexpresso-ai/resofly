/**
 * De regels van Google Drive en OneDrive koppelen (cloudFiles.ts). Draaien
 * met:  npm test
 *
 * Wat hier fout gaat, raakt de bestanden van iemand anders: een token voor de
 * kiezer dat de agenda kan lezen, een "volgende pagina" naar een vreemde site
 * met het token van de gebruiker erbij, een link die niet naar Google of
 * Microsoft gaat, of een fout van Drive die als "weggegooid" telt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOAuthState, signOAuthState } from './calendarOAuth.ts';
import {
  DRIVE_RETURN_PARAMS,
  GOOGLE_DRIVE_FILE_SCOPE,
  MAX_DELETE_ATTEMPTS,
  buildDriveAuthorizeUrl,
  classifyDeleteResponse,
  cleanCloudName,
  cloudStorageKey,
  decryptToken,
  driveStateSecret,
  encryptToken,
  googleDriveScopes,
  hasDriveScope,
  isCloudStorageKey,
  isProviderId,
  microsoftDriveRefreshScopes,
  microsoftDriveScopes,
  nextAttemptDelaySeconds,
  parseGoogleFile,
  parseMicrosoftItem,
  pickerTokenScopesOk,
  safeCloudWebUrl,
  safeGraphNextLink,
  stripDriveReturnParams,
} from './cloudFiles.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';
const APP = 'https://app.resofly.nl';

test('Google vraagt alleen drive.file, nooit de hele Drive', () => {
  const scopes = googleDriveScopes();
  assert.ok(scopes.includes(GOOGLE_DRIVE_FILE_SCOPE));
  assert.ok(!scopes.some(s => /\/auth\/drive(\.readonly)?$/.test(s)), 'drive en drive.readonly zijn "restricted" bij Google');
  assert.ok(!scopes.some(s => s.includes('calendar')));
});

test('Microsoft vraagt de eigen OneDrive en een vernieuwtoken', () => {
  const scopes = microsoftDriveScopes();
  assert.ok(scopes.includes('Files.ReadWrite'));
  assert.ok(scopes.includes('offline_access'));
  assert.ok(!scopes.includes('Files.ReadWrite.All'), 'niet alles wat met de gebruiker gedeeld is');
});

test('de toestemmingslink van Google voegt geen eerdere rechten samen', () => {
  const url = new URL(buildDriveAuthorizeUrl({ provider: 'google', clientId: 'cid', redirectUri: 'https://x.supabase.co/functions/v1/cloud-files', state: 's', microsoftTenant: 'common' }));
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), googleDriveScopes().join(' '));
  assert.equal(url.searchParams.get('state'), 's');
});

test('de toestemmingslink van Microsoft gebruikt de ingestelde tenant', () => {
  const url = new URL(buildDriveAuthorizeUrl({ provider: 'microsoft', clientId: 'cid', redirectUri: 'https://r', state: 's', microsoftTenant: 'organizations', loginHint: 'jan@bedrijf.nl' }));
  assert.equal(url.pathname, '/organizations/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('response_mode'), 'query');
  assert.equal(url.searchParams.get('login_hint'), 'jan@bedrijf.nl');
  assert.equal(url.searchParams.get('prompt'), null);
  const zonder = new URL(buildDriveAuthorizeUrl({ provider: 'microsoft', clientId: 'cid', redirectUri: 'https://r', state: 's', microsoftTenant: '', loginHint: 'geen adres' }));
  assert.equal(zonder.pathname, '/common/oauth2/v2.0/authorize');
  assert.equal(zonder.searchParams.get('prompt'), 'select_account');
});

test('zonder het vinkje voor Drive telt de koppeling niet', () => {
  assert.equal(hasDriveScope('google', ['openid', 'email']), false);
  assert.equal(hasDriveScope('google', ['openid', GOOGLE_DRIVE_FILE_SCOPE]), true);
  assert.equal(hasDriveScope('microsoft', ['User.Read']), false);
  assert.equal(hasDriveScope('microsoft', ['https://graph.microsoft.com/Files.ReadWrite', 'User.Read']), true);
  assert.equal(hasDriveScope('microsoft', null), false);
});

test('een token voor de kiezer mag alleen bestanden kiezen', () => {
  assert.equal(pickerTokenScopesOk(['openid', 'https://www.googleapis.com/auth/userinfo.email', GOOGLE_DRIVE_FILE_SCOPE]), true);
  assert.equal(pickerTokenScopesOk([GOOGLE_DRIVE_FILE_SCOPE, 'https://www.googleapis.com/auth/calendar.events']), false,
    'samengevoegd met de agenda: niet naar de browser');
  assert.equal(pickerTokenScopesOk(['openid', 'email']), false, 'zonder drive.file heeft de kiezer niets');
  assert.equal(pickerTokenScopesOk([]), false);
});

test('Microsoft vernieuwt alleen met de rechten die er zijn', () => {
  assert.deepEqual(microsoftDriveRefreshScopes([]), microsoftDriveScopes());
  const kept = microsoftDriveRefreshScopes(['Files.ReadWrite', 'User.Read', 'openid']);
  assert.ok(kept.includes('offline_access'));
  assert.ok(kept.includes('Files.ReadWrite'));
  assert.ok(!kept.includes('email'), 'niet gegeven, dan ook niet vragen');
});

test('een state van de agenda geldt niet voor Drive, en andersom', async () => {
  const secret = 'een-lang-geheim-van-minstens-32-tekens!!';
  const now = Math.floor(Date.now() / 1000);
  const state = { provider: 'google' as const, userId: USER, organizationId: ORG, returnTo: `${APP}/`, nonce: NONCE, iat: now, exp: now + 600 };
  const agenda = await signOAuthState(state, secret);
  const drive = await signOAuthState(state, driveStateSecret(secret));
  assert.equal((await checkOAuthState(agenda, driveStateSecret(secret), [APP])).ok, false);
  assert.equal((await checkOAuthState(drive, secret, [APP])).ok, false);
  assert.equal((await checkOAuthState(drive, driveStateSecret(secret), [APP])).ok, true);
  assert.equal(driveStateSecret(''), '', 'zonder geheim geen afgeleid geheim');
});

test('het terugkeeradres verliest de eigen parameters', () => {
  const cleaned = new URL(stripDriveReturnParams(`${APP}/?drive_code=x&drive_state=y&drive_error=z&drive_provider=google&tab=1`));
  for (const key of DRIVE_RETURN_PARAMS) assert.equal(cleaned.searchParams.has(key), false);
  assert.equal(cleaned.searchParams.get('tab'), '1');
});

test('de opslagsleutel staat onder de organisatie, in het segment cloud', () => {
  const key = cloudStorageKey(ORG, 'microsoft', NONCE);
  assert.equal(key, `${ORG}/cloud/microsoft/${NONCE}`);
  assert.equal(isCloudStorageKey(key), true);
  assert.equal(isCloudStorageKey(`${ORG}/folder/abc.pdf`), false);
  assert.equal(isCloudStorageKey(null), false);
});

test('een link gaat alleen naar Google of Microsoft, over https', () => {
  assert.equal(safeCloudWebUrl('google', 'https://drive.google.com/file/d/abc/view'), 'https://drive.google.com/file/d/abc/view');
  assert.equal(safeCloudWebUrl('google', 'https://docs.google.com/document/d/abc/edit'), 'https://docs.google.com/document/d/abc/edit');
  assert.equal(safeCloudWebUrl('google', 'https://evil.example/drive.google.com'), null);
  assert.equal(safeCloudWebUrl('google', 'http://drive.google.com/x'), null);
  assert.equal(safeCloudWebUrl('google', 'javascript:alert(1)'), null);
  assert.equal(safeCloudWebUrl('google', 'https://user:pw@drive.google.com/x'), null);
  assert.equal(safeCloudWebUrl('microsoft', 'https://contoso-my.sharepoint.com/personal/x/Documents/a.docx'), 'https://contoso-my.sharepoint.com/personal/x/Documents/a.docx');
  assert.equal(safeCloudWebUrl('microsoft', 'https://onedrive.live.com/?id=1'), 'https://onedrive.live.com/?id=1');
  assert.equal(safeCloudWebUrl('microsoft', 'https://sharepoint.com.evil.example/x'), null);
  assert.equal(safeCloudWebUrl('microsoft', 'https://drive.google.com/x'), null, 'elke aanbieder zijn eigen adressen');
});

test('"meer laden" bij OneDrive gaat alleen naar Graph zelf', () => {
  assert.equal(safeGraphNextLink('https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc'), 'https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc');
  assert.equal(safeGraphNextLink('https://graph.microsoft.com.evil.example/v1.0/x'), null);
  assert.equal(safeGraphNextLink('https://graph.microsoft.com/beta/x'), null);
  assert.equal(safeGraphNextLink('http://graph.microsoft.com/v1.0/x'), null);
  assert.equal(safeGraphNextLink(42), null);
});

test('id\'s van de aanbieder zijn nooit een pad', () => {
  assert.equal(isProviderId('1AbC-_x.y!z'), true);
  assert.equal(isProviderId('../etc/passwd'), false);
  assert.equal(isProviderId('a/b'), false);
  assert.equal(isProviderId(''), false);
  assert.equal(isProviderId('x'.repeat(513)), false);
});

test('een bestandsnaam wordt leesbaar en zonder schuine strepen', () => {
  assert.equal(cleanCloudName('  rapport/2026\\q1.pdf  '), 'rapport-2026-q1.pdf');
  assert.equal(cleanCloudName('\u0000'), 'Bestand');
  assert.equal(cleanCloudName('x'.repeat(400)).length, 255);
});

test('wat Google over een bestand zegt', () => {
  const meta = parseGoogleFile({ id: 'abc', name: 'Offerte.pdf', mimeType: 'application/pdf', size: '2048', webViewLink: 'https://drive.google.com/file/d/abc/view', capabilities: { canTrash: false } });
  assert.deepEqual(meta, { id: 'abc', driveId: null, name: 'Offerte.pdf', mimeType: 'application/pdf', size: 2048, webUrl: 'https://drive.google.com/file/d/abc/view', canDelete: false, isFolder: false, trashed: false });
  const doc = parseGoogleFile({ id: 'doc1', name: 'Notulen', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://evil.example/x' });
  assert.equal(doc?.size, null, 'een Google-document heeft geen grootte');
  assert.equal(doc?.webUrl, 'https://drive.google.com/file/d/doc1/view', 'een vreemde link vervangen door die van Drive');
  assert.equal(parseGoogleFile({ id: 'map', mimeType: 'application/vnd.google-apps.folder' })?.isFolder, true);
  assert.equal(parseGoogleFile({ id: '../x' }), null);
  assert.equal(parseGoogleFile(null), null);
});

test('wat OneDrive over een bestand zegt', () => {
  const meta = parseMicrosoftItem({ id: '01ABC', name: 'Plan.docx', size: 10, webUrl: 'https://onedrive.live.com/?id=01ABC', file: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, parentReference: { driveId: 'b!xyz' } });
  assert.equal(meta?.driveId, 'b!xyz');
  assert.equal(meta?.isFolder, false);
  assert.equal(meta?.size, 10);
  assert.equal(parseMicrosoftItem({ id: '01F', name: 'Map', folder: { childCount: 3 }, parentReference: { driveId: 'b!x' } })?.isFolder, true);
  assert.equal(parseMicrosoftItem({ id: '01N', name: 'Notitieblok', package: { type: 'oneNote' } })?.isFolder, true, 'een OneNote-notitieblok is geen los bestand');
  assert.equal(parseMicrosoftItem({ id: '01D', deleted: { state: 'deleted' } })?.trashed, true);
});

test('weggooien: wat telt als klaar, opnieuw of mislukt', () => {
  assert.deepEqual(classifyDeleteResponse('google', 200, {}), { kind: 'done', note: null });
  assert.deepEqual(classifyDeleteResponse('microsoft', 204, null), { kind: 'done', note: null });
  assert.equal(classifyDeleteResponse('google', 404, {}).kind, 'done', 'al weg: niets meer te doen');
  const verlopen = classifyDeleteResponse('microsoft', 401, {});
  assert.equal(verlopen.kind, 'failed');
  assert.equal(verlopen.kind === 'failed' && verlopen.failure, 'connection');
  const geenEigenaar = classifyDeleteResponse('google', 403, { error: { code: 403, errors: [{ reason: 'insufficientFilePermissions' }], message: 'The user does not have sufficient permissions' } });
  assert.equal(geenEigenaar.kind === 'failed' && geenEigenaar.failure, 'permission');
  assert.equal(classifyDeleteResponse('google', 403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }).kind, 'retry', 'een quotum is later opnieuw');
  assert.equal(classifyDeleteResponse('microsoft', 423, {}).kind, 'retry', 'vergrendeld: iemand heeft het open');
  assert.equal(classifyDeleteResponse('microsoft', 429, {}).kind, 'retry');
  assert.equal(classifyDeleteResponse('google', 503, {}).kind, 'retry');
  assert.equal(classifyDeleteResponse('google', 0, null).kind, 'retry', 'geen antwoord: later opnieuw');
  assert.equal(classifyDeleteResponse('microsoft', 400, {}).kind, 'failed');
});

test('opnieuw proberen wacht steeds langer, tot een grens', () => {
  assert.equal(nextAttemptDelaySeconds(1), 300);
  assert.equal(nextAttemptDelaySeconds(2), 600);
  assert.equal(nextAttemptDelaySeconds(100), 12 * 3600);
  assert.ok(MAX_DELETE_ATTEMPTS >= 3);
});

test('tokens versleutelen en weer lezen, en niet met een andere sleutel', async () => {
  const key = 'sleutel-van-minstens-zestien-tekens';
  const encrypted = await encryptToken('ya29.geheim', key);
  assert.notEqual(encrypted, 'ya29.geheim');
  assert.equal(await decryptToken(encrypted, key), 'ya29.geheim');
  await assert.rejects(() => decryptToken(encrypted, 'een-andere-sleutel-van-zestien'));
  await assert.rejects(() => encryptToken('x', 'kort'));
  await assert.rejects(() => decryptToken('geen-punt', key));
});
