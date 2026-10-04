import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToPlainText,
  isPortalEligibleMessage,
  isUnreadSince,
  portalThreadsFor,
  previewText,
  replySubject,
  type PortalMessageRow,
} from './portalMessages.ts';

/**
 * Een klantdossier bevat meer dan het gesprek met de klant: nieuwsbrieven,
 * automatische stromen, post van derden en doorgestuurde mail met een notitie
 * van het team. En op één portaal loggen soms meer mensen van de klant in. In
 * het portaal ziet ieder alleen het eigen gesprek.
 */

const JOOST = 'joost@dekorenaar.nl'; // hoofdadres van de klant: het team mailt altijd hierheen
const ANJA = 'anja@dekorenaar.nl'; // contactpersoon met portaaltoegang (bv. de boekhouding)
const people = new Set([JOOST, ANJA]);

let seq = 0;
function row(partial: Partial<PortalMessageRow>): PortalMessageRow {
  seq += 1;
  const at = new Date(Date.UTC(2026, 9, 1, 9, seq)).toISOString();
  return {
    id: `m${seq}`,
    thread_id: 't1',
    subject: 'Offerte website',
    direction: 'outbound',
    status: 'delivered',
    from_email: 'gerjan@studiolopik.nl',
    from_name: 'Gerjan',
    to_email: JOOST,
    source: '',
    sender_source: null,
    preview: 'Hoi Joost, hierbij…',
    occurred_at: at,
    created_at: at,
    ...partial,
  };
}

const inbound = (from: string, partial: Partial<PortalMessageRow> = {}) =>
  row({ direction: 'inbound', from_email: from, to_email: 'info@studiolopik.nl', sender_source: 'header_from', ...partial });

test('in aanmerking: mail van het team aan een portaalgebruiker, en wat die zelf stuurde', () => {
  assert.equal(isPortalEligibleMessage(row({}), people), true);
  assert.equal(isPortalEligibleMessage(row({ to_email: ' Anja@DeKorenaar.nl ' }), people), true);
  assert.equal(isPortalEligibleMessage(inbound(JOOST), people), true);
  assert.equal(isPortalEligibleMessage(inbound(JOOST, { sender_source: null }), people), true, 'portaalbericht of oudere mail');
});

test('nooit: post van een derde, mail aan iemand anders, niet verstuurd, marketing of doorgestuurd', () => {
  assert.equal(isPortalEligibleMessage(inbound('accountant@elders.nl'), people), false, 'handmatig gekoppelde post van een derde');
  assert.equal(isPortalEligibleMessage(row({ to_email: 'oud-adres@dekorenaar.nl' }), people), false);
  assert.equal(isPortalEligibleMessage(row({ status: 'failed' }), people), false);
  assert.equal(isPortalEligibleMessage(row({ status: 'queued' }), people), false);
  assert.equal(isPortalEligibleMessage(row({ source: 'campaign' }), people), false);
  assert.equal(isPortalEligibleMessage(row({ source: 'flow' }), people), false);
  // Een teamlid stuurt de mail van Joost door naar het doorstuuradres, met
  // "deze klant betaalt altijd te laat" erboven. Afzender: Joost; tekst: het teamlid.
  for (const source of ['rfc822_attachment', 'forward_block', 'reply_to', 'envelope']) {
    assert.equal(isPortalEligibleMessage(inbound(JOOST, { sender_source: source }), people), false, source);
  }
});

