/**
 * Tests voor "nieuwe klant uit een mail". Draaien met:  npm test
 *
 * Elke test is een soort mail die echt in een opvangbak belandt. De gevaarlijke
 * gevallen staan erbij: de eigen handtekening onder een geciteerd antwoord, de
 * collega die doorstuurt en het contactformulier van de eigen website. Daar
 * mag de nieuwe klant nooit de gegevens van het bureau zelf krijgen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientDraftFromEmail, describeFoundFields, normalizePhone, readMailBody, type OwnDetails } from './clientFromEmail.ts';

const own: OwnDetails = {
  emails: ['info@studiolopik.nl', 'gerjan@studiolopik.nl'],
  websites: ['https://www.studiolopik.nl'],
  phones: ['020 123 4567'],
  kvkNumbers: ['87654321'],
  vatNumbers: ['NL876543210B01'],
  postalCodes: ['1011 AB'],
  names: ['Studio Lopik', 'Gerjan van Lopik'],
};

test('handtekening: bedrijf, contactpersoon, adres, telefoon, KvK, btw en website', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'peter@nieuwbedrijf.nl',
    senderName: 'Peter de Vries',
    subject: 'Offerte aanvragen',
    receivedAt: '2026-11-10T13:30:00Z',
    bodyText: [
      'Goedemiddag,',
      '',
      'Wij zoeken een bureau voor een nieuwe huisstijl. Kunnen jullie een offerte maken?',
      '',
      'Met vriendelijke groet,',
      '',
      'Peter de Vries',
      'Nieuw Bedrijf B.V.',
      'Dorpsstraat 12a',
      '3512 JE Utrecht',
      'T 06-12345678',
      'KvK 12345678 | Btw NL123456789B01',
      'www.nieuwbedrijf.nl',
    ].join('\n'),
  }, own);

  assert.equal(draft.values.name, 'Nieuw Bedrijf B.V.');
  assert.equal(draft.values.contact_name, 'Peter de Vries');
  assert.equal(draft.values.email, 'peter@nieuwbedrijf.nl');
  assert.equal(draft.values.phone, '06-12345678');
  assert.equal(draft.values.address_line1, 'Dorpsstraat 12a');
  assert.equal(draft.values.postal_code, '3512 JE');
  assert.equal(draft.values.city, 'Utrecht');
  assert.equal(draft.values.country, 'Nederland');
  assert.equal(draft.values.kvk_number, '12345678');
  assert.equal(draft.values.vat_number, 'NL123456789B01');
  assert.equal(draft.values.client_kind, 'business');
  assert.equal(draft.values.status, 'prospect');
  assert.match(draft.values.notes, /10 november 2026: "Offerte aanvragen"/);
  assert.match(draft.values.notes, /Website: www\.nieuwbedrijf\.nl/);
  assert.equal(draft.senderIsContact, true);
  assert.deepEqual([...draft.found].sort(), ['address', 'company', 'kvk_number', 'phone', 'vat_number', 'website']);
});

test('antwoord: de geciteerde eigen handtekening telt niet mee', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'jan.jansen@gmail.com',
    senderName: 'Jan Jansen',
    subject: 'Re: Fotoshoot',
    bodyText: [
      'Prima, bel me maar even.',
      '',
      'Jan',
      '',
      'Op ma 3 nov. 2026 om 10:00 schreef Studio Lopik <info@studiolopik.nl>:',
      '> Zullen we even bellen?',
      '>',
      '> Studio Lopik B.V.',
      '> Keizersgracht 1',
      '> 1011 AB Amsterdam',
      '> KvK 87654321',
      '> 020-1234567',
    ].join('\n'),
  });

  assert.equal(draft.values.name, 'Jan Jansen');
  assert.equal(draft.values.contact_name, 'Jan Jansen');
  assert.equal(draft.values.client_kind, 'consumer');
  assert.equal(draft.values.kvk_number, undefined);
  assert.equal(draft.values.phone, undefined);
  assert.equal(draft.values.postal_code, undefined);
  assert.deepEqual(draft.found, []);
});

test('Outlook-antwoord: alles onder "Van: / Verzonden:" is citaat', () => {
  const body = readMailBody([
    'Graag, dinsdag past.',
    '',
    '________________________________',
    'Van: Studio Lopik <info@studiolopik.nl>',
    'Verzonden: maandag 3 november 2026 10:00',
    'Onderwerp: Afspraak',
  ].join('\n'), 'RE: Afspraak');
  assert.equal(body.text, 'Graag, dinsdag past.');
  assert.equal(body.forwardedFrom, null);
});

test('eigen gegevens die toch in het bericht staan, neemt hij niet over', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'sanne@dekorenaar.nl',
    senderName: 'Sanne Bakker',
    subject: 'Foto\'s',
    bodyText: 'Jullie nummer 020 123 4567 werkt niet. Ons nummer is 0301234567.\n\nKvK 87654321',
  }, own);
  assert.equal(draft.values.phone, '0301234567');
  assert.equal(draft.values.kvk_number, undefined);
});

test('contactformulier van de eigen website: de klant staat in de velden, niet in de afzender', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'wordpress@studiolopik.nl',
    senderName: 'Studio Lopik',
    subject: 'Nieuw bericht via het contactformulier',
    bodyText: [
      'Er is een nieuw bericht verstuurd via je website.',
      '',
      'Naam: Sanne Bakker',
      'Bedrijfsnaam: De Korenaar',
      'E-mailadres: Sanne@Gmail.com',
      'Telefoonnummer: +31 (0)6 1234 5678',
      'Adres: Molenweg 4',
      'Postcode: 3871ab',
      'Plaats: HOEVELAKEN',
      'Bericht: Wij willen graag foto\'s van de nieuwe winkel.',
    ].join('\n'),
  }, own);

  assert.equal(draft.values.name, 'De Korenaar');
  assert.equal(draft.values.contact_name, 'Sanne Bakker');
  assert.equal(draft.values.email, 'sanne@gmail.com');
  assert.equal(draft.values.phone, '+31 (0)6 1234 5678');
  assert.equal(draft.values.address_line1, 'Molenweg 4');
  assert.equal(draft.values.postal_code, '3871 AB');
  assert.equal(draft.values.city, 'Hoevelaken');
  assert.equal(draft.values.client_kind, 'business');
  // De afzender is de website: dat adres mag nooit aan de klant blijven hangen.
  assert.equal(draft.senderIsContact, false);
  assert.ok(draft.found.includes('email'));
  assert.ok(draft.found.includes('contact_name'));
});

test('contactformulier met voornaam, tussenvoegsel en achternaam van een no-reply-adres', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'no-reply@formulieren.nl',
    senderName: 'Formulieren',
    subject: 'Aanvraag',
    bodyText: 'Voornaam: Karim\nTussenvoegsel: El\nAchternaam: Amrani\nE-mail: karim@zeezicht.nl\nTelefoon: 010 123 45 67',
  });
  assert.equal(draft.values.contact_name, 'Karim el Amrani');
  assert.equal(draft.values.email, 'karim@zeezicht.nl');
  assert.equal(draft.values.phone, '010 123 45 67');
  assert.equal(draft.values.name, 'Zeezicht');
  assert.equal(draft.senderIsContact, false);
});

test('doorgestuurd door een collega: de klant komt uit het kopblok, niet de collega', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'gerjan@studiolopik.nl',
    senderName: 'Gerjan van Lopik',
    subject: 'Fwd: Offerte terras',
    bodyText: [
      'Kun jij deze oppakken?',
      '',
      'Gerjan',
      '06-99999999',
      '',
      '---------- Forwarded message ---------',
      'Van: Karim El Amrani <karim@restaurantzeezicht.nl>',
      'Date: ma 3 nov 2026 om 09:12',
      'Subject: Offerte terras',
      'To: <info@studiolopik.nl>',
      '',
      'Hallo,',
      '',
      'We willen graag een offerte voor foto\'s van het terras.',
      '',
      'Karim El Amrani',
      'Restaurant Zeezicht',
      '010-1234567',
    ].join('\n'),
  }, own);

  assert.equal(draft.values.email, 'karim@restaurantzeezicht.nl');
  assert.equal(draft.values.contact_name, 'Karim El Amrani');
  assert.equal(draft.values.phone, '010-1234567');
  assert.equal(draft.values.name, 'Restaurantzeezicht');
  // Het opgeslagen afzenderadres is dat van de collega: niet onthouden bij deze klant.
  assert.equal(draft.senderIsContact, false);
});

test('doorgestuurd zonder "Fwd:" in het onderwerp, met een kale Outlook-afzender', () => {
  const body = readMailBody([
    '',
    '-----Original Message-----',
    'From: Bakker, Jan [mailto:jan@bakker.nl]',
    'Sent: Monday, November 3, 2026 9:00 AM',
    '',
    'Hoi, kunnen jullie langskomen?',
  ].join('\n'), 'FW: langskomen');
  assert.deepEqual(body.forwardedFrom, { email: 'jan@bakker.nl', name: 'Bakker, Jan' });
  assert.equal(body.text, 'Hoi, kunnen jullie langskomen?');

  const renamed = readMailBody('---------- Doorgestuurd bericht ---------\nVan: <lisa@bloem.nl>\n\nHallo!', 'Bloemen');
  assert.deepEqual(renamed.forwardedFrom, { email: 'lisa@bloem.nl' });
  assert.equal(renamed.text, 'Hallo!');
});

test('weergavenaam "Achternaam, Voornaam" en een "via"-toevoeging', () => {
  assert.equal(clientDraftFromEmail({ senderEmail: 'j.bakker@hotmail.com', senderName: 'Bakker, Jan', subject: '', bodyText: '' }).values.contact_name, 'Jan Bakker');
  assert.equal(clientDraftFromEmail({ senderEmail: 'jan@hotmail.com', senderName: '"Jan Bakker" via Klantgroep', subject: '', bodyText: '' }).values.contact_name, 'Jan Bakker');
});

test('zonder weergavenaam: naam uit het adres, maar niet uit info@', () => {
  const person = clientDraftFromEmail({ senderEmail: 'jan.de.vries@gmail.com', senderName: null, subject: 'Vraag', bodyText: 'Wat kost dat?' });
  assert.equal(person.values.contact_name, 'Jan de Vries');
  assert.equal(person.values.name, 'Jan de Vries');
  assert.equal(person.values.client_kind, 'consumer');

  const mailbox = clientDraftFromEmail({ senderEmail: 'info@bakker-fotografie.nl', senderName: '', subject: 'Vraag', bodyText: 'Wat kost dat?' });
  assert.equal(mailbox.values.contact_name, undefined);
  assert.equal(mailbox.values.name, 'Bakker Fotografie');
  assert.equal(mailbox.values.client_kind, 'business');
});

test('een weergavenaam met rechtsvorm is de bedrijfsnaam', () => {
  const draft = clientDraftFromEmail({ senderEmail: 'info@bakker.nl', senderName: 'Bakker Installatietechniek BV', subject: '', bodyText: 'Graag een offerte.' });
  assert.equal(draft.values.name, 'Bakker Installatietechniek BV');
  assert.equal(draft.values.contact_name, undefined);
});

test('handtekening met meer velden op één regel', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'lisa@bloemenzee.nl',
    senderName: 'Lisa',
    subject: 'Vraag',
    bodyText: 'Groet,\nLisa\nT: 06 1234 5678 | E: lisa@bloemenzee.nl | W: www.bloemenzee.nl\nA: Marktplein 3, 1234 AB Zeewolde',
  });
  assert.equal(draft.values.phone, '06 1234 5678');
  assert.equal(draft.values.address_line1, 'Marktplein 3');
  assert.equal(draft.values.postal_code, '1234 AB');
  assert.equal(draft.values.city, 'Zeewolde');
  assert.match(draft.values.notes, /www\.bloemenzee\.nl/);
});

test('geen valse treffers: een zin met "bv", een datum, een bedrag en een IBAN', () => {
  const draft = clientDraftFromEmail({
    senderEmail: 'kees@gmail.com',
    senderName: 'Kees',
    subject: 'Vraag',
    bodyText: [
      'Wij zijn een bv',
      'Kunnen jullie bv. ook video maken?',
      'Afspraak 01-11-2026 10:00 graag.',
      'Budget:',
      '1500 of meer',
      'IBAN NL91 ABNA 0417 1643 00',
      'Factuur 2026-0012345',
    ].join('\n'),
  });
  assert.equal(draft.values.name, 'Kees');
  assert.equal(draft.values.phone, undefined);
  assert.equal(draft.values.postal_code, undefined);
  assert.equal(draft.values.client_kind, 'consumer');
  assert.deepEqual(draft.found, []);
});

test('een bureau met een Gmail-adres filtert klanten met een Gmail-adres niet weg', () => {
  const draft = clientDraftFromEmail(
    { senderEmail: 'sanne@gmail.com', senderName: 'Sanne', subject: '', bodyText: '' },
    { emails: ['studiolopik@gmail.com'] },
  );
  assert.equal(draft.values.email, 'sanne@gmail.com');
  assert.equal(draft.senderIsContact, true);
});

test('een no-reply-afzender zonder gegevens geeft een lege klant die je zelf invult', () => {
  const draft = clientDraftFromEmail({ senderEmail: 'noreply@webshop.nl', senderName: 'Webshop', subject: 'Je bestelling', bodyText: 'Bedankt voor je bestelling.' });
  assert.equal(draft.values.name, 'Nieuwe klant');
  assert.equal(draft.values.email, undefined);
  assert.equal(draft.senderIsContact, false);
});

test('btw-nummers en telefoonnummers worden genormaliseerd', () => {
  const draft = clientDraftFromEmail({ senderEmail: 'a@b.be', senderName: 'A', subject: '', bodyText: 'BTW: BE 0123.456.789\nBtw-nummer NL 1234.56.789.B01' });
  assert.equal(draft.values.vat_number, 'BE0123456789');
  assert.equal(normalizePhone('+31 (0)6 1234 5678'), '+31 (0)6 1234 5678');
  assert.equal(normalizePhone('0612345678'), '0612345678');
  assert.equal(normalizePhone('06-1234567'), null);
  assert.equal(normalizePhone('12345678'), null);
});

test('de melding boven het formulier', () => {
  assert.equal(describeFoundFields([]), '');
  assert.equal(describeFoundFields(['phone']), 'telefoon');
  assert.equal(describeFoundFields(['phone', 'company', 'address']), 'bedrijfsnaam, telefoon en adres');
});
