/**
 * Het logo van de organisatie in de mail (emailBrand.ts). Draaien met: npm test
 *
 * Wat hier vastligt: de maat komt uit het beeld zelf, het logo gaat als
 * ingesloten bijlage (cid) mee en vervangt de naam als bovenregel, en elke
 * route die mailt, vult de plek ook echt in. Tot november 2026 stond er in
 * geen enkele mail een logo, ook niet als de organisatie er een had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import {
  applyEmailBrand,
  EMAIL_LOGO_MAX,
  emailBrandFromRow,
  emailLogoFromDataUrl,
  loadEmailBrand,
  loadSenderBrand,
  loadSenderName,
  withEmailBrand,
  type EmailBrand,
} from './emailBrand.ts';
import {
  brandNameLine,
  EMAIL_LOGO_SLOT_DARK,
  EMAIL_LOGO_SLOT_LIGHT,
  EMAIL_LOGO_SLOT_SIGNATURE,
  renderEmailLayout,
} from './emailTemplates/layout.ts';
import { renderEmailTemplate } from './emailTemplates/index.ts';

/** De kop van een PNG: handtekening en IHDR met breedte en hoogte. */
function pngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt8(8, 24);
  bytes.writeUInt8(6, 25);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/** Een JPEG zoals canvas.toDataURL hem maakt: APP0 (JFIF), DQT, dan SOF0 met de maat. */
