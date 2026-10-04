import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTicketUnread,
  parsePortalLink,
  portalConversations,
  revalidatePortalLink,
  seenKey,
  splitQuotedReply,
  ticketPreview,
  threadPreview,
} from './portalConversations.ts';
import type { PortalMessageThreadSummary, PortalTicket } from './portalApi';

/**
 * Het portaal: één lijst met mailgesprekken en tickets, deeplinks uit de
 * meldingsmail, en antwoorden zonder de hele geciteerde geschiedenis eronder.
 */

const DOSSIER = '6a1f8c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const TICKET = '7b2f8c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const THREAD = '8c3f8c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';

function ticket(partial: Partial<PortalTicket>): PortalTicket {
  return {
    id: TICKET, title: 'Website laadt traag', description: 'Vooral de homepage.', status: 'review', priority: 'med',
    created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:00:00Z', ...partial,
  };
}

function thread(partial: Partial<PortalMessageThreadSummary>): PortalMessageThreadSummary {
  return {
    id: THREAD, subject: 'Offerte website', messageCount: 2, lastMessageAt: '2026-10-02T09:00:00Z',
    lastFrom: 'team', lastFromName: 'Gerjan van Lopik', lastPreview: 'Hierbij de offerte.', unread: false, ...partial,
  };
}

test('gesprekken: mail en tickets door elkaar, laatste activiteit bovenaan', () => {
  const list = portalConversations(
    [ticket({ last_activity_at: '2026-10-03T12:00:00Z', last_reply_from: 'team', last_reply_preview: 'We kijken ernaar.', unread: true })],
    [thread({})],
    'Studio Lopik',
  );
  assert.deepEqual(list.map((c) => c.kind), ['ticket', 'thread']);
  assert.equal(list[0].preview, 'Studio Lopik: We kijken ernaar.');
  assert.equal(list[0].unread, true);
  assert.equal(list[1].preview, 'Gerjan van Lopik: Hierbij de offerte.');
});

test('net geopend telt als gelezen, ook vóór het opnieuw laden', () => {
  const t = ticket({ unread: true });
  assert.equal(isTicketUnread(t, new Set()), true);
  assert.equal(isTicketUnread(t, new Set([seenKey('ticket', TICKET)])), false);
  const list = portalConversations([], [thread({ unread: true })], 'Studio Lopik', new Set([seenKey('thread', THREAD)]));
  assert.equal(list[0].unread, false);
});

test('preview: wie schreef het laatst', () => {
  assert.equal(threadPreview({ lastFrom: 'me', lastFromName: 'Joost', lastPreview: 'Akkoord!' }, 'Studio Lopik'), 'Jij: Akkoord!');
  assert.equal(threadPreview({ lastFrom: 'colleague', lastFromName: 'Anja', lastPreview: 'Klopt.' }, 'Studio Lopik'), 'Anja: Klopt.');
  assert.equal(threadPreview({ lastFrom: 'team', lastFromName: null, lastPreview: 'Graag gedaan.' }, 'Studio Lopik'), 'Studio Lopik: Graag gedaan.');
  assert.equal(ticketPreview({ description: '  Vooral\n de homepage. ', last_reply_preview: null }, 'Studio Lopik'), 'Vooral de homepage.');
  assert.equal(ticketPreview({ description: null }, 'Studio Lopik'), 'Nog geen reacties');
  assert.equal(ticketPreview({ last_reply_from: 'client', last_reply_author: 'Anja', last_reply_preview: 'Nog steeds traag' }, 'Studio Lopik'), 'Anja: Nog steeds traag');
});

