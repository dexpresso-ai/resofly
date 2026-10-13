import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TRANSFER_BLOCKED_EXTENSIONS,
  TRANSFER_MAX_FILE_BYTES,
  blockedExtension,
  cleanFileName,
  codeHash,
  fileCountSentence,
  formatBytesNl,
  generateCode,
  isPlausibleToken,
  maskEmail,
  normalizeCode,
  parseTransferExpiry,
  parseTransferRecipients,
  randomToken,
  transferZipName,
  zipPath,
} from './fileTransfer.ts';
import {
  FILE_TRANSFER_DEFAULTS,
  renderFileTransferCodeEmail,
  renderFileTransferEmail,
  renderTransferBlockHtml,
} from './emailTemplates/fileTransfer.ts';

/**
 * Bestanden versturen: de regels die vóór de database gelden, en de mails.
 * De echte grens (welke klant, welke ontvanger) bewaakt de database; zie
 * 20261013100000_file_transfers.sql.
 */

test('programma’s en scripts gaan niet mee, ook niet met een tweede extensie', () => {
  assert.equal(blockedExtension('setup.exe'), 'exe');
  assert.equal(blockedExtension('Factuur.PDF.EXE'), 'exe');
  assert.equal(blockedExtension('script.ps1  '), 'ps1');
  assert.equal(blockedExtension('snelkoppeling.lnk.'), 'lnk');
  assert.equal(blockedExtension('schijf.iso'), 'iso');
  assert.equal(blockedExtension('Rapport.pdf'), null);
  assert.equal(blockedExtension('archief.zip'), null);
  assert.equal(blockedExtension('geenextensie'), null);
  assert.equal(blockedExtension('.bashrc'), null, 'een verborgen bestand zonder extensie');
  assert.equal(blockedExtension(''), null);
});

test('een bestandsnaam: geen pad, geen stuurtekens, nooit leeg', () => {
  assert.equal(cleanFileName('C:\\Users\\jan\\offerte.pdf'), 'offerte.pdf');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('a\u0000b\u001fc.txt'), 'abc.txt');
  assert.equal(cleanFileName('   '), 'bestand');
  assert.equal(cleanFileName(null, 'leeg'), 'leeg');
  assert.equal(cleanFileName('x'.repeat(400)).length, 300);
  assert.equal(cleanFileName('Ontwerp   v2  .pdf'), 'Ontwerp v2 .pdf');
});

test('vervaldatum: standaard 30 dagen, een termijn of een datum, nooit in het verleden of verder dan een jaar', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  const day = 86_400_000;
  const standard = parseTransferExpiry(undefined, now);
  assert.ok(standard.ok && Date.parse(standard.iso) === now.getTime() + 30 * day);
  const week = parseTransferExpiry('7', now);
  assert.ok(week.ok && Date.parse(week.iso) === now.getTime() + 7 * day);
  assert.ok(parseTransferExpiry(365, now).ok);
  assert.equal(parseTransferExpiry(0, now).ok, false);
  assert.equal(parseTransferExpiry(366, now).ok, false);
  assert.equal(parseTransferExpiry('2026-10-01', now).ok, false, 'verleden');
  assert.equal(parseTransferExpiry('2028-01-01', now).ok, false, 'te ver');
  assert.equal(parseTransferExpiry('morgen', now).ok, false);

  // Een kale datum = het einde van die dag in Nederland (wintertijd: +01:00).
  const winter = parseTransferExpiry('2026-11-12', now);
  assert.ok(winter.ok);
  assert.equal(winter.ok && winter.iso, '2026-11-12T22:59:59.000Z');
  // Zomertijd (+02:00).
  const summer = parseTransferExpiry('2027-06-01', new Date('2027-05-01T10:00:00Z'));
  assert.equal(summer.ok && summer.iso, '2027-06-01T21:59:59.000Z');
  // Een niet-bestaande dag.
  assert.equal(parseTransferExpiry('2026-02-30', now).ok, false);
});