function jpegDataUrl(width: number, height: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(1)];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const bytes = Buffer.from([0xff, 0xd8, ...app0, ...dqt, ...sof0, 0xff, 0xd9]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

const realPng = `data:image/png;base64,${readFileSync(new URL('../../../public/icons/icon-512.png', import.meta.url)).toString('base64')}`;

function brand(over: Partial<EmailBrand> = {}): EmailBrand {
  return { name: 'Studio Noord', logo: emailLogoFromDataUrl(pngDataUrl(600, 150)), logoOnDark: null, ...over };
}

test('de maat komt uit het beeld en past binnen 200 × 56', () => {
  assert.deepEqual(
    { width: emailLogoFromDataUrl(pngDataUrl(600, 150))?.width, height: emailLogoFromDataUrl(pngDataUrl(600, 150))?.height },
    { width: 200, height: 50 },
  );
  const square = emailLogoFromDataUrl(realPng);
  assert.equal(square?.contentType, 'image/png');
  assert.deepEqual([square?.width, square?.height], [56, 56]);
  // Een klein logo wordt niet opgeblazen.
  assert.deepEqual([emailLogoFromDataUrl(pngDataUrl(120, 30))?.width, emailLogoFromDataUrl(pngDataUrl(120, 30))?.height], [120, 30]);
  const jpeg = emailLogoFromDataUrl(jpegDataUrl(480, 240));
  assert.equal(jpeg?.contentType, 'image/jpeg');
  assert.deepEqual([jpeg?.width, jpeg?.height], [112, 56]);
  assert.ok(EMAIL_LOGO_MAX.width >= 200 && EMAIL_LOGO_MAX.height >= 48);
});

test('WebP, rommel en een kapot beeld geven geen logo (en geen fout)', () => {
  // Outlook toont geen WebP; de app zet een WebP-upload al om naar JPEG.
  assert.equal(emailLogoFromDataUrl('data:image/webp;base64,UklGRg=='), null);
  assert.equal(emailLogoFromDataUrl('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(emailLogoFromDataUrl('https://example.test/logo.png'), null);
  assert.equal(emailLogoFromDataUrl('data:image/png;base64,AAAA'), null);
  assert.equal(emailLogoFromDataUrl('data:image/jpeg;base64,/9j/'), null);
  assert.equal(emailLogoFromDataUrl(null), null);
  assert.equal(emailLogoFromDataUrl(42), null);
});

test('uit de rij: handelsnaam vóór bedrijfsnaam, en de lichte versie apart', () => {
  const fromRow = emailBrandFromRow({ company_name: 'Noord B.V.', trade_name: 'Studio Noord', brand_logo_data_url: realPng, brand_logo_dark_data_url: pngDataUrl(400, 100) });
  assert.equal(fromRow.name, 'Studio Noord');
  assert.ok(fromRow.logo && fromRow.logoOnDark);
  assert.deepEqual(emailBrandFromRow(null), { name: '', logo: null, logoOnDark: null });
});

test('donkere kaart: het logo op een wit plaatje, in de plaats van de naam', () => {
  const html = renderEmailLayout({ brandName: 'Studio Noord', title: 'Je factuur', introHtml: '<p>Hoi</p>' });
  assert.equal(html.split(EMAIL_LOGO_SLOT_DARK).length, 2, 'één plek voor het logo');
  const { html: out, attachments } = applyEmailBrand(html, brand());
  assert.match(out, /<td style="background:#ffffff;border-radius:12px;padding:10px 14px;"><img src="cid:merklogo" width="200" height="50" alt="Studio Noord"/);
  assert.doesNotMatch(out, /text-transform:uppercase[^>]*>Studio Noord</, 'de naam als bovenregel is weg');
  assert.ok(!out.includes('merklogo:'), 'geen merkteken meer over');
  assert.equal(attachments.length, 1);
  assert.deepEqual({ ...attachments[0], content: '…' }, { filename: 'logo.png', content: '…', content_type: 'image/png', content_id: 'merklogo' });
});

test('donkere kaart met een lichte versie: die, zonder plaatje', () => {
  const html = renderEmailLayout({ brandName: 'Studio Noord', title: 'Je factuur', introHtml: '<p>Hoi</p>' });
  const { html: out, attachments } = applyEmailBrand(html, brand({ logoOnDark: emailLogoFromDataUrl(jpegDataUrl(400, 100)) }));
  assert.match(out, /<div style="margin:0 0 20px;"><img src="cid:merklogo-licht" width="200" height="50"/);
  assert.doesNotMatch(out, /background:#ffffff;border-radius:12px/);
  assert.deepEqual(attachments.map((a) => [a.content_id, a.filename, a.content_type]), [['merklogo-licht', 'logo.jpg', 'image/jpeg']]);
});

test('zonder logo: de mail zoals vroeger, met de naam als bovenregel', () => {
  const html = renderEmailLayout({ brandName: 'Studio Noord', title: 'Je factuur', introHtml: '<p>Hoi</p>' });
  for (const value of [null, undefined, brand({ logo: null })]) {
    const { html: out, attachments } = applyEmailBrand(html, value);
    assert.equal(attachments.length, 0);
    assert.ok(!/merklogo|merknaam/.test(out), 'geen merktekens meer over');
    assert.match(out, /letter-spacing:\.08em;font-weight:700;">Studio Noord<\/p>/);
  }
});

test('een andere bovenregel ("Betalingsherinnering") blijft gewoon staan onder het logo', () => {
  const rendered = renderEmailTemplate('invoice.reminder', {
    level: 1,
    invoice: { number: '2026-0042', due_date: '2026-10-01', lines: [{ description: 'Werk', quantity: 1, unit_price: 100, vat: 21 }] },
    client: { name: 'Klant B.V.' },
    company: { trade_name: 'Studio Noord' },
    publicUrl: 'https://example.test/invoice/x',
  });
  const { html } = applyEmailBrand(rendered.html, brand());
  assert.match(html, /cid:merklogo/);
  assert.match(html, />Betalingsherinnering<\/p>/);
});

test('alle klantmails uit de sjablonen hebben de plek voor het logo', () => {
  const company = { trade_name: 'Studio Noord', invoice_accent_color: '#2457C5' };
  const client = { name: 'Klant B.V.', contact_name: 'Sanne', email: 'sanne@example.test' };
  const mails = [
    renderEmailTemplate('quote.sent', { quote: { number: 'OF-1' }, client, company, publicUrl: 'https://x.test', expiresAt: '2026-12-01' }),
    renderEmailTemplate('invoice.sent', { invoice: { number: 'F-1' }, client, company, publicUrl: 'https://x.test', expiresAt: '2026-12-01' }),
    renderEmailTemplate('creditNote.sent', { creditNote: { number: 'CN-1' }, invoice: { number: 'F-1' }, client, company }),
    renderEmailTemplate('invoice.dunning.wik14', {
      clientKind: 'business', invoice: { number: 'F-1', due_date: '2026-09-01' }, client, company,
      amounts: { principalCents: 10000, interestCents: 0, interestDays: 0, collectionCostsCents: 4000, collectionCostsVatCents: 0, totalClaimCents: 14000 },
      deadlineDate: '2026-11-19', publicUrl: 'https://x.test',
    }),
    renderEmailTemplate('contract.sent', { contract: { number: 'C-1' }, client, company, publicUrl: 'https://x.test', expiresAt: '2026-12-01' }),
    renderEmailTemplate('file.transferCode', { code: '123456', companyName: 'Studio Noord' }),
  ];
  for (const mail of mails) {
    const { html, attachments } = applyEmailBrand(mail.html, brand());
    assert.equal(attachments.length, 1, mail.templateKey);
    assert.equal(html.split('cid:merklogo').length, 2, `${mail.templateKey}: precies één logo`);
  }
});

test('lichte kaart en handtekening: het gewone logo, nooit de lichte versie', () => {
  const top = applyEmailBrand(`<div>${EMAIL_LOGO_SLOT_LIGHT}<h1>Notulen</h1></div>`, brand({ logoOnDark: emailLogoFromDataUrl(realPng) }));
  assert.match(top.html, /^<div><div style="margin:0 0 20px;"><img src="cid:merklogo" /);
  assert.deepEqual(top.attachments.map((a) => a.content_id), ['merklogo']);

  const signature = applyEmailBrand(`<div>Hoi</div>${EMAIL_LOGO_SLOT_SIGNATURE}${brandNameLine('<p>Studio Noord</p>')}`, brand());
  assert.equal(signature.html, '<div>Hoi</div><div style="margin:16px 4px 0;"><img src="cid:merklogo" width="200" height="50" alt="Studio Noord" style="display:block;width:200px;height:50px;border:0;outline:none;text-decoration:none;" /></div>');

  // Alleen een lichte versie, geen gewoon logo: dan op een licht vlak de naam.
  const onlyDark = applyEmailBrand(`${EMAIL_LOGO_SLOT_SIGNATURE}${brandNameLine('<p>Studio Noord</p>')}`, brand({ logo: null, logoOnDark: emailLogoFromDataUrl(realPng) }));
  assert.equal(onlyDark.attachments.length, 0);
  assert.match(onlyDark.html, /<p>Studio Noord<\/p>/);
});

test('alleen het eerste merkteken telt; de alt-tekst is ge-escaped', () => {
  const html = `${EMAIL_LOGO_SLOT_DARK}<p>tekst</p>${EMAIL_LOGO_SLOT_DARK}`;
  const { html: out } = applyEmailBrand(html, brand({ name: 'R&D "Noord"' }));
  assert.equal(out.split('<img').length, 2);
  assert.match(out, /alt="R&amp;D &quot;Noord&quot;"/);
});

test('withEmailBrand: het logo achter de bijlagen die er al waren', () => {
  const payload = { from: 'a@x.test', html: renderEmailLayout({ brandName: 'Studio Noord', title: 'T', introHtml: '' }), attachments: [{ filename: 'factuur.pdf', content: 'JVBER' }] };
  const out = withEmailBrand(payload, brand());
  const files = (out.attachments as Array<{ filename: string; content_id?: string }>);
  assert.deepEqual(files.map((a) => a.filename), ['factuur.pdf', 'logo.png']);
  assert.equal(files[0].content_id, undefined, 'de PDF blijft een gewone bijlage');
  // Zonder logo: geen lege bijlagenlijst erbij (Resend), en de oude bijlagen onveranderd.
  const plain = withEmailBrand({ html: '<p>Hoi</p>' }, null);
  assert.equal('attachments' in plain, false);
  assert.equal(withEmailBrand(payload, null).attachments, payload.attachments);
  // Zonder HTML verandert er niets.
  const textOnly = { text: 'Hoi' };
  assert.equal(withEmailBrand(textOnly, brand()), textOnly);
});

test('elke route die mailt, neemt het logo mee', () => {
  // Wie een nieuwe verzendroute maakt, haalt de mail door withEmailBrand (of
  // applyEmailBrand). Uitzonderingen alleen met een reden.
  const exceptions: Record<string, string> = {
    '_shared/resend.ts': 'de kale verzendhelper; de aanroepers vullen het logo in',
    '_shared/emailQuota.ts': 'noemt Resend alleen in commentaar',
    'gerrie-agent-runner/index.ts': 'een rapport van ResoFly zelf aan de eigenaar van de agent, met de afzender van het platform',
  };
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
    if (exceptions[file]) return false;
    const source = readFileSync(new URL(file, root), 'utf8');
    const sends = source.includes('api.resend.com/emails') || /\bsendViaResend\(/.test(source);
    return sends && !/\b(withEmailBrand|applyEmailBrand)\(/.test(source);
  });
  assert.deepEqual(missing, [], 'Haal de Resend-payload door withEmailBrand (zie _shared/emailBrand.ts).');
});

/** Een nagebootste Supabase-client die bijhoudt welke tabellen, kolommen en filters er gevraagd worden. */
function fakeAdmin(rows: { company?: Record<string, unknown> | null; organization?: Record<string, unknown> | null; failColumn?: string }) {
  const calls: Array<{ table: string; columns: string; filters: Record<string, string> }> = [];
  const answer = (call: { table: string; columns: string }) => {
    if (call.table === 'company_settings') {
      if (rows.failColumn && call.columns.includes(rows.failColumn)) return { data: null, error: { message: `column ${rows.failColumn} does not exist` } };
      const picked = rows.company ? Object.fromEntries(Object.entries(rows.company).filter(([key]) => call.columns.split(',').includes(key))) : null;
      return { data: picked, error: null };
    }
    return { data: rows.organization ?? null, error: null };
  };
  return {
    calls,
    from(table: string) {
      const call = { table, columns: '', filters: {} as Record<string, string> };
      calls.push(call);
      const chain = {
        select(columns: string) { call.columns = columns; return chain; },
        eq(column: string, value: string) { call.filters[column] = value; return chain; },
        maybeSingle: () => Promise.resolve(answer(call)),
      };
      return chain;
    },
  };
}

test('afzender: naam, merkkleur en logo in één query, gefilterd op de organisatie', async () => {
  const admin = fakeAdmin({ company: { trade_name: 'Studio Noord', company_name: 'Noord B.V.', brand_accent_color: '#2457C5', brand_logo_data_url: pngDataUrl(600, 150) } });
  const sender = await loadSenderBrand(admin as never, 'org-1');
  assert.equal(sender.name, 'Studio Noord');
  assert.equal(sender.accent, '#2457C5');
  assert.equal(sender.email.name, 'Studio Noord');
  assert.ok(sender.email.logo);
  // Eerst stond hier een query voor de naam en een tweede voor het logo.
  assert.equal(admin.calls.length, 1);
  assert.deepEqual(admin.calls[0].filters, { organization_id: 'org-1' });
});

test('afzender: zonder handels- en bedrijfsnaam de werkruimte, anders ResoFly; rommel is geen merkkleur', async () => {
  const workspace = fakeAdmin({ company: { trade_name: '  ', company_name: '', brand_accent_color: 'url(x)' }, organization: { name: 'Lopik Foto' } });
  const sender = await loadSenderBrand(workspace as never, 'org-2');
  assert.equal(sender.name, 'Lopik Foto');
  assert.equal(sender.accent, null);
  assert.equal(sender.email.name, 'Lopik Foto', 'ook de alt-tekst van het logo');
  assert.deepEqual(workspace.calls.map(call => [call.table, call.filters]), [['company_settings', { organization_id: 'org-2' }], ['organizations', { id: 'org-2' }]]);
  assert.equal((await loadSenderBrand(fakeAdmin({}) as never, 'org-3')).name, 'ResoFly');
  // Alleen de naam (de afmeldpagina): de logo's worden dan niet opgehaald.
  const light = fakeAdmin({ company: { company_name: 'Noord B.V.' } });
  assert.equal(await loadSenderName(light as never, 'org-4'), 'Noord B.V.');
  assert.equal(light.calls[0].columns, 'company_name,trade_name');
});

test('afzender: bestaat de kolom van de lichte logoversie nog niet, dan zonder die kolom', async () => {
  const admin = fakeAdmin({ company: { trade_name: 'Studio Noord', brand_logo_data_url: pngDataUrl(600, 150) }, failColumn: 'brand_logo_dark_data_url' });
  const brand = await loadEmailBrand(admin as never, 'org-5');
  assert.equal(brand.name, 'Studio Noord');
  assert.ok(brand.logo);
  assert.equal(admin.calls.length, 2);
  assert.ok(!admin.calls[1].columns.includes('brand_logo_dark_data_url'));
});

test('naar een e-factuuradres gaat geen logo mee', () => {
  // Een boekhoudpakket op dat adres leest de bijlagen in, en niet elk pakket
  // slaat een ingesloten afbeelding over: dan kwam er bij elke factuur een
  // "logo.png" als document in de administratie van de klant.
  const source = readFileSync(new URL('../invoice-workflow/index.ts', import.meta.url), 'utf8');
  assert.match(source, /\}, eInvoicing \? null : await loadEmailBrand\(supabaseAdmin, organizationId\)\);/);
  assert.match(source, /\}, creditUbl \? null : await loadEmailBrand\(supabaseAdmin, input\.organizationId\)\);/);
});

test('de losse mails buiten de sjablonen hebben een plek voor het logo', () => {
  const root = new URL('../', import.meta.url);
  const read = (file: string) => readFileSync(new URL(file, root), 'utf8');
  const mail = read('mail/index.ts');
  // Testmail, welkomstmail en teamuitnodiging (donker), de vrije klantmail (handtekening).
  assert.equal(mail.split('${EMAIL_LOGO_SLOT_DARK}').length - 1, 3);
  assert.equal(mail.split('${EMAIL_LOGO_SLOT_SIGNATURE}').length - 1, 1);
  assert.match(read('meeting-transcribe/index.ts'), /\$\{EMAIL_LOGO_SLOT_LIGHT\}<h1/);
  assert.match(read('_shared/calendarEventWrite.ts'), /const html = `\$\{EMAIL_LOGO_SLOT_LIGHT\}/);
});