test('deeplink uit de mail: dossier, ticket, gesprek, instellingen', () => {
  assert.deepEqual(parsePortalLink(`?dossier=${DOSSIER}&ticket=${TICKET}`), { dossier: DOSSIER, ticket: TICKET, thread: null, view: null });
  assert.deepEqual(parsePortalLink(`?dossier=${DOSSIER}&view=instellingen`), { dossier: DOSSIER, ticket: null, thread: null, view: 'settings' });
  assert.deepEqual(parsePortalLink(`?bericht=${THREAD.toUpperCase()}`), { dossier: null, ticket: null, thread: THREAD, view: null });
  assert.equal(parsePortalLink(''), null);
  assert.equal(parsePortalLink('?ticket=1;drop table&view=toString'), null, 'alleen geldige ids en bekende weergaven');
  // Een magische inloglink (#access_token…) heeft geen zoekparameters: geen deeplink.
  assert.equal(parsePortalLink('?type=magiclink'), null);
});

test('bewaarde link (van vóór het inloggen) gaat opnieuw door de zeef', () => {
  const link = parsePortalLink(`?dossier=${DOSSIER}&ticket=${TICKET}&view=berichten`);
  assert.deepEqual(revalidatePortalLink(link), link);
  assert.equal(revalidatePortalLink({ dossier: 'javascript:alert(1)', view: 'admin' }), null);
  assert.equal(revalidatePortalLink('kapot'), null);
});

test('citaat onder een antwoord: Gmail, Outlook en >-regels', () => {
  const gmail = 'Prima, doen we!\n\nGroet, Joost\n\nOp za 3 okt 2026 om 10:00 schreef Gerjan van Lopik <gerjan@studiolopik.nl>:\n> Zullen we donderdag starten?\n';
  assert.deepEqual(splitQuotedReply(gmail), {
    main: 'Prima, doen we!\n\nGroet, Joost',
    quoted: 'Op za 3 okt 2026 om 10:00 schreef Gerjan van Lopik <gerjan@studiolopik.nl>:\n> Zullen we donderdag starten?',
  });

  const wrapped = 'Akkoord.\n\nOp za 3 okt 2026 om 10:00 schreef Gerjan van Lopik <\ngerjan@studiolopik.nl>:\n> Vraag';
  assert.equal(splitQuotedReply(wrapped).main, 'Akkoord.');

  const outlook = 'Dank je!\n\nVan: Studio Lopik <info@studiolopik.nl>\nVerzonden: zaterdag 3 oktober 2026 10:00\nAan: Joost\nOnderwerp: Planning\n\nHoi Joost,';
  assert.equal(splitQuotedReply(outlook).main, 'Dank je!');
  assert.match(splitQuotedReply(outlook).quoted ?? '', /^Van: Studio Lopik/);

  const arrows = 'Ja graag.\n\n> Wil je de oude versie terug?\n>\n> Gerjan\n';
  assert.deepEqual(splitQuotedReply(arrows), { main: 'Ja graag.', quoted: '> Wil je de oude versie terug?\n>\n> Gerjan' });
});

test('citaat: zonder herkenbaar citaat, of met alleen citaat, blijft de tekst heel', () => {
  assert.deepEqual(splitQuotedReply('Gewoon een bericht.\nMet twee regels.'), { main: 'Gewoon een bericht.\nMet twee regels.', quoted: null });
  assert.deepEqual(splitQuotedReply('> alleen een citaat'), { main: '> alleen een citaat', quoted: null });
  // "Van:" midden in een zin is geen Outlook-kop.
  assert.equal(splitQuotedReply('Van: maandag tot vrijdag zijn we open.').quoted, null);
  // Een gewone Nederlandse zin met "schreef" is geen citaatkop.
  assert.equal(splitQuotedReply('Klopt wat je zegt.\nOp de website schreef je het volgende:\n- prijzen per maand').quoted, null);
  // De Engelse Gmail-kop.
  assert.equal(splitQuotedReply('Sounds good.\n\nOn Sat, Oct 3, 2026 at 10:00 AM Gerjan <gerjan@studiolopik.nl> wrote:\n> Shall we?').main, 'Sounds good.');
});
