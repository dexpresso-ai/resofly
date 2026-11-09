import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { quotaRefusal } from './emailQuota.ts';

test('binnen de grens: geen weigering', () => {
  assert.equal(quotaRefusal({ ok: true, hour: 3, day: 10, hourly_limit: 200, daily_limit: 1000 }), null);
  assert.equal(quotaRefusal(null), null);
});

test('over de grens: een duidelijke zin met de grenzen', () => {
  const message = quotaRefusal({ ok: false, hour: 200, day: 200, hourly_limit: 200, daily_limit: 1000 });
  assert.ok(message && message.includes('200 per uur') && message.includes('1000 per dag'));
});

test('de vrije klantmail en de agenda-uitnodigingen tellen mee', () => {
  const mail = readFileSync(new URL('../mail/index.ts', import.meta.url), 'utf8');
  const calendar = readFileSync(new URL('./calendarEventWrite.ts', import.meta.url), 'utf8');
  assert.match(mail, /await takeEmailQuota\(supabaseAdmin, organizationId, 1,/);
  assert.match(calendar, /await takeEmailQuota\(supabaseAdmin, organizationId, current\.length,/);
});

test('elke verzendroute via Resend telt mee in het quotum', () => {
  // Wie een nieuwe route maakt die mail verstuurt, moet het quotum aanroepen
  // (takeEmailQuota, of emailQuotaAllows waar het wachten moet in plaats van
  // falen). Alleen de generieke helper zelf (resend.ts) hoeft dat niet.
  const root = new URL('../', import.meta.url);
  const files: string[] = [];
  for (const dir of readdirSync(root)) {
    const full = new URL(`${dir}/`, root);
    if (!statSync(full).isDirectory()) continue;
    for (const name of readdirSync(full)) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(`${dir}/${name}`);
    }
  }
  const missing = files.filter((file) => {
    if (file === '_shared/resend.ts' || file === '_shared/emailQuota.ts') return false;
    // De inlogmail van het portaal vraagt niet de organisatie, maar iedereen
    // die een klantadres kent (met de herkomst van haar adres, na te maken).
    // In het quotum kon zo iedereen het mailquotum van een leverancier
    // opmaken, en dan gingen ook haar facturen niet meer weg. Daarom een eigen
    // rem per organisatie (en per adres en afzender); zie de test hieronder.
    if (file === 'portal-login/index.ts') return false;
    const source = readFileSync(new URL(file, root), 'utf8');
    const sends = source.includes('api.resend.com/emails') || /\bsendViaResend\(/.test(source);
    return sends && !/takeEmailQuota\(|emailQuotaAllows\(/.test(source);
  });
  assert.deepEqual(missing, [], 'Roep het mailquotum aan vlak voor het versturen (zie _shared/emailQuota.ts).');
});

test('de inlogmail van het portaal heeft een eigen rem per organisatie, los van het mailquotum', () => {
  const source = readFileSync(new URL('../portal-login/index.ts', import.meta.url), 'utf8');
  assert.match(source, /throttleHit\(await sha256Hex\(`portal-login:org:\$\{organizationId\}`\), 3600, LOGIN_MAILS_PER_ORGANIZATION_HOUR, 3600\)/);
  assert.ok(!/takeEmailQuota\(/.test(source), 'inlogmails tellen niet mee in het mailquotum van de organisatie');
});
