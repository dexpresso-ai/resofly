// Stromen: tickets van begin tot eind. Het team in de app (PostgREST met RLS),
// de klant in het portaal (`client-portal`) en de mailronde die elke minuut
// draait (`portal-notify`, met nep-Resend). Getoetst:
//  - een ticket van het team, een antwoord, een statuswijziging en afhandelen
//    komen als mail bij de klant aan, met de juiste link en zonder interne
//    notities;
//  - een ticket uit het portaal geeft een ontvangstbevestiging; reageert de
//    klant op een afgehandeld ticket, dan gaat het weer open, zonder mail aan
//    hemzelf;
//  - de eigen keuzes in het portaal en de schakelaar van de organisatie;
//  - wie wat mag: een andere klant, een andere organisatie, de kijker, de
//    boekhouder, een lid zonder of met alleen leesrecht op Tickets, anon.
//
// Aanleiding: de controle van het ticketsysteem op 10 november 2026
// (docs/changelog/CHANGELOG_TICKETS_CONTROLE_2026-11-10.md). Er was geen
// stromentest voor tickets; de mailmeldingen waren alleen met unittests
// (portalNotify.test.ts) getoetst.
import { createHmac, randomUUID } from 'node:crypto';
import { CRON_SECRET, RESEND_WEBHOOK_GEHEIM } from './omgeving.mjs';
import { roep } from './functies.mjs';
import { post, mailsAan } from './nepdiensten.mjs';
import { maakGebruiker, rest, rpc, sql, sqlRij, sqlRijen, uniek } from './supabase.mjs';
import { groep, stap, verwacht, gelijk, gelukt, geweigerd, nietsVeranderd } from './toets.mjs';
import { maakWereld } from './wereld.mjs';

function q(waarde) {
  return `'${String(waarde).replace(/'/g, "''")}'`;
}

/** De ronde zoals pg_cron hem elke minuut aanroept. */
function mailronde(geheim = CRON_SECRET) {
  return roep('portal-notify', {
    query: 'cron=drain', origin: null, body: {},
    headers: geheim === null ? {} : { 'x-cron-secret': geheim },
  });
}

function portaal(gebruiker, body) {
  return roep('client-portal', { token: gebruiker.token, body });
}

function activiteit(ticketId) {
  return sqlRijen(`select kind, actor_type, notify_status, last_error, notified_emails, old_status, new_status
                     from public.portal_ticket_activity where ticket_id = ${q(ticketId)} order by created_at`);
}

/** Mails aan dit adres die na `vanaf` (een eerdere telling) binnenkwamen. */
function nieuweMails(email, vanaf) {
  return mailsAan(email).slice(vanaf);
}

async function teamTicket(w, gebruiker, velden) {
  const res = await rest('tickets?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: { organization_id: w.orgId, created_by: gebruiker.id, priority: 'med', status: 'new', ...velden },
  });
  return res;
}

async function teamNotitie(w, gebruiker, ticketId, body, isInternal) {
  return rest('ticket_notes?select=*', {
    method: 'POST', token: gebruiker.token, prefer: 'return=representation',
    body: {
      organization_id: w.orgId, ticket_id: ticketId, created_by: gebruiker.id,
      author_type: 'user', author_user_id: gebruiker.id, author_name: gebruiker.email,
      body, is_internal: isInternal,
    },
  });
}

function zetStatus(w, gebruiker, ticketId, status) {
  return rest(`tickets?id=eq.${ticketId}&organization_id=eq.${w.orgId}&select=id,status,resolved_at`, {
    method: 'PATCH', token: gebruiker.token, prefer: 'return=representation', body: { status },
  });
}

/** Een webhook zoals Resend hem stuurt (Svix-handtekening over id.tijd.body). */
function resendWebhook(payload) {
  const body = JSON.stringify(payload);
  const id = `msg_${randomUUID()}`;
  const tijd = Math.floor(Date.now() / 1000).toString();
  const sleutel = Buffer.from(RESEND_WEBHOOK_GEHEIM.replace(/^whsec_/, ''), 'base64');
  const handtekening = createHmac('sha256', sleutel).update(`${id}.${tijd}.${body}`).digest('base64');
  return roep('resend-webhook', {
    body, ruw: true, origin: null,
    headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': tijd, 'svix-signature': `v1,${handtekening}` },
  });
}

