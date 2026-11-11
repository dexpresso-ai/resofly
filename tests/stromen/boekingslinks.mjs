// Boekingslinks door de echte edge functions (`meeting-booking`,
// `meeting-booking-public`) tegen de echte database: wie wat mag, wat de klant
// op de boekingspagina ziet, en wat er gebeurt als iets halverwege misgaat.
//
// Waarom: de controle van 10 november 2026 vond fouten die pas in de naad
// tussen functie en database zichtbaar worden. Een poging die bleef hangen
// hield een link voorgoed dicht, een blok dat al begonnen was kon nog geboekt
// worden, de link van een oud-teamlid boekte gewoon door, en annuleren kon een
// blok van iemand anders weer openzetten. Zie
// docs/changelog/CHANGELOG_BOEKINGSLINKS_2026-11-10.md.
//
//   npm run test:stromen -- boekingslinks
import { randomUUID } from 'node:crypto';
import { roep } from './functies.mjs';
import { mailsAan } from './nepdiensten.mjs';
import { sql, sqlRij } from './supabase.mjs';
import { gelijk, gelukt, geweigerd, groep, stap, verwacht } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

function agenda(token, orgId, action, body = {}) {
  return roep('calendar-integrations', { token, body: { action, organizationId: orgId, ...body } });
}

function boeking(token, orgId, action, body = {}) {
  return roep('meeting-booking', { token, body: { action, organizationId: orgId, ...body } });
}

function publiek(action, body, ip) {
  return roep('meeting-booking-public', { body: { action, ...body }, ip });
}

/** Een moment `uren` vanaf nu, op een heel uur. */
function moment(uren, duurMinuten = 30) {
  const start = new Date(Date.now() + uren * 3_600_000);
  start.setUTCMinutes(0, 0, 0);
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duurMinuten * 60_000).toISOString() };
}

