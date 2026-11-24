/**
 * Een meeting uit de agenda in Inhoud: titel, datum en tekst van de notitie.
 * Draaien met:  npm test
 *
 * Gaat dit mis, dan vind je de meeting in de map Meetings niet terug op naam
 * en datum, of komt tekst uit de opname als opmaak in de notitie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dutchDate, meetingDay, meetingNoteContent, meetingNoteTitle, NOTULEN_VOLGEN } from './meetingNote.ts';

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
