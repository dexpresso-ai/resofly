import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  htmlToPlainText,
  isPortalVisibleMessage,
  isUnreadSince,
  portalThreads,
  previewText,
  replySubject,
  type PortalMessageRow,
} from './portalMessages.ts';

/**
 * Een klantdossier bevat meer dan het gesprek met de klant: nieuwsbrieven,
 * automatische stromen en post van derden die het team aan het dossier
 * koppelde. In het portaal ziet de klant alleen het eigen gesprek.
 */

const people = new Set(['joost@dekorenaar.nl', 'anja@dekorenaar.nl']);

let seq = 0;
function row(partial: Partial<PortalMessageRow>): PortalMessageRow {
  seq += 1;
  const at = new Date(Date.UTC(2026, 9, 1, 9, seq)).toISOString();
  return {
    id: `m${seq}`,
    thread_id: 't1',
    thread_subject: 'Offerte website',
    direction: 'outbound',
    status: 'delivered',
    from_email: 'gerjan@studiolopik.nl',
    from_name: 'Gerjan',
    to_email: 'joost@dekorenaar.nl',
    source: '',
    preview: 'Hoi Joost, hierbij…',
    occurred_at: at,
    created_at: at,
    ...partial,
  };
}

test('zichtbaar: mail van het team aan een portaalgebruiker, en wat die zelf stuurde', () => {
  assert.equal(isPortalVisibleMessage(row({}), people), true);
  assert.equal(isPortalVisibleMessage(row({ to_email: ' Anja@DeKorenaar.nl ' }), people), true);
  assert.equal(isPortalVisibleMessage(row({ direction: 'inbound', from_email: 'joost@dekorenaar.nl', to_email: 'info@studiolopik.nl' }), people), true);
});

test('onzichtbaar: post van een derde, mail aan iemand anders, niet verstuurd, of marketing', () => {
  assert.equal(isPortalVisibleMessage(row({ direction: 'inbound', from_email: 'accountant@elders.nl' }), people), false, 'handmatig gekoppelde post van een derde');
  assert.equal(isPortalVisibleMessage(row({ to_email: 'oud-adres@dekorenaar.nl' }), people), false);
  assert.equal(isPortalVisibleMessage(row({ status: 'failed' }), people), false);
  assert.equal(isPortalVisibleMessage(row({ status: 'queued' }), people), false);
  assert.equal(isPortalVisibleMessage(row({ source: 'campaign' }), people), false);
  assert.equal(isPortalVisibleMessage(row({ source: 'flow' }), people), false);
});

test('gesprekken: alleen zichtbare berichten, campagnegesprekken helemaal niet, nieuwste bovenaan', () => {
  const rows = [
    row({ id: 'a1', thread_id: 'A', thread_subject: 'Offerte website' }),
    row({ id: 'a2', thread_id: 'A', direction: 'inbound', from_email: 'joost@dekorenaar.nl', from_name: 'Joost', preview: 'Akkoord,   wanneer\n starten we?' }),
    row({ id: 'a3', thread_id: 'A', direction: 'inbound', from_email: 'derde@elders.nl' }),
    // Nieuwsbrief met een antwoord van de klant: het hele gesprek blijft weg.
    row({ id: 'c1', thread_id: 'C', source: 'campaign', thread_subject: 'Nieuwsbrief' }),
    row({ id: 'c2', thread_id: 'C', direction: 'inbound', from_email: 'joost@dekorenaar.nl' }),
    // Alleen post van een derde: het gesprek bestaat voor de klant niet.
    row({ id: 'd1', thread_id: 'D', direction: 'inbound', from_email: 'derde@elders.nl' }),
    row({ id: 'b1', thread_id: 'B', thread_subject: 'Planning', to_email: 'anja@dekorenaar.nl' }),
  ];
  const threads = portalThreads(rows, people);
  assert.deepEqual(threads.map((t) => t.id), ['B', 'A']);
  const a = threads[1];
  assert.deepEqual(a.messageIds, ['a1', 'a2']);
  assert.equal(a.messageCount, 2);
  assert.equal(a.lastDirection, 'inbound');
  assert.equal(a.lastPreview, 'Akkoord, wanneer starten we?');
  assert.equal(a.lastTeamMessageAt, rows[0].occurred_at);
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
