/**
 * Een meeting uit de agenda in Inhoud: titel, datum en tekst van de notitie,
 * en wanneer de server hem vanzelf in Inhoud zet.
 * Draaien met:  npm test
 *
 * Gaat dit mis, dan vind je de meeting in de map Meetings niet terug op naam
 * en datum, komt tekst uit de opname als opmaak in de notitie, of zet de
 * server een meeting in Inhoud voor iemand die dat niet mag (of uit een
 * privé-agenda).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoSaveRefusal, dutchDate, meetingDay, meetingNoteContent, meetingNoteTitle, NOTULEN_VOLGEN, validDay, validTime,
} from './meetingNote.ts';

test('de titel: eerst de afspraak, dan de datum in gewone woorden', () => {
  assert.equal(meetingNoteTitle('Kennismaking Bakkerij Jansen', '2026-11-24'), 'Kennismaking Bakkerij Jansen — 24 november 2026');
  assert.equal(meetingNoteTitle('  Weekstart \n team ', '2026-03-02'), 'Weekstart team — 2 maart 2026');
  assert.equal(meetingNoteTitle(null, '2026-01-31'), 'Meeting — 31 januari 2026');
  assert.equal(meetingNoteTitle('   ', '2026-12-01'), 'Meeting — 1 december 2026');
});

test('een lange titel wordt ingekort, de datum blijft', () => {
  const title = meetingNoteTitle('x'.repeat(400), '2026-11-24');
  assert.ok(title.length <= 200, String(title.length));
  assert.ok(title.endsWith('… — 24 november 2026'), title);
});

test('de dag: die van de afspraak als die klopt, anders de opnamedag op Nederlandse tijd', () => {
  assert.equal(meetingDay('2026-11-20', '2026-11-24T10:00:00Z'), '2026-11-20');
  // Kwart over elf 's avonds UTC is in Nederland al de volgende dag.
  assert.equal(meetingDay(undefined, '2026-11-24T23:15:00Z'), '2026-11-25');
  assert.equal(meetingDay('2026-02-30', '2026-11-24T10:00:00Z'), '2026-11-24');
  assert.equal(meetingDay('24-11-2026', '2026-11-24T10:00:00Z'), '2026-11-24');
  assert.equal(meetingDay(20261124, '2026-07-01T22:30:00Z'), '2026-07-02');
  assert.equal(dutchDate('2026-08-09'), '9 augustus 2026');
});

test('de notulen: samenvatting en lijsten, zonder kopje; een leeg onderdeel blijft weg', () => {
  const html = meetingNoteContent({
    samenvatting: 'We spraken over de livegang.',
    besproken: ['Planning', ' '],
    besluiten: [],
    actiepunten: ['Jan stuurt de offerte'],
    vervolgafspraken: null,
  });
  assert.equal(html,
    '<p>We spraken over de livegang.</p>'
    + '<h4>Besproken</h4><ul><li>Planning</li></ul>'
    + '<h4>Actiepunten</h4><ul><li>Jan stuurt de offerte</li></ul>');
});

test('tekst uit de opname is gegevens: HTML erin wordt tekst', () => {
  const html = meetingNoteContent({ samenvatting: '<img src=x onerror=alert(1)>', besproken: ['<script>x</script> & "meer"'] });
  assert.ok(!/<img|<script/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt; &amp; &quot;meer&quot;'));
});

test('zonder notulen: de losse tekst als die er is, anders "notulen volgen"', () => {
  assert.equal(meetingNoteContent(null, 'Eerste regel\nTweede\n\nNieuwe alinea'), '<p>Eerste regel<br>Tweede</p><p>Nieuwe alinea</p>');
  assert.equal(meetingNoteContent(null, null), NOTULEN_VOLGEN);
  assert.equal(meetingNoteContent({ samenvatting: ' ', besproken: [] }), NOTULEN_VOLGEN);
});

test('de dag en de tijd uit de aanvraag: alleen wat echt een dag of tijdstip is', () => {
  assert.equal(validDay('2026-11-24'), '2026-11-24');
  assert.equal(validDay('2028-02-29'), '2028-02-29');
  assert.equal(validDay('2026-02-29'), null);
  assert.equal(validDay('2026-11-24T10:00:00Z'), null);
  assert.equal(validDay(''), null);
  assert.equal(validDay(null), null);
  assert.equal(validTime('2026-11-24T09:30:00+01:00'), '2026-11-24T08:30:00.000Z');
  assert.equal(validTime('2026-11-24'), '2026-11-24T00:00:00.000Z');
  assert.equal(validTime('morgen'), null);
  assert.equal(validTime('  '), null);
  assert.equal(validTime(1764000000000), null);
});

/** Een meeting bij een gedeelde afspraak, opgenomen door een medewerker met alle rechten. */
const vanzelf = {
  saveToContent: true, callId: null, noteId: null, createdBy: 'maker',
  member: { role: 'member', module_access: {} }, sourceVisibility: 'organization',
};

test('vanzelf in Inhoud: bij een gedeelde afspraak, voor wie Agenda én Inhoud mag wijzigen', () => {
  assert.equal(autoSaveRefusal(vanzelf), null);
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'owner', module_access: { content: 'none' } } }), null);
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'admin', module_access: null } }), null);
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'member', module_access: { calendar: 'write', content: 'write' } } }), null);
});

test('niet vanzelf: als het niet gevraagd is, of bij een gesprek of notitie', () => {
  assert.equal(autoSaveRefusal({ ...vanzelf, saveToContent: false }), 'not_requested');
  assert.equal(autoSaveRefusal({ ...vanzelf, callId: 'gesprek' }), 'not_requested');
  assert.equal(autoSaveRefusal({ ...vanzelf, noteId: 'notitie' }), 'not_requested');
});

test('niet vanzelf: de maker is geen lid meer of mag het niet (meer)', () => {
  assert.equal(autoSaveRefusal({ ...vanzelf, createdBy: null }), 'no_creator');
  assert.equal(autoSaveRefusal({ ...vanzelf, member: null }), 'no_creator');
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'viewer', module_access: {} } }), 'no_rights');
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'accountant', module_access: {} } }), 'no_rights');
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'member', module_access: { content: 'read' } } }), 'no_rights');
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'member', module_access: { content: 'none' } } }), 'no_rights');
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'member', module_access: { calendar: 'read' } } }), 'no_rights');
  // Een rol die de code niet kent, krijgt niets.
  assert.equal(autoSaveRefusal({ ...vanzelf, member: { role: 'superuser', module_access: {} } }), 'no_rights');
});

test('niet vanzelf: uit een privé-agenda, of als de agenda onbekend is', () => {
  assert.equal(autoSaveRefusal({ ...vanzelf, sourceVisibility: 'private' }), 'private_calendar');
  assert.equal(autoSaveRefusal({ ...vanzelf, sourceVisibility: null }), 'private_calendar');
});