export default async function boekingslinksScenario() {
  groep('Boekingslinks: lezen, schrijven en andere organisaties');
  const w = await stap('wereld maken', () => maakWereld('boek'));
  if (!w) return;
  const w2 = await stap('een tweede organisatie', () => maakWereld('boek2'));
  if (!w2) return;

  const bron = await stap('een eigen ResoFly-agenda', async () =>
    gelukt(await agenda(w.medewerker.token, w.orgId, 'createNativeCalendar', { name: 'Afspraken' }), 'agenda').source);
  if (!bron) return;

  const link = await stap('een boekingslink voor klant A, met twee momenten', async () => {
    const res = gelukt(await boeking(w.medewerker.token, w.orgId, 'createLink', {
      sourceId: bron.id, clientId: w.klantA.id, title: 'Kennismaking', autoConference: true, conferenceProvider: 'jitsi',
    }), 'link');
    verwacht(res.token && res.token.length >= 40, 'een lange token');
    verwacht(!('public_token_hash' in res.link), 'de hash van de token gaat niet naar de app');
    gelijk(res.link.has_token, true, 'heeft een URL');
    const toegevoegd = gelukt(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: res.link.id, slots: [moment(30), moment(54)] }), 'momenten');
    gelijk(toegevoegd.slots.length, 2, 'twee momenten');
    return { ...res, slots: toegevoegd.slots };
  });
  if (!link) return;

  await stap('een moment in het verleden kan er niet op', async () => {
    const res = geweigerd(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: link.link.id, slots: [moment(-3)] }), 'verleden', [422]);
    verwacht(/verleden/.test(res?.error ?? ''), `uitleg: ${res?.error}`);
  });

  await stap('twee keer hetzelfde moment: het tweede wordt overgeslagen', async () => {
    const res = gelukt(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: link.link.id, slots: [moment(30)] }), 'dubbel');
    gelijk([res.slots.length, res.skipped], [0, 1], 'overgeslagen');
  });

  await stap('alleen leesrecht op de Agenda: de links van de klant zien, niets maken', async () => {
    sql(`update public.organization_members set module_access = module_access || '{"calendar":"read"}'::jsonb
          where organization_id = ${q(w.orgId)} and user_id = ${q(w.lezer.id)}`);
    const lijst = gelukt(await boeking(w.lezer.token, w.orgId, 'listLinks', { clientId: w.klantA.id }), 'lijst');
    gelijk(lijst.links.length, 1, 'de link van klant A');
    gelijk([lijst.links[0].state, lijst.links[0].open_slot_count, lijst.links[0].owner_can_book], ['open', 2, true], 'stand');
    verwacht(!('public_token_hash' in lijst.links[0]), 'geen hash in de lijst');
    const andereKlant = gelukt(await boeking(w.lezer.token, w.orgId, 'listLinks', { clientId: w.klantB.id }), 'klant B');
    gelijk(andereKlant.links.length, 0, 'klant B heeft er geen');
    geweigerd(await boeking(w.lezer.token, w.orgId, 'createLink', { sourceId: bron.id, title: 'Mag niet' }), 'maken zonder schrijfrecht', [403]);
    geweigerd(await boeking(w.lezer.token, w.orgId, 'regenerateToken', { linkId: link.link.id }), 'nieuwe link zonder schrijfrecht', [403]);
  });

  await stap('zonder de Agenda (de boekhouder) geen boekingslinks', async () => {
    geweigerd(await boeking(w.boekhouder.token, w.orgId, 'listLinks'), 'boekhouder', [403]);
  });

  await stap('een andere organisatie ziet de link niet', async () => {
    geweigerd(await boeking(w2.medewerker.token, w2.orgId, 'getLink', { linkId: link.link.id }), 'eigen organisatie', [404]);
    geweigerd(await boeking(w2.medewerker.token, w.orgId, 'getLink', { linkId: link.link.id }), 'organisatie van een ander', [403]);
    // Het id van een klant van een ander opent niets: de lijst blijft die van de eigen organisatie.
    const lijst = gelukt(await boeking(w2.medewerker.token, w2.orgId, 'listLinks', { clientId: w.klantA.id }), 'klant van een ander');
    gelijk(lijst.links.length, 0, 'geen links van een andere organisatie');
  });

  groep('De boekingspagina van de klant');
  const begonnen = await stap('een moment dat al begonnen is, staat er niet op', async () => {
    // sqlRij leest alleen een select; de rij krijgt hier zelf zijn id.
    const rij = { id: randomUUID() };
    sql(`insert into public.meeting_booking_slots (id, booking_link_id, organization_id, starts_at, ends_at)
         values (${q(rij.id)}, ${q(link.link.id)}, ${q(w.orgId)}, now() - interval '10 minutes', now() + interval '20 minutes')`);
    const res = await publiek('getLink', { token: link.token });
    const info = gelukt(res, 'pagina');
    gelijk(info.state, 'open', 'stand');
    gelijk(info.slots.length, 2, 'alleen de twee momenten die nog moeten komen');
    verwacht(!info.slots.some((s) => s.id === rij.id), 'het begonnen moment staat er niet op');
    verwacht(info.branding && info.company?.name, 'huisstijl en contact van de organisatie');
    verwacht(info.link.video === 'Videogesprek via Jitsi Meet', `hoe: ${info.link.video}`);
    verwacht(!res.tekst.includes(w.orgId) && !res.tekst.includes('public_token_hash') && !res.tekst.includes(link.link.id), 'geen id\'s of hash naar de bezoeker');
    gelijk(res.headers.get('cache-control'), 'no-store', 'niet in een cache');
    gelijk(info.prefill?.email, w.klantA.email, 'het adres van de klant staat al klaar');
    return rij;
  });

  await stap('een begonnen moment boeken lukt ook rechtstreeks niet', async () => {
    const res = gelukt(await publiek('bookSlots', { token: link.token, name: 'Klaas', email: 'klaas@klant.test', slotIds: [begonnen.id] }), 'boeken');
    gelijk([res.confirmed.length, res.failed.length], [0, 1], 'niet geboekt');
    verwacht(/voorbij/.test(res.failed[0].reason), `reden: ${res.failed[0].reason}`);
  });

  const geboekt = await stap('boeken: bevestigd, een bevestiging per mail, en daarna is de link vol', async () => {
    const res = gelukt(await publiek('bookSlots', { token: link.token, name: 'Klaas\nKlant', email: 'Klaas@Klant.test', slotIds: [link.slots[0].id, link.slots[0].id] }), 'boeken');
    gelijk([res.confirmed.length, res.failed.length], [1, 0], 'één keer geboekt, ook al stond hij er twee keer in');
    const rij = sqlRij(`select id, booked_name, booked_email, status from public.meeting_bookings where booking_link_id = ${q(link.link.id)} and status = 'confirmed'`);
    gelijk([rij.booked_name, rij.booked_email], ['Klaas Klant', 'klaas@klant.test'], 'naam zonder regeleinde, adres in kleine letters');
    verwacht(mailsAan('klaas@klant.test').some((m) => /Bevestigd/.test(m.subject)), 'bevestiging aan de klant');
    const info = gelukt(await publiek('getLink', { token: link.token }), 'pagina');
    gelijk([info.state, info.slots.length, info.booked.length], ['full', 0, 1], 'vol, met de afspraak erbij');
    const nogEen = gelukt(await publiek('bookSlots', { token: link.token, email: 'klaas@klant.test', slotIds: [link.slots[1].id] }), 'nog een');
    gelijk(nogEen.confirmed.length, 0, 'maximum bewaakt');
    verwacht(/alle afspraken/.test(nogEen.failed[0]?.reason ?? ''), `reden: ${nogEen.failed[0]?.reason}`);
    return rij;
  });
  if (!geboekt) return;

  // November 2026, tweede ronde: de klant ziet zijn afspraak in zijn portaal,
  // met de videolink; en de pagina zegt welk videogesprek het is.
  await stap('de videolink staat bij de boeking, en de pagina noemt de dienst', async () => {
    const rij = sqlRij(`select meeting_url, video_service from public.meeting_bookings where id = ${q(geboekt.id)}`);
    verwacht(/^https:\/\/meet\.jit\.si\/ResoFly-[A-Za-z0-9]{14}$/.test(rij.meeting_url ?? ''), `Jitsi-link bewaard: ${rij.meeting_url}`);
    gelijk(rij.video_service, 'jitsi', 'dienst bewaard');
    const info = gelukt(await publiek('getLink', { token: link.token }), 'pagina');
    gelijk(info.link.video_service, 'jitsi', 'de pagina noemt Jitsi');
  });

  await stap('het klantportaal toont de afspraak, alleen aan deze klant', async () => {
    const portaal = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'getPortalData' } }), 'portaal A');
    const account = portaal.accounts.find((a) => a.client?.id === w.klantA.id);
    verwacht(account, 'dossier van klant A');
    const afspraak = (account.appointments ?? []).find((a) => a.id === geboekt.id);
    verwacht(afspraak, 'de afspraak staat erin');
    gelijk([afspraak.status, afspraak.title, afspraak.video_service, afspraak.booked_by], ['confirmed', 'Kennismaking', 'jitsi', 'Klaas Klant'], 'stand, titel, dienst en wie boekte');
    verwacht(/^https:\/\/meet\.jit\.si\//.test(afspraak.meeting_url ?? ''), 'met de videolink');
    verwacht(!('booked_email' in afspraak) && !JSON.stringify(account.appointments).includes('klaas@klant.test'), 'geen e-mailadres van wie boekte');
    const portaalB = gelukt(await roep('client-portal', { token: w.portaalB.token, body: { action: 'getPortalData' } }), 'portaal B');
    verwacht(portaalB.accounts.every((a) => !(a.appointments ?? []).some((x) => x.id === geboekt.id)), 'klant B ziet hem niet');
  });

  await stap('annuleren door het team: het moment komt weer vrij', async () => {
    gelukt(await boeking(w.medewerker.token, w.orgId, 'cancelBooking', { bookingId: geboekt.id }), 'annuleren');
    const info = gelukt(await publiek('getLink', { token: link.token }), 'pagina');
    gelijk([info.state, info.slots.length], ['open', 2], 'weer open, beide momenten vrij');
  });

  await stap('na annuleren: in het portaal "gaat niet door", zonder videolink', async () => {
    const portaal = gelukt(await roep('client-portal', { token: w.portaalA.token, body: { action: 'getPortalData' } }), 'portaal A');
    const afspraak = portaal.accounts.flatMap((a) => a.appointments ?? []).find((a) => a.id === geboekt.id);
    verwacht(afspraak, 'staat er nog');
    gelijk([afspraak.status, afspraak.meeting_url], ['cancelled', null], 'geannuleerd, zonder link');
  });

  await stap('een mislukte boeking annuleren kan niet, en zet geen blok van een ander open', async () => {
    const mislukt = { id: randomUUID() };
    sql(`insert into public.meeting_bookings (id, booking_link_id, slot_id, organization_id, booked_email, status, cancelled_at)
         values (${q(mislukt.id)}, ${q(link.link.id)}, ${q(link.slots[0].id)}, ${q(w.orgId)}, 'ander@klant.test', 'failed', now())`);
    const res = geweigerd(await boeking(w.medewerker.token, w.orgId, 'cancelBooking', { bookingId: mislukt.id }), 'mislukte boeking', [409]);
    verwacht(/nooit doorgegaan/.test(res?.error ?? ''), `uitleg: ${res?.error}`);
    geweigerd(await boeking(w2.medewerker.token, w2.orgId, 'cancelBooking', { bookingId: geboekt.id }), 'andere organisatie', [404]);
  });

  await stap('een poging die blijft hangen, houdt de link niet meer dicht', async () => {
    // De functie viel om tussen reserveren en afronden: een boeking op 'pending'
    // en een blok op 'pending', elf minuten oud.
    sql(`update public.meeting_booking_slots set status = 'pending', pending_at = now() - interval '11 minutes' where id = ${q(link.slots[1].id)};
         insert into public.meeting_bookings (booking_link_id, slot_id, organization_id, booked_email, status, created_at)
         values (${q(link.link.id)}, ${q(link.slots[1].id)}, ${q(w.orgId)}, 'weg@klant.test', 'pending', now() - interval '11 minutes');`);
    const info = gelukt(await publiek('getLink', { token: link.token }), 'pagina');
    gelijk([info.state, info.slots.length], ['open', 2], 'de dode poging telt niet');
    const res = gelukt(await publiek('bookSlots', { token: link.token, name: 'Nieuwe klant', email: 'nieuw@klant.test', slotIds: [link.slots[1].id] }), 'boeken');
    gelijk(res.confirmed.length, 1, 'hetzelfde moment is weer te boeken');
    gelijk(sqlRij(`select status from public.meeting_bookings where booked_email = 'weg@klant.test'`).status, 'failed', 'de dode poging staat op mislukt');
  });

  groep('Wie de link maakte, en de stand van de link');
  await stap('de maker is geen teamlid meer: de link boekt niets, en mailen kan niet', async () => {
    gelukt(await boeking(w.eigenaar.token, w.orgId, 'updateLink', { linkId: link.link.id, patch: { maxTotalBookings: 5, maxPerWeek: 5 } }), 'meer afspraken');
    sql(`update public.organization_members set status = 'disabled' where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    try {
      const info = gelukt(await publiek('getLink', { token: link.token }), 'pagina');
      gelijk([info.state, info.slots.length, info.prefill], ['unavailable', 0, null], 'niet beschikbaar, zonder momenten of klantgegevens');
      const res = geweigerd(await publiek('bookSlots', { token: link.token, email: 'klaas@klant.test', slotIds: [link.slots[0].id] }), 'boeken', [409]);
      verwacht(/niet meer beschikbaar/.test(res?.error ?? ''), `uitleg: ${res?.error}`);
      const mail = geweigerd(await boeking(w.eigenaar.token, w.orgId, 'sendLinkMail', { linkId: link.link.id, token: link.token, recipientEmail: 'klaas@klant.test' }), 'mailen', [409]);
      verwacht(/niet meer in de Agenda schrijven/.test(mail?.error ?? ''), `uitleg: ${mail?.error}`);
      const lijst = gelukt(await boeking(w.eigenaar.token, w.orgId, 'getLink', { linkId: link.link.id }), 'beheer');
      gelijk([lijst.state, lijst.owner_can_book], ['unavailable', false], 'het beheer zegt het ook');
    } finally {
      sql(`update public.organization_members set status = 'active' where organization_id = ${q(w.orgId)} and user_id = ${q(w.medewerker.id)}`);
    }
  });

  await stap('gesloten: de klant ziet dat, met de contactgegevens', async () => {
    gelukt(await boeking(w.eigenaar.token, w.orgId, 'updateLink', { linkId: link.link.id, patch: { status: 'closed' } }), 'sluiten');
    const info = gelukt(await publiek('getLink', { token: link.token }), 'pagina');
    gelijk([info.state, info.slots.length], ['closed', 0], 'gesloten');
    verwacht(info.company?.email, 'contact staat erbij');
    geweigerd(await publiek('bookSlots', { token: link.token, email: 'klaas@klant.test', slotIds: [link.slots[0].id] }), 'boeken op een gesloten link', [410]);
    gelukt(await boeking(w.eigenaar.token, w.orgId, 'updateLink', { linkId: link.link.id, patch: { status: 'active' } }), 'heropenen');
  });

  await stap('verlopen, en verlengen: dezelfde link werkt weer', async () => {
    sql(`update public.meeting_booking_links set public_token_expires_at = now() - interval '1 day' where id = ${q(link.link.id)}`);
    gelijk(gelukt(await publiek('getLink', { token: link.token }), 'verlopen').state, 'expired', 'verlopen');
    geweigerd(await publiek('bookSlots', { token: link.token, email: 'klaas@klant.test', slotIds: [link.slots[0].id] }), 'boeken op een verlopen link', [410]);
    const res = gelukt(await boeking(w.medewerker.token, w.orgId, 'extendLink', { linkId: link.link.id, ttlDays: 1e9 }), 'verlengen');
    const dagen = (Date.parse(res.link.public_token_expires_at) - Date.now()) / 86_400_000;
    verwacht(dagen > 364 && dagen < 366, `hooguit een jaar: ${dagen}`);
    gelijk(gelukt(await publiek('getLink', { token: link.token }), 'weer open').state, 'open', 'dezelfde token werkt weer');
  });

  await stap('mailen kan alleen met vrije momenten, en de mail bevat de link', async () => {
    const leeg = gelukt(await boeking(w.medewerker.token, w.orgId, 'createLink', { sourceId: bron.id, title: 'Zonder momenten' }), 'lege link');
    const res = geweigerd(await boeking(w.medewerker.token, w.orgId, 'sendLinkMail', { linkId: leeg.link.id, token: leeg.token, recipientEmail: 'klaas@klant.test' }), 'lege pagina', [409]);
    verwacht(/geen vrije momenten/.test(res?.error ?? ''), `uitleg: ${res?.error}`);
    gelukt(await boeking(w.medewerker.token, w.orgId, 'sendLinkMail', { linkId: link.link.id, token: link.token, recipientEmail: 'Klant.A@Klant.test', recipientName: 'Klant\nA' }), 'mailen');
    const mail = mailsAan('klant.a@klant.test').at(-1);
    verwacht(mail && mail.text.includes(link.token), 'de link staat in de mail');
    verwacht(mail && /videogesprek via Jitsi Meet/.test(mail.text), 'de mail noemt het videogesprek');
    geweigerd(await boeking(w.medewerker.token, w.orgId, 'sendLinkMail', { linkId: link.link.id, token: 'verkeerd-token', recipientEmail: 'klaas@klant.test' }), 'verkeerde token', [422]);
  });

  await stap('hooguit 500 vrije momenten op één link', async () => {
    const vol = gelukt(await boeking(w.medewerker.token, w.orgId, 'createLink', { sourceId: bron.id, title: 'Vol' }), 'link');
    sql(`insert into public.meeting_booking_slots (booking_link_id, organization_id, starts_at, ends_at, status)
         select ${q(vol.link.id)}, ${q(w.orgId)}, now() + (g || ' hours')::interval + interval '1 day', now() + (g || ' hours')::interval + interval '1 day 30 minutes', 'open'
           from generate_series(1, 499) g`);
    const twee = [moment(24 * 40), moment(24 * 40 + 1)];
    const res = geweigerd(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: vol.link.id, slots: twee }), 'twee te veel', [422]);
    verwacht(/nog 1 bij/.test(res?.error ?? ''), `uitleg: ${res?.error}`);
    gelijk(gelukt(await boeking(w.medewerker.token, w.orgId, 'addSlots', { linkId: vol.link.id, slots: [twee[0]] }), 'nog één').slots.length, 1, 'de laatste past');
  });

  await stap('verwijderen met afspraken: liever sluiten', async () => {
    const res = geweigerd(await boeking(w.medewerker.token, w.orgId, 'deleteLink', { linkId: link.link.id }), 'verwijderen', [409]);
    verwacht(/Sluit de link liever/.test(res?.error ?? ''), `uitleg: ${res?.error}`);
  });

  await stap('een onbekende of gewijzigde token: hetzelfde antwoord, niets meer', async () => {
    const res = geweigerd(await publiek('getLink', { token: `${link.token.slice(0, -2)}xx` }), 'onbekend', [404]);
    verwacht(!('branding' in (res ?? {})), 'geen huisstijl bij een onbekende link');
    geweigerd(await publiek('getLink', { token: 'kort' }), 'te kort', [400]);
  });

  await stap('de rem: te vaak boeken vanaf één adres', async () => {
    const extra = gelukt(await boeking(w.medewerker.token, w.orgId, 'createLink', { sourceId: bron.id, title: 'Rem' }), 'link');
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 20}`;
    let laatste = null;
    for (let i = 0; i < 21; i += 1) laatste = await publiek('bookSlots', { token: extra.token, email: 'rem@klant.test', slotIds: [] }, ip);
    gelijk(laatste.status, 429, 'de 21e poging binnen tien minuten');
    // Een ander adres heeft er geen last van.
    gelijk((await publiek('bookSlots', { token: extra.token, email: 'rem@klant.test', slotIds: [] }, '198.51.100.7')).status, 422, 'ander adres');
  });
}