export default async function tickets() {
  groep('Tickets — opzet');
  const w = await stap('wereld maken', () => maakWereld('tickets'));
  if (!w) return;
  const ander = await stap('een tweede organisatie', () => maakWereld('tickets-ander'));
  const klantA = w.klantA.email.toLowerCase();
  const klantB = w.klantB.email.toLowerCase();

  // ── 1. Het team maakt een ticket voor de klant ─────────────────────────
  groep('Tickets — het team maakt een ticket, de klant krijgt een mail');
  const geheim = uniek('INTERN-GEHEIM');
  let ticket = null;

  await stap('de mailronde zonder of met een fout geheim doet niets', async () => {
    geweigerd(await mailronde(null), 'zonder geheim', [401]);
    geweigerd(await mailronde('fout-geheim'), 'fout geheim', [401]);
  });

  await stap('een medewerker maakt een ticket voor klant A', async () => {
    const res = await teamTicket(w, w.medewerker, {
      client_id: w.klantA.id,
      title: 'Website <img src=x onerror=alert(1)> offline',
      description: 'Sinds vanochtend.',
    });
    gelijk(res.status, 201, `ticket aanmaken: ${res.tekst}`);
    ticket = res.json[0];
    const rijen = activiteit(ticket.id);
    gelijk(rijen.map((r) => `${r.kind}/${r.actor_type}/${r.notify_status}`), ['created/staff/queued'], 'activiteit voor de klant');
  });

  await stap('de mailronde mailt klant A, met een link naar het ticket in het portaal', async () => {
    const voorA = mailsAan(klantA).length;
    const voorB = mailsAan(klantB).length;
    const uit = gelukt(await mailronde(), 'mailronde');
    verwacht(uit.sent >= 1, `verwacht minstens één mail, kreeg ${JSON.stringify(uit)}`);
    const mails = nieuweMails(klantA, voorA);
    gelijk(mails.length, 1, 'mails aan klant A');
    gelijk(nieuweMails(klantB, voorB).length, 0, 'mails aan klant B');
    const mail = mails[0];
    verwacht(mail.subject.startsWith('Nieuw ticket: Website'), `onderwerp: ${mail.subject}`);
    verwacht(!mail.subject.includes('\n'), 'onderwerp is één regel');
    verwacht(mail.html.includes(`dossier=${w.klantA.id}`) && mail.html.includes(`ticket=${ticket.id}`), 'de knop opent het ticket in het juiste dossier');
    verwacht(!mail.html.includes('<img src=x'), 'de titel staat ge-escaped in de HTML');
    verwacht(mail.html.includes('&lt;img src=x'), 'de titel staat er wel, als tekst');
    gelijk(mail.tags.find((t) => t.name === 'template_key')?.value, 'portal_ticket_update', 'tag voor de webhook');
    verwacht(mail.idempotencyKey && mail.idempotencyKey.startsWith('portal-ticket-'), 'een idempotency-sleutel per ontvanger');
    const rij = activiteit(ticket.id)[0];
    gelijk(rij.notify_status, 'done', 'status van de activiteit');
    gelijk(rij.notified_emails, [klantA], 'wie de mail kreeg');
  });

  await stap('een tweede ronde stuurt niets opnieuw', async () => {
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantA).length, voor, 'geen dubbele mail');
  });

  // ── 2. Antwoorden: intern blijft binnen, zichtbaar + status = één mail ──
  groep('Tickets — interne notitie, antwoord en status');
  let interneNotitie = null;

  await stap('een interne notitie maakt geen activiteit en geen mail', async () => {
    const res = await teamNotitie(w, w.medewerker, ticket.id, `Wachtwoord van de klant: ${geheim}`, true);
    gelijk(res.status, 201, `interne notitie: ${res.tekst}`);
    interneNotitie = res.json[0];
    gelijk(activiteit(ticket.id).length, 1, 'nog steeds alleen de "created"');
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantA).length, voor, 'geen mail over een interne notitie');
  });

  await stap('een zichtbaar antwoord en een statuswijziging komen samen in één mail', async () => {
    const res = await teamNotitie(w, w.medewerker, ticket.id, 'We kijken ernaar.\nGroet!', false);
    gelijk(res.status, 201, `zichtbare notitie: ${res.tekst}`);
    const status = await zetStatus(w, w.medewerker, ticket.id, 'review');
    gelijk(status.status, 200, `status: ${status.tekst}`);
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    const mails = nieuweMails(klantA, voor);
    gelijk(mails.length, 1, 'één mail voor antwoord en status samen');
    const mail = mails[0];
    verwacht(mail.subject.startsWith('Nieuw antwoord: '), `onderwerp: ${mail.subject}`);
    verwacht(mail.text.includes('We kijken ernaar.'), 'het antwoord staat in de mail');
    verwacht(mail.text.includes('In behandeling'), 'de nieuwe status staat in de mail');
    verwacht(!mail.html.includes(geheim) && !mail.text.includes(geheim), 'de interne notitie staat er niet in');
    verwacht(!mail.text.includes(w.medewerker.email) && !mail.html.includes(w.medewerker.email), 'het team ondertekent met de bedrijfsnaam, niet met het adres van het teamlid');
    verwacht(mail.text.includes('tickets Studio B.V.'), 'de bedrijfsnaam als afzender van het antwoord');
  });

  await stap('in het portaal: alleen het zichtbare antwoord en de statusregel', async () => {
    const draad = gelukt(await portaal(w.portaalA, { action: 'getTicketThread', ticketId: ticket.id }), 'ticket openen');
    gelijk(draad.notes.map((n) => n.body), ['We kijken ernaar.\nGroet!'], 'notities in het portaal');
    verwacht(!JSON.stringify(draad).includes(geheim), 'niets van de interne notitie in het antwoord');
    gelijk(draad.events.map((e) => `${e.old_status}->${e.new_status}`), ['new->review'], 'statusregels');
  });

  await stap('een interne notitie die zichtbaar wordt, gaat alsnog als antwoord', async () => {
    const res = await rest(`ticket_notes?id=eq.${interneNotitie.id}&organization_id=eq.${w.orgId}&select=id,is_internal`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { is_internal: false },
    });
    gelijk(res.status, 200, `zichtbaar maken: ${res.tekst}`);
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    const mails = nieuweMails(klantA, voor);
    gelijk(mails.length, 1, 'één mail');
    verwacht(mails[0].text.includes(geheim), 'nu staat het antwoord erin, want het is zichtbaar gemaakt');
    // Weer intern, voor de rest van het scenario.
    await rest(`ticket_notes?id=eq.${interneNotitie.id}&organization_id=eq.${w.orgId}`, {
      method: 'PATCH', token: w.medewerker.token, body: { is_internal: true },
    });
  });

  await stap('een antwoord dat vóór de ronde weer intern is, gaat nooit de deur uit', async () => {
    const res = await teamNotitie(w, w.medewerker, ticket.id, 'Per ongeluk zichtbaar', false);
    gelijk(res.status, 201, res.tekst);
    await rest(`ticket_notes?id=eq.${res.json[0].id}&organization_id=eq.${w.orgId}`, {
      method: 'PATCH', token: w.medewerker.token, body: { is_internal: true },
    });
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantA).length, voor, 'geen mail');
    const rij = sqlRij(`select notify_status, last_error from public.portal_ticket_activity where note_id = ${q(res.json[0].id)}`);
    gelijk(rij?.notify_status, 'skipped', 'overgeslagen');
  });

  // ── 3. De klant dient zelf een ticket in ───────────────────────────────
  groep('Tickets — de klant dient een ticket in via het portaal');
  let eigen = null;

  await stap('klant A dient een ticket in en krijgt een ontvangstbevestiging', async () => {
    const res = gelukt(await portaal(w.portaalA, {
      action: 'createTicket', clientId: w.klantA.id, title: 'Factuur klopt niet', description: 'Het btw-bedrag.', priority: 'high',
    }), 'ticket indienen');
    eigen = res.ticket;
    const rij = sqlRij(`select organization_id, client_id, status, priority, created_by_email from public.tickets where id = ${q(eigen.id)}`);
    gelijk([rij.organization_id, rij.client_id, rij.status, rij.priority, rij.created_by_email], [w.orgId, w.klantA.id, 'new', 'high', klantA], 'het ticket zoals het team het ziet');
    gelijk(activiteit(eigen.id).map((r) => `${r.kind}/${r.actor_type}`), ['created/client'], 'activiteit op naam van de klant');
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    const mails = nieuweMails(klantA, voor);
    gelijk(mails.length, 1, 'één bevestiging');
    verwacht(mails[0].subject.startsWith('Ticket ontvangen: Factuur klopt niet'), `onderwerp: ${mails[0].subject}`);
  });

  await stap('het team ziet het nieuwe ticket als ongelezen', async () => {
    const res = await rest(`ticket_unread?select=id&organization_id=eq.${w.orgId}`, { token: w.medewerker.token });
    gelijk(res.status, 200, res.tekst);
    verwacht(res.json.some((r) => r.id === eigen.id), 'het ticket van de klant staat bij ongelezen');
    gelijk((await rpc('mark_ticket_read', { p_ticket_id: eigen.id }, w.medewerker.token)).status, 204, 'gelezen markeren');
    const daarna = await rest(`ticket_unread?select=id&organization_id=eq.${w.orgId}`, { token: w.medewerker.token });
    verwacht(!daarna.json.some((r) => r.id === eigen.id), 'na openen niet meer ongelezen');
  });

  // ── 4. Afhandelen en heropenen ─────────────────────────────────────────
  groep('Tickets — afhandelen en weer openzetten');

  await stap('afhandelen zet de datum en mailt "Ticket afgehandeld"', async () => {
    const res = await zetStatus(w, w.medewerker, eigen.id, 'resolved');
    gelijk(res.status, 200, res.tekst);
    verwacht(res.json[0].resolved_at, 'resolved_at is gezet');
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    const mails = nieuweMails(klantA, voor);
    gelijk(mails.length, 1, 'één mail');
    verwacht(mails[0].subject.startsWith('Ticket afgehandeld: Factuur klopt niet'), `onderwerp: ${mails[0].subject}`);
  });

  await stap('reageert de klant, dan gaat het ticket weer open, zonder mail aan hemzelf', async () => {
    gelukt(await portaal(w.portaalA, { action: 'addTicketNote', ticketId: eigen.id, body: 'Bedankt, maar nog één vraag.' }), 'reageren');
    const rij = sqlRij(`select status, resolved_at from public.tickets where id = ${q(eigen.id)}`);
    gelijk([rij.status, rij.resolved_at], ['review', null], 'weer in behandeling');
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantA).length, voor, 'geen mail over je eigen reactie of de status die je zelf veroorzaakte');
    const res = await rest(`ticket_unread?select=id&organization_id=eq.${w.orgId}`, { token: w.medewerker.token });
    verwacht(res.json.some((r) => r.id === eigen.id), 'voor het team weer ongelezen');
  });

  // ── 5. Een contactpersoon met portaaltoegang ──────────────────────────
  groep('Tickets — een collega van de klant op hetzelfde portaal');
  const collegaEmail = `collega.${uniek('tickets')}@klant.test`.toLowerCase();
  let collega = null;

  await stap('een contactpersoon met portaaltoegang logt in', async () => {
    const res = await rest('client_contacts?select=id', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, client_id: w.klantA.id, name: 'Collega A', email: collegaEmail, gives_portal_access: true, is_active: true },
    });
    gelijk(res.status, 201, res.tekst);
    collega = await maakGebruiker('collega', collegaEmail);
    sql(`insert into public.portal_sessions (session_id, user_id, organization_id, host)
         values (${q(JSON.parse(Buffer.from(collega.token.split('.')[1], 'base64url').toString()).session_id)}, ${q(collega.id)}, null, null)
         on conflict (session_id) do nothing`);
    const data = gelukt(await portaal(collega, { action: 'getPortalData' }), 'portaal collega');
    gelijk(data.accounts.map((a) => a.client.id), [w.klantA.id], 'de collega ziet alleen klant A');
  });

  await stap('standaard krijgt de collega geen mail over tickets van een ander', async () => {
    const voor = mailsAan(collegaEmail).length;
    const voorA = mailsAan(klantA).length;
    gelijk((await teamNotitie(w, w.medewerker, ticket.id, 'Update voor iedereen', false)).status, 201, 'antwoord');
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(collegaEmail).length, voor, 'geen mail aan de collega (alleen eigen tickets)');
    gelijk(mailsAan(klantA).length, voorA + 1, 'wel aan het hoofdadres');
  });

  await stap('kiest de collega "alle tickets", dan krijgt hij ze wel; zijn eigen reactie mailt hem niet', async () => {
    gelukt(await portaal(collega, { action: 'updateNotificationSettings', clientId: w.klantA.id, settings: { scope: 'all' } }), 'instellen');
    const instellingen = gelukt(await portaal(collega, { action: 'getNotificationSettings', clientId: w.klantA.id }), 'lezen');
    gelijk(instellingen.settings.scope, 'all', 'opgeslagen');
    gelijk(instellingen.email, collegaEmail, 'de eigen instellingen, niet die van het hoofdadres');
    const voor = mailsAan(collegaEmail).length;
    const voorA = mailsAan(klantA).length;
    gelukt(await portaal(collega, { action: 'addTicketNote', ticketId: ticket.id, body: 'Ik zie het ook.' }), 'reactie collega');
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(collegaEmail).length, voor, 'geen mail over de eigen reactie');
    const aanA = nieuweMails(klantA, voorA);
    gelijk(aanA.length, 1, 'het hoofdadres krijgt de reactie van de collega');
    verwacht(aanA[0].text.includes('Ik zie het ook.'), 'met de tekst');
    const voor2 = mailsAan(collegaEmail).length;
    gelijk((await teamNotitie(w, w.medewerker, ticket.id, 'Antwoord aan allebei', false)).status, 201, 'antwoord');
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(collegaEmail).length, voor2 + 1, 'nu krijgt de collega het antwoord van het team');
  });

  // ── 6. Eigen keuzes en de schakelaar van de organisatie ────────────────
  groep('Tickets — meldingen uitzetten');

  await stap('zet klant A "Nieuw antwoord" uit, dan geen mail; in het portaal staat het wel', async () => {
    gelukt(await portaal(w.portaalA, { action: 'updateNotificationSettings', clientId: w.klantA.id, settings: { ticketReply: false } }), 'uitzetten');
    const voor = mailsAan(klantA).length;
    gelijk((await teamNotitie(w, w.medewerker, ticket.id, 'Stil antwoord', false)).status, 201, 'antwoord');
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantA).length, voor, 'geen mail');
    const draad = gelukt(await portaal(w.portaalA, { action: 'getTicketThread', ticketId: ticket.id }), 'ticket openen');
    verwacht(draad.notes.some((n) => n.body === 'Stil antwoord'), 'het antwoord staat in het portaal');
    gelukt(await portaal(w.portaalA, { action: 'updateNotificationSettings', clientId: w.klantA.id, settings: { ticketReply: true } }), 'weer aan');
  });

  await stap('een medewerker mag de schakelaar van de organisatie niet omzetten', async () => {
    nietsVeranderd(await rest('organization_portal_settings?select=*', {
      method: 'POST', token: w.medewerker.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, ticket_emails_enabled: false },
    }), 'medewerker zet klantmeldingen uit');
  });

  await stap('zet de eigenaar klantmeldingen uit, dan gaat er niets meer de deur uit', async () => {
    const res = await rest('organization_portal_settings?on_conflict=organization_id&select=*', {
      method: 'POST', token: w.eigenaar.token, prefer: 'resolution=merge-duplicates,return=representation',
      body: { organization_id: w.orgId, ticket_emails_enabled: false },
    });
    verwacht(res.status === 201 || res.status === 200, `uitzetten: ${res.tekst}`);
    gelijk((await zetStatus(w, w.medewerker, ticket.id, 'approved')).status, 200, 'status');
    const voor = mailsAan(klantA).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantA).length, voor, 'geen mail');
    const laatste = activiteit(ticket.id).at(-1);
    gelijk([laatste.kind, laatste.notify_status], ['status', 'skipped'], 'overgeslagen, met reden');
    verwacht(/uit/.test(laatste.last_error ?? ''), `reden: ${laatste.last_error}`);
    await rest(`organization_portal_settings?organization_id=eq.${w.orgId}`, {
      method: 'PATCH', token: w.eigenaar.token, body: { ticket_emails_enabled: true },
    });
  });

  // ── 7. Een harde bounce ────────────────────────────────────────────────
  groep('Tickets — een adres dat niet bestaat');

  await stap('na een harde bounce slaat de volgende melding dat adres over', async () => {
    const res = gelukt(await resendWebhook({
      type: 'email.bounced', created_at: new Date().toISOString(),
      data: {
        email_id: `re_${randomUUID()}`, to: [collegaEmail], subject: 'Nieuw antwoord',
        bounce: { type: 'Permanent', message: 'Mailbox bestaat niet' },
        tags: { organization_id: w.orgId, template_key: 'portal_ticket_update' },
      },
    }), 'webhook');
    verwacht(res, 'webhook verwerkt');
    const blok = sqlRij(`select reason, source from public.email_suppressions where organization_id = ${q(w.orgId)} and email = ${q(collegaEmail)}`);
    gelijk([blok?.reason, blok?.source], ['bounced', 'portal-notify'], 'op de suppressielijst');
    const voor = mailsAan(collegaEmail).length;
    const voorA = mailsAan(klantA).length;
    gelijk((await teamNotitie(w, w.medewerker, ticket.id, 'Na de bounce', false)).status, 201, 'antwoord');
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(collegaEmail).length, voor, 'geen mail naar het dode adres');
    gelijk(mailsAan(klantA).length, voorA + 1, 'het hoofdadres krijgt hem wel');
  });

  // ── 8. Wie mag wat ─────────────────────────────────────────────────────
  groep('Tickets — wie mag wat');

  await stap('een teamlid met zijn eigen adres als klant krijgt geen klantmail over tickets', async () => {
    // Zoals in het portaal (portal_clients_for_email): een actief teamlid is in
    // zijn eigen organisatie geen klant. Hier een lid zonder Tickets.
    const lid = await maakGebruiker('tickets-lid-als-klant');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access)
         values (${q(w.orgId)}, ${q(lid.id)}, ${q(lid.email)}, 'member', 'active', '{"tickets":"none"}'::jsonb)`);
    const klant = await rest('clients?select=id', {
      method: 'POST', token: lid.token, prefer: 'return=representation',
      body: { organization_id: w.orgId, name: uniek('Klant met teamadres'), email: lid.email, client_kind: 'business' },
    });
    gelijk(klant.status, 201, `klant met het eigen adres: ${klant.tekst}`);
    const nieuw = await teamTicket(w, w.medewerker, { client_id: klant.json[0].id, title: 'Ticket voor de klant met teamadres' });
    gelijk(nieuw.status, 201, nieuw.tekst);
    gelijk((await teamNotitie(w, w.medewerker, nieuw.json[0].id, 'Zichtbaar antwoord', false)).status, 201, 'antwoord');
    const voor = mailsAan(lid.email).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(lid.email).length, voor, 'geen mail aan het teamlid');
    gelijk(activiteit(nieuw.json[0].id).map((r) => `${r.kind}/${r.notify_status}/${r.notified_emails.length}`), ['created/done/0', 'reply/done/0'], 'verwerkt, niemand gemaild');
  });

  await stap('klant B kan het ticket van klant A niet openen, beantwoorden of er een indienen', async () => {
    geweigerd(await portaal(w.portaalB, { action: 'getTicketThread', ticketId: ticket.id }), 'openen', [403, 404]);
    geweigerd(await portaal(w.portaalB, { action: 'addTicketNote', ticketId: ticket.id, body: 'Ingebroken' }), 'beantwoorden', [403, 404]);
    geweigerd(await portaal(w.portaalB, { action: 'createTicket', clientId: w.klantA.id, title: 'Namens A' }), 'indienen voor A', [403, 404]);
    geweigerd(await portaal(w.portaalB, { action: 'getNotificationSettings', clientId: w.klantA.id }), 'instellingen van A', [403, 404]);
    const n = sqlRij(`select count(*)::int as n from public.ticket_notes where ticket_id = ${q(ticket.id)} and body = 'Ingebroken'`);
    gelijk(n.n, 0, 'geen notitie van klant B');
    const data = gelukt(await portaal(w.portaalB, { action: 'getPortalData' }), 'portaal B');
    verwacht(!JSON.stringify(data).includes(ticket.id), 'het ticket van A staat niet in het portaal van B');
  });

  await stap('een andere organisatie ziet of verandert het ticket niet', async () => {
    if (!ander) throw new Error('tweede organisatie ontbreekt');
    const lezen = await rest(`tickets?id=eq.${ticket.id}&select=id`, { token: ander.eigenaar.token });
    gelijk(lezen.json, [], 'lezen');
    nietsVeranderd(await rest(`tickets?id=eq.${ticket.id}`, {
      method: 'PATCH', token: ander.eigenaar.token, prefer: 'return=representation', body: { status: 'rejected' },
    }), 'wijzigen');
    const notities = await rest(`ticket_notes?ticket_id=eq.${ticket.id}&select=id`, { token: ander.eigenaar.token });
    gelijk(notities.json, [], 'notities lezen');
    const insert = await rest('ticket_notes', {
      method: 'POST', token: ander.eigenaar.token,
      body: { organization_id: w.orgId, ticket_id: ticket.id, created_by: ander.eigenaar.id, body: 'Van buiten', is_internal: false },
    });
    verwacht(insert.status >= 400, `notitie in een andere organisatie: ${insert.status}`);
    const ophangen = await rest('ticket_notes', {
      method: 'POST', token: ander.eigenaar.token,
      body: { organization_id: ander.orgId, ticket_id: ticket.id, created_by: ander.eigenaar.id, body: 'Aan een vreemd ticket', is_internal: false },
    });
    verwacht(ophangen.status >= 400, `notitie in de eigen organisatie aan het ticket van een ander: ${ophangen.status}`);
  });

  await stap('kijker, boekhouder en anon: niets schrijven, boekhouder en anon niets lezen', async () => {
    const kijker = await teamTicket(w, w.kijker, { client_id: w.klantA.id, title: 'Van de kijker' });
    verwacht(kijker.status >= 400, `kijker maakt een ticket: ${kijker.status}`);
    const boek = await rest(`tickets?organization_id=eq.${w.orgId}&select=id`, { token: w.boekhouder.token });
    gelijk(boek.json ?? [], [], 'de boekhouder leest geen tickets');
    const anon = await rest(`tickets?select=id`, {});
    verwacht(anon.status >= 400 || (Array.isArray(anon.json) && anon.json.length === 0), `anon: ${anon.status}`);
  });

  await stap('een lid zonder Tickets ziet niets; met alleen lezen schrijft het niets', async () => {
    const zonder = await maakGebruiker('tickets-zonder');
    const lezer = await maakGebruiker('tickets-lezer');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
         (${q(w.orgId)}, ${q(zonder.id)}, ${q(zonder.email)}, 'member', 'active', '{"tickets":"none"}'::jsonb),
         (${q(w.orgId)}, ${q(lezer.id)}, ${q(lezer.email)}, 'member', 'active', '{"tickets":"read"}'::jsonb)`);
    gelijk((await rest(`tickets?organization_id=eq.${w.orgId}&select=id`, { token: zonder.token })).json, [], 'geen tickets');
    gelijk((await rest(`ticket_notes?organization_id=eq.${w.orgId}&select=id`, { token: zonder.token })).json, [], 'geen notities');
    gelijk((await rest(`ticket_unread?organization_id=eq.${w.orgId}&select=id`, { token: zonder.token })).json, [], 'geen ongelezen');
    const leest = await rest(`tickets?organization_id=eq.${w.orgId}&select=id`, { token: lezer.token });
    verwacht(leest.json.length >= 2, 'de lezer ziet de tickets');
    nietsVeranderd(await rest(`tickets?id=eq.${ticket.id}`, {
      method: 'PATCH', token: lezer.token, prefer: 'return=representation', body: { status: 'rejected' },
    }), 'de lezer wijzigt de status');
    const notitie = await teamNotitie(w, lezer, ticket.id, 'Van de lezer', false);
    verwacht(notitie.status >= 400, `de lezer plaatst een notitie: ${notitie.status}`);
  });

  // ── 9. Wie wat schreef ligt vast (20261110100000) ─────────────────────
  groep('Tickets — wie wat schreef ligt vast');

  await stap('een teamlid plaatst geen bericht namens de klant of een collega', async () => {
    const contact = sqlRij(`select id from public.client_contacts where organization_id = ${q(w.orgId)} and email = ${q(collegaEmail)}`);
    const namens = await rest('ticket_notes', {
      method: 'POST', token: w.medewerker.token,
      body: {
        organization_id: w.orgId, ticket_id: ticket.id, created_by: w.medewerker.id,
        author_type: 'client', author_client_contact_id: contact?.id ?? null, author_name: 'Collega A',
        body: 'Namens de klant', is_internal: false,
      },
    });
    verwacht(namens.status >= 400, `namens de klant: ${namens.status} ${namens.tekst}`);
    const collega2 = await rest('ticket_notes', {
      method: 'POST', token: w.medewerker.token,
      body: {
        organization_id: w.orgId, ticket_id: ticket.id, created_by: w.medewerker.id,
        author_type: 'user', author_user_id: w.beheerder.id, body: 'Namens de beheerder', is_internal: true,
      },
    });
    verwacht(collega2.status >= 400, `namens een collega: ${collega2.status} ${collega2.tekst}`);
    gelijk(sqlRij(`select count(*)::int as n from public.ticket_notes where ticket_id = ${q(ticket.id)} and body in ('Namens de klant', 'Namens de beheerder')`).n, 0, 'notities namens een ander');
  });

  await stap('een klantbericht herschrijf je niet; de zichtbaarheid van je eigen notitie wijzigen kan wel', async () => {
    const klantNotitie = sqlRij(`select id, body from public.ticket_notes where ticket_id = ${q(ticket.id)} and author_type = 'client' order by created_at limit 1`);
    verwacht(klantNotitie, 'er is een bericht van de klant');
    const herschrijven = await rest(`ticket_notes?id=eq.${klantNotitie.id}`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { body: 'Herschreven door het team' },
    });
    verwacht(herschrijven.status >= 400, `herschrijven: ${herschrijven.status} ${herschrijven.tekst}`);
    const omzetten = await rest(`ticket_notes?id=eq.${klantNotitie.id}`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { author_type: 'user', is_internal: true },
    });
    verwacht(omzetten.status >= 400, `omzetten naar een interne teamnotitie: ${omzetten.status} ${omzetten.tekst}`);
    gelijk(sqlRij(`select body, author_type, is_internal from public.ticket_notes where id = ${q(klantNotitie.id)}`), { body: klantNotitie.body, author_type: 'client', is_internal: false }, 'het klantbericht is onveranderd');
    const eigen = await teamNotitie(w, w.medewerker, ticket.id, 'Eigen interne notitie', true);
    gelijk(eigen.status, 201, eigen.tekst);
    const zichtbaar = await rest(`ticket_notes?id=eq.${eigen.json[0].id}&select=is_internal`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { is_internal: false },
    });
    gelijk([zichtbaar.status, zichtbaar.json?.[0]?.is_internal], [200, false], 'zichtbaar maken mag');
    await rest(`ticket_notes?id=eq.${eigen.json[0].id}`, { method: 'PATCH', token: w.medewerker.token, body: { is_internal: true } });
  });

  await stap('een ticket van het team is van het teamlid, ook als hij een indiener meestuurt', async () => {
    const voor = mailsAan(klantA).length;
    const res = await teamTicket(w, w.medewerker, {
      client_id: w.klantA.id, title: 'Alsof de klant het indiende', created_by: w.beheerder.id,
      created_by_email: klantA, created_by_name: 'Klant A', created_by_contact_id: null,
    });
    gelijk(res.status, 201, res.tekst);
    const rijDb = sqlRij(`select created_by, created_by_email, created_by_name from public.tickets where id = ${q(res.json[0].id)}`);
    gelijk(rijDb, { created_by: w.medewerker.id, created_by_email: null, created_by_name: null }, 'de indiener in de database');
    gelijk(activiteit(res.json[0].id).map((r) => r.actor_type), ['staff'], 'op naam van het team');
    const wijzig = await rest(`tickets?id=eq.${eigen.id}&select=created_by_email`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { created_by_email: 'ander@klant.test' },
    });
    gelijk(wijzig.json?.[0]?.created_by_email, klantA, 'de indiener van een portaalticket verandert niet');
    gelukt(await mailronde(), 'mailronde');
    const mails = nieuweMails(klantA, voor);
    verwacht(mails.every((m) => !m.subject.startsWith('Ticket ontvangen')), 'een ontvangstbevestiging voor een ticket dat de klant niet indiende');
  });

  await stap('pushmeldingen over tickets alleen voor wie Tickets mag lezen', async () => {
    const zonder = await maakGebruiker('tickets-push-zonder');
    const met = await maakGebruiker('tickets-push-met');
    sql(`insert into public.organization_members (organization_id, user_id, email, role, status, module_access) values
         (${q(w.orgId)}, ${q(zonder.id)}, ${q(zonder.email)}, 'member', 'active', '{"tickets":"none"}'::jsonb),
         (${q(w.orgId)}, ${q(met.id)}, ${q(met.email)}, 'member', 'active', '{"tickets":"read"}'::jsonb)`);
    for (const lid of [zonder, met]) {
      sql(`insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth)
           values (${q(w.orgId)}, ${q(lid.id)}, ${q(`https://push.stromen.test/${lid.id}`)}, 'p256dh', 'auth')`);
    }
    gelukt(await portaal(w.portaalA, { action: 'createTicket', clientId: w.klantA.id, title: 'Voor de push' }), 'ticket indienen');
    gelukt(await portaal(w.portaalA, { action: 'addTicketNote', ticketId: ticket.id, body: 'Nog een vraag voor de push' }), 'reageren');
    const meldingen = (lid) => sqlRijen(`select event_type from public.notification_outbox where organization_id = ${q(w.orgId)} and recipient_user_id = ${q(lid.id)} order by created_at`).map((r) => r.event_type);
    gelijk(meldingen(zonder), [], 'push voor het lid zonder Tickets');
    gelijk(meldingen(met), ['ticket_new', 'ticket_note_client'], 'push voor het lid met leesrecht');
  });

  // ── 10. Een klant op inactief: geen tickets meer ──────────────────────
  // Keuze van de eigenaar (10 november): een klant op inactief hoeft niet meer
  // bij de tickets. Facturen en berichten blijven.
  groep('Tickets — een klant op inactief');
  let ticketB = null;

  await stap('een wachtende melding gaat niet meer uit zodra de klant op inactief staat', async () => {
    const res = await teamTicket(w, w.medewerker, { client_id: w.klantB.id, title: 'Voor klant B' });
    gelijk(res.status, 201, res.tekst);
    ticketB = res.json[0];
    const inactief = await rest(`clients?id=eq.${w.klantB.id}&select=status`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { status: 'inactive' },
    });
    gelijk(inactief.json?.[0]?.status, 'inactive', `klant B op inactief: ${inactief.tekst}`);
    const voor = mailsAan(klantB).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantB).length, voor, 'geen mail aan de inactieve klant');
    const rij = activiteit(ticketB.id)[0];
    gelijk(rij.notify_status, 'skipped', 'overgeslagen');
    verwacht(/inactief/.test(rij.last_error ?? ''), `reden: ${rij.last_error}`);
  });

  await stap('in het portaal: geen tickets, en indienen, openen of reageren wordt geweigerd', async () => {
    const data = gelukt(await portaal(w.portaalB, { action: 'getPortalData' }), 'portaal B');
    const dossier = data.accounts.find((a) => a.client.id === w.klantB.id);
    gelijk([dossier?.ticketsOpen, dossier?.tickets.length], [false, 0], 'tickets in het dossier');
    verwacht(!JSON.stringify(data).includes(ticketB.id), 'het ticket staat niet in het antwoord');
    const nieuw = geweigerd(await portaal(w.portaalB, { action: 'createTicket', clientId: w.klantB.id, title: 'Toch nog iets' }), 'indienen', [403]);
    verwacht(/niet meer open/.test(nieuw?.error ?? ''), `melding: ${nieuw?.error}`);
    geweigerd(await portaal(w.portaalB, { action: 'getTicketThread', ticketId: ticketB.id }), 'openen', [403]);
    geweigerd(await portaal(w.portaalB, { action: 'addTicketNote', ticketId: ticketB.id, body: 'Hallo?' }), 'reageren', [403]);
    gelijk(sqlRij(`select count(*)::int as n from public.tickets where client_id = ${q(w.klantB.id)}`).n, 1, 'geen nieuw ticket');
    gelijk(sqlRij(`select count(*)::int as n from public.ticket_notes where ticket_id = ${q(ticketB.id)}`).n, 0, 'geen reactie');
    const instellingen = gelukt(await portaal(w.portaalB, { action: 'getNotificationSettings', clientId: w.klantB.id }), 'instellingen');
    gelijk(instellingen.ticketsOpen, false, 'de instellingen weten het ook');
  });

  await stap('een antwoord van het team op het ticket van een inactieve klant: geen mail', async () => {
    gelijk((await teamNotitie(w, w.medewerker, ticketB.id, 'Antwoord aan een inactieve klant', false)).status, 201, 'antwoord');
    const voor = mailsAan(klantB).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantB).length, voor, 'geen mail');
    gelijk(activiteit(ticketB.id).at(-1).notify_status, 'skipped', 'overgeslagen');
  });

  await stap('weer actief: de tickets staan er weer, zonder een stapel oude mails', async () => {
    const actief = await rest(`clients?id=eq.${w.klantB.id}&select=status`, {
      method: 'PATCH', token: w.medewerker.token, prefer: 'return=representation', body: { status: 'active' },
    });
    gelijk(actief.json?.[0]?.status, 'active', actief.tekst);
    const draad = gelukt(await portaal(w.portaalB, { action: 'getTicketThread', ticketId: ticketB.id }), 'openen');
    gelijk(draad.notes.map((n) => n.body), ['Antwoord aan een inactieve klant'], 'het antwoord staat er');
    const data = gelukt(await portaal(w.portaalB, { action: 'getPortalData' }), 'portaal B');
    const dossier = data.accounts.find((a) => a.client.id === w.klantB.id);
    gelijk([dossier?.ticketsOpen, dossier?.tickets.map((t) => t.id)], [true, [ticketB.id]], 'tickets in het dossier');
    const voor = mailsAan(klantB).length;
    gelukt(await mailronde(), 'mailronde');
    gelijk(mailsAan(klantB).length, voor, 'geen oude meldingen');
  });

  // ── 11. Remmen: een klant maakt het mailquotum van het team niet op ─────
  groep('Tickets — remmen');
  const rem = await stap('een eigen organisatie voor de remmen', () => maakWereld('tickets-rem'));

  await stap('mail die klanten zelf veroorzaken heeft een eigen rem; het team mailt gewoon door', async () => {
    if (!rem) throw new Error('organisatie ontbreekt');
    const email = rem.klantA.email.toLowerCase();
    const ids = [];
    for (let i = 1; i <= 7; i += 1) {
      const res = gelukt(await portaal(rem.portaalA, { action: 'createTicket', clientId: rem.klantA.id, title: `Vraag ${i}` }), `ticket ${i}`);
      ids.push(res.ticket.id);
    }
    const team = await teamTicket(rem, rem.medewerker, { client_id: rem.klantA.id, title: 'Van het team' });
    gelijk(team.status, 201, team.tekst);
    const voor = mailsAan(email).length;
    const uit = gelukt(await mailronde(), 'mailronde');
    const mails = nieuweMails(email, voor);
    gelijk(mails.filter((m) => m.subject.startsWith('Ticket ontvangen')).length, 6, 'ontvangstbevestigingen binnen de rem (6)');
    gelijk(mails.filter((m) => m.subject.startsWith('Nieuw ticket: Van het team')).length, 1, 'de mail van het team gaat gewoon');
    verwacht(uit.deferred >= 1, `de ronde meldt wat wacht: ${JSON.stringify(uit)}`);
    const wachtend = sqlRijen(`select notify_status, attempts, last_error from public.portal_ticket_activity
                                where ticket_id in (${ids.map(q).join(', ')}) and notify_status <> 'done'`);
    gelijk(wachtend.length, 1, 'één melding wacht');
    gelijk([wachtend[0].notify_status, wachtend[0].attempts], ['queued', 0], 'wacht zonder dat het een poging telt');
    verwacht(/rem/.test(wachtend[0].last_error ?? ''), `reden: ${wachtend[0].last_error}`);
    gelijk(sqlRij(`select coalesce(sum(sent), 0)::int as n from public.email_send_counters where organization_id = ${q(rem.orgId)}`).n, 1, 'alleen de mail van het team telt in het quotum');
  });

  await stap('tickets tegelijk indienen: de rem van tien per tien minuten houdt', async () => {
    if (!rem) throw new Error('organisatie ontbreekt');
    const pogingen = await Promise.all(Array.from({ length: 15 }, (_, i) =>
      portaal(rem.portaalB, { action: 'createTicket', clientId: rem.klantB.id, title: `Tegelijk ${i + 1}` })));
    const statussen = pogingen.map((r) => r.status);
    const doorgelaten = statussen.filter((s) => s === 200).length;
    const geremd = statussen.filter((s) => s === 429).length;
    const inDatabase = sqlRij(`select count(*)::int as n from public.tickets where client_id = ${q(rem.klantB.id)}`).n;
    // Wat telt: hooguit tien tickets, en de rest geremd. Zonder de rem in één
    // keer (assertPortalBurst) kwamen er hier vijftien door. Een 5xx is de
    // lokale gateway die onder deze druk soms hapert ("invalid response from
    // the upstream server"); een andere weigering dan 429 hoort er niet bij.
    verwacht(inDatabase <= 10, `${inDatabase} tickets in de database`);
    verwacht(doorgelaten <= 10 && geremd >= 1, `statussen: ${statussen.join(',')}`);
    verwacht(statussen.every((s) => s === 200 || s === 429 || s >= 500), `onverwachte status: ${statussen.join(',')}`);
  });

  await stap('alle mails van dit scenario gingen alleen naar adressen van klant A', async () => {
    const vreemd = post.mails
      .filter((m) => m.tags?.some((t) => t.name === 'organization_id' && t.value === w.orgId))
      .flatMap((m) => m.to.map((adres) => adres.toLowerCase()))
      .filter((adres) => adres !== klantA && adres !== collegaEmail);
    gelijk(vreemd, [], 'mails naar andere adressen');
  });
}