test('tokens en codes', async () => {
  const token = randomToken();
  assert.equal(token.length, 43);
  assert.ok(isPlausibleToken(token));
  assert.ok(!isPlausibleToken('kort'));
  assert.ok(!isPlausibleToken('a'.repeat(30) + '!'));
  assert.ok(!isPlausibleToken(42));

  for (let i = 0; i < 200; i += 1) assert.match(generateCode(), /^\d{6}$/);
  assert.equal(normalizeCode('123 456'), '123456');
  assert.equal(normalizeCode('123-456'), '123456');
  assert.equal(normalizeCode('12345'), null);
  assert.equal(normalizeCode('12345a'), null);

  const a = await codeHash('11111111-1111-4111-8111-111111111111', '123456');
  const b = await codeHash('22222222-2222-4222-8222-222222222222', '123456');
  assert.equal(a, await codeHash('11111111-1111-4111-8111-111111111111', '123456'));
  assert.notEqual(a, b, 'dezelfde code bij een andere ontvanger is een andere hash');
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('een adres maskeren', () => {
  assert.equal(maskEmail('joost@bakker.nl'), 'j•••@bakker.nl');
  assert.equal(maskEmail('a@b.nl'), 'a•••@b.nl');
  assert.equal(maskEmail('kapot'), '•••');
});

test('ontvangers: klantbestanden alleen naar de klant of een contactpersoon', () => {
  const contact = '33333333-3333-4333-8333-333333333333';
  const forClient = parseTransferRecipients([{ kind: 'client' }, { kind: 'contact', clientContactId: contact }, { kind: 'client' }], true);
  assert.ok(forClient.ok);
  assert.deepEqual(forClient.ok && forClient.recipients, [{ kind: 'client' }, { kind: 'contact', clientContactId: contact }]);

  const looseForClient = parseTransferRecipients([{ kind: 'email', email: 'iemand@elders.nl' }], true);
  assert.equal(looseForClient.ok, false);
  assert.match(!looseForClient.ok ? looseForClient.error : '', /contactpersoon/);

  const noClient = parseTransferRecipients([{ kind: 'email', email: 'A@Elders.NL ', name: ' Ann ' }, { kind: 'email', email: 'a@elders.nl' }], false);
  assert.ok(noClient.ok);
  assert.deepEqual(noClient.ok && noClient.recipients, [{ kind: 'email', email: 'a@elders.nl', name: 'Ann' }]);

  assert.equal(parseTransferRecipients([{ kind: 'client' }], false).ok, false);
  assert.equal(parseTransferRecipients([{ kind: 'contact', clientContactId: 'nope' }], true).ok, false);
  assert.equal(parseTransferRecipients([], true).ok, false);
  assert.equal(parseTransferRecipients([{ kind: 'hack' }], true).ok, false);
  const many = Array.from({ length: 26 }, (_, i) => ({ kind: 'email', email: `p${i}@x.nl` }));
  assert.equal(parseTransferRecipients(many, false).ok, false);
});

test('teksten en namen', () => {
  assert.equal(fileCountSentence(1), '1 bestand');
  assert.equal(fileCountSentence(3), '3 bestanden');
  assert.equal(formatBytesNl(0), '0 B');
  assert.equal(formatBytesNl(1536), '1,5 KB');
  assert.equal(formatBytesNl(12.4 * 1024 * 1024), '12 MB');
  assert.equal(formatBytesNl(TRANSFER_MAX_FILE_BYTES), '1,0 GB');
  assert.equal(transferZipName('Drukproef: v2 / definitief?'), 'Drukproef v2 definitief.zip');
  assert.equal(transferZipName('   '), 'bestanden.zip');
  assert.equal(zipPath('Ontwerpen / Definitief', 'logo.svg'), 'Ontwerpen/Definitief/logo.svg');
  assert.equal(zipPath('', 'a/b.pdf'), 'a_b.pdf');
  assert.equal(zipPath('../x', '..hidden'), '_x/hidden', 'geen ".." in een zip-pad');
  // Mapnamen hoeven alleen niet leeg te zijn; geen enkele combinatie mag een uitpakker buiten de map sturen.
  for (const path of ['.. .. / .. .. / .. ..', ' .. / ..', '. / .. / ...', ' ..  /  .. ', '..\\..']) {
    const result = zipPath(path, ' .. ');
    assert.ok(!result.split('/').some((part) => part === '..' || part === '.' || part === ''), `${JSON.stringify(path)} → ${result}`);
    assert.ok(!result.startsWith('/') && !result.includes('\\'), result);
  }
  assert.equal(zipPath(' .. ', ' ..evil.txt'), 'evil.txt');
});

// ── De mails ────────────────────────────────────────────────────────────────

const base = {
  subject: 'Drukproef najaarsfolder',
  url: 'https://app.resofly.nl/ontvang/abc',
  recipientName: 'Joost',
  senderName: 'Gerjan',
  fileCount: 3,
  totalBytes: 13_000_000,
  expiresAt: '2026-11-12T22:59:59.000Z',
  company: { trade_name: 'Studio Lopik', invoice_accent_color: '#00AAFF' },
};

test('de melding noemt aantal en termijn, maar nooit bestandsnamen', () => {
  const mail = renderFileTransferEmail({ ...base, personalMessage: 'Graag <b>vóór</b> vrijdag akkoord' });
  assert.equal(mail.subject, 'Drukproef najaarsfolder');
  assert.match(mail.html, /3 bestanden/);
  assert.match(mail.html, /12 november 2026/);
  assert.match(mail.html, /Bestanden bekijken/);
  assert.ok(!mail.html.includes('<b>vóór</b>'), 'het bericht wordt ge-escaped');
  assert.match(mail.html, /&lt;b&gt;vóór&lt;\/b&gt;/);
  assert.match(mail.text, /persoonlijk/);
  assert.match(mail.html, /code die we naar dit e-mailadres sturen/);
});

test('eigen teksten van de organisatie, met plaatshouders', () => {
  const mail = renderFileTransferEmail({
    ...base,
    content: { enabled: true, subject: '{{company_name}}: {{file_count_sentence}} voor {{recipient_name}}', intro: 'Hoi {{recipient_name}}', ctaLabel: 'Openen' },
  });
  assert.equal(mail.subject, 'Studio Lopik: 3 bestanden voor Joost');
  assert.match(mail.html, /Hoi Joost/);
  assert.match(mail.html, />Openen</);
  // Uitgezet = de standaardtekst.
  const off = renderFileTransferEmail({ ...base, content: { enabled: false, subject: 'X' } });
  assert.equal(off.subject, base.subject);
  assert.equal(FILE_TRANSFER_DEFAULTS.subject, '{{transfer_subject}}');
});

test('de codemail: code in de tekst, nooit in het onderwerp', () => {
  const mail = renderFileTransferCodeEmail({ code: '482913', companyName: 'Studio Lopik' });
  assert.ok(!mail.subject.includes('482913'));
  assert.match(mail.html, /482 913/);
  assert.match(mail.text, /482 913/);
  assert.match(mail.text, /10 minuten/);
});

test('het blok in een mail uit het mailvenster', () => {
  const html = renderTransferBlockHtml({ url: 'https://x.nl/ontvang/a"b', fileCount: 1, totalBytes: 2048, expiresAt: base.expiresAt });
  assert.match(html, /1 bestand · 2,0 KB · beschikbaar tot 12 november 2026/);
  assert.ok(!html.includes('a"b'), 'de link wordt ge-escaped');
});

// ── De kopieën in de media-worker en de frontend lopen gelijk ───────────────

function arrayLiteral(source: string, name: string): string[] {
  const start = source.indexOf(name);
  assert.ok(start >= 0, `${name} niet gevonden`);
  const open = source.indexOf('[', start);
  const close = source.indexOf(']', open);
  return [...source.slice(open, close).matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
}

test('het zip-pad volgt in de worker precies dezelfde regel als hier', () => {
  const chain = (source: string, from: string) => {
    const at = source.indexOf(from);
    assert.ok(at >= 0, `niet gevonden: ${from}`);
    const start = source.indexOf('.replace(/[', at);
    const end = source.indexOf('.slice(0, 200)', start);
    assert.ok(start > at && end > start, 'de schoonmaakketen is niet gevonden');
    return source.slice(start, end).replace(/\s+/g, '');
  };
  const worker = readFileSync(new URL('../../../workers/media-api/src/index.ts', import.meta.url), 'utf8');
  const shared = readFileSync(new URL('./fileTransfer.ts', import.meta.url), 'utf8');
  assert.equal(chain(worker, 'function transferZipPath('), chain(shared, 'function cleanZipSegment('));
});

test('de lijst met geblokkeerde extensies is overal dezelfde', () => {
  const worker = readFileSync(new URL('../../../workers/media-api/src/index.ts', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('../../../src/lib/transfers.ts', import.meta.url), 'utf8');
  assert.deepEqual(arrayLiteral(worker, 'TRANSFER_BLOCKED_EXTENSIONS'), [...TRANSFER_BLOCKED_EXTENSIONS]);
  assert.deepEqual(arrayLiteral(frontend, 'TRANSFER_BLOCKED_EXTENSIONS'), [...TRANSFER_BLOCKED_EXTENSIONS]);
});

test('de grens van 1 GB is overal dezelfde', () => {
  const worker = readFileSync(new URL('../../../workers/media-api/src/index.ts', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('../../../src/lib/transfers.ts', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../../migrations/20261013100000_file_transfers.sql', import.meta.url), 'utf8');
  assert.match(worker, /const TRANSFER_MAX_FILE_BYTES = 1024 \* 1024 \* 1024;/);
  assert.match(frontend, /export const TRANSFER_MAX_FILE_BYTES = 1024 \* 1024 \* 1024;/);
  assert.match(migration, /size_bytes <= 1073741824/);
  assert.equal(TRANSFER_MAX_FILE_BYTES, 1073741824);
});