test('ieder ziet het eigen gesprek: niet dat van een collega, en niets van vóór het meedoen', () => {
  const rows = [
    // A: Joost en het team, sinds lang. Anja doet niet mee.
    row({ id: 'a1', thread_id: 'A', subject: 'Offerte website' }),
    inbound(JOOST, { id: 'a2', thread_id: 'A', subject: 'Re: Offerte website', from_name: 'Joost', preview: 'Akkoord,   wanneer\n starten we?' }),
    // B: eerst mailt het team Joost; later stelt Anja in hetzelfde gesprek een
    // vraag en antwoordt het team (naar het hoofdadres, zoals altijd).
    row({ id: 'b1', thread_id: 'B', subject: 'Factuur 2026-014' }),
    inbound(ANJA, { id: 'b2', thread_id: 'B', subject: 'Re: Factuur 2026-014', from_name: 'Anja' }),
    row({ id: 'b3', thread_id: 'B', subject: 'Re: Factuur 2026-014', preview: 'Hoi Anja, de betaallink…' }),
    inbound(JOOST, { id: 'b4', thread_id: 'B', subject: 'Re: Factuur 2026-014' }),
  ];

  const joost = portalThreadsFor(rows, JOOST, people);
  assert.deepEqual(joost.map((t) => t.id), ['B', 'A']);
  assert.deepEqual(joost[0].messageIds, ['b1', 'b3', 'b4'], 'niet het bericht van Anja');
  assert.deepEqual(joost[1].messageIds, ['a1', 'a2']);
  assert.equal(joost[1].lastDirection, 'inbound');
  assert.equal(joost[1].lastPreview, 'Akkoord, wanneer starten we?');
  assert.equal(joost[1].lastTeamMessageAt, rows[0].occurred_at);

  const anja = portalThreadsFor(rows, ANJA, people);
  assert.deepEqual(anja.map((t) => t.id), ['B'], 'het gesprek van Joost en het team bestaat voor Anja niet');
  assert.deepEqual(anja[0].messageIds, ['b2', 'b3'], 'eigen vraag + het antwoord; niet de mail van vóór de vraag, niet die van Joost');
  assert.equal(anja[0].subject, 'Re: Factuur 2026-014', 'onderwerp van het eerste bericht dat Anja ziet');
  assert.equal(anja[0].lastTeamMessageAt, rows[4].occurred_at);
});

test('onderwerp komt nooit uit een bericht dat de klant niet ziet', () => {
  const rows = [
    inbound('incasso@elders.nl', { id: 'x1', thread_id: 'X', subject: 'Incasso De Korenaar' }),
    inbound(JOOST, { id: 'x2', thread_id: 'X', subject: 'Vraag over de planning' }),
  ];
  const [thread] = portalThreadsFor(rows, JOOST, people);
  assert.equal(thread.subject, 'Vraag over de planning');
  assert.deepEqual(thread.messageIds, ['x2']);
});

test('campagnegesprekken en doorgestuurde mail helemaal niet; geen portaalgebruiker = niets', () => {
  const rows = [
    // Nieuwsbrief met een antwoord van de klant: het hele gesprek blijft weg.
    row({ id: 'c1', thread_id: 'C', source: 'campaign', subject: 'Nieuwsbrief' }),
    inbound(JOOST, { id: 'c2', thread_id: 'C' }),
    // Alleen een doorgestuurde mail met een notitie van het team erin.
    inbound(JOOST, { id: 'f1', thread_id: 'F', sender_source: 'rfc822_attachment', preview: 'deze klant betaalt altijd te laat' }),
  ];
  assert.deepEqual(portalThreadsFor(rows, JOOST, people), []);
  assert.deepEqual(portalThreadsFor([row({})], 'iemand@elders.nl', people), []);
});

test('onderwerp van een antwoord: één keer "Re:"', () => {
  assert.equal(replySubject('Offerte website'), 'Re: Offerte website');
  assert.equal(replySubject('RE: Re: Antw: Offerte website'), 'Re: Offerte website');
  assert.equal(replySubject(''), 'Re: (geen onderwerp)');
});

test('nieuw sinds het laatst geopend; zonder leesmoment alleen na de invoering', () => {
  const since = '2026-10-04T00:00:00Z';
  assert.equal(isUnreadSince('2026-10-05T10:00:00Z', '2026-10-05T09:00:00Z', since), true);
  assert.equal(isUnreadSince('2026-10-05T10:00:00Z', '2026-10-05T11:00:00Z', since), false);
  assert.equal(isUnreadSince('2026-10-05T10:00:00Z', null, since), true);
  assert.equal(isUnreadSince('2026-09-20T10:00:00Z', null, since), false, 'van vóór de invoering weten we het niet');
  assert.equal(isUnreadSince(null, null, since), false);
});

test('preview en html naar tekst', () => {
  assert.equal(previewText('  een\n\ntwee  '), 'een twee');
  assert.equal(previewText('x'.repeat(300)).length, 160);
  assert.equal(
    htmlToPlainText('<p>Hoi&nbsp;Joost,</p><p>Zie <b>bijlage</b> &amp; reageer.<br>Groet</p><script>alert(1)</script>'),
    'Hoi Joost,\nZie bijlage & reageer.\nGroet',
  );
});
