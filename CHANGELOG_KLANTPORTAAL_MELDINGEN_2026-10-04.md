# Changelog — Klantportaal: e-mailmeldingen, eigen instellingen en Berichten — 2026-10-04

Een klant die in het portaal een ticket indiende, hoorde daarna niets meer tot er zelf weer
gekeken werd. En de mail die het team met een klant wisselde, stond wel in het klantdossier en
op de pagina Berichten, maar nergens in het portaal. Drie dingen zijn daarom veranderd.

## 1 · E-mailmeldingen over tickets

- **Wanneer:** een **nieuw ticket** (een ontvangstbevestiging als de klant er zelf een indient,
  en een bericht als het team er een voor de klant aanmaakt), een **statuswijziging**
  ("Ticket in behandeling genomen: …") en een **nieuw antwoord** — een notitie die zichtbaar is
  voor de klant, ook als een interne notitie later zichtbaar wordt gemaakt. Een reactie van een
  collega bij dezelfde klant telt ook; wie iets zelf deed krijgt er geen mail over.
- **Gebundeld:** wat binnen een halve minuut op één ticket gebeurt (een antwoord én een
  statuswijziging) komt in één mail. Een status die per saldo terug is (nieuw → in behandeling →
  nieuw) is geen nieuws; een antwoord dat vóór het versturen weer intern of verwijderd is, gaat
  nooit de deur uit.
- **De mail** staat in de huisstijl van de leverancier (merkkleur, bedrijfsnaam, afsluittekst),
  gaat vanaf het eigen verzenddomein als dat er is, met het bedrijfsadres als Reply-To. Het
  antwoord staat erin (platte tekst, lange stukken afgekapt), het team ondertekent met de
  bedrijfsnaam (nooit het e-mailadres van een teamlid). De knop opent **direct het ticket** in
  het portaal; onderaan staat **"Meldingen beheren"**.
- **Deeplink, ook vóór het inloggen:** `/portal?dossier=…&ticket=…` kiest het juiste dossier en
  opent het ticket. Moet de klant eerst inloggen, dan onthoudt het portaal de link (twee uur, op
  dit apparaat) en gaat na de magische inloglink alsnog naar het ticket. Ook
  `?view=instellingen` en `?view=berichten` werken.
- **Niet bij:** adressen die gebounced zijn of een spamklacht gaven (de suppressielijst met
  reden *bounced*/*complained*; een afmelding voor marketing telt hier niet), en gebeurtenissen
  die ouder zijn dan 48 uur als de dienst ze oppakt.

## 2 · Instellingen in het portaal

- Knop **Instellingen** rechtsboven in het portaal (op de telefoon het tandwiel). Per dossier,
  per persoon — wat een collega op hetzelfde portaal kiest, staat los van het eigen.
- **Drie schakelaars:** Nieuw ticket, Statuswijziging, Nieuw antwoord. Elke wijziging wordt
  meteen opgeslagen.
- **Over welke tickets:** *alle tickets van [klant]* of *alleen tickets die ik zelf heb
  ingediend*. Standaard: het hoofdadres van de klant krijgt alles, een extra contactpersoon
  alleen meldingen over de eigen ingediende tickets. Zo krijgt bijvoorbeeld de
  boekhouder die alleen facturen komt betalen geen ticketmail, en de eigenaar van het dossier
  wel.
- Zet de leverancier klantmeldingen uit, dan zegt het portaal dat eerlijk; de keuzes blijven
  bewaard.

## 3 · Berichten in het portaal

- **Nieuwe tab Berichten**: de mailgesprekken met de leverancier en de tickets door elkaar,
  laatste activiteit bovenaan — zoals de pagina Berichten van het team. Per regel het onderwerp,
  wie het laatst iets zei ("Studio Lopik: …", "Jij: …"), de tijd, bij een ticket de status, en
  een **stip** als er iets nieuws van de leverancier is.
- **Een gesprek openen** toont de berichten als chat: de leverancier links, de klant rechts, met
  tijd en "per e-mail" of "via het portaal". Opmaak van de leverancier blijft staan (gesaneerd);
  wat de klant mailde wordt platte tekst, en de **geciteerde eerdere mail** eronder is ingeklapt
  (Gmail, Outlook en `>`-regels) met "Eerdere berichten tonen".
- **Antwoorden en een nieuw bericht** kan in het portaal. Dat wordt een inkomend bericht in het
  klantdossier, in hetzelfde gesprek — precies alsof de klant had gemaild: het team krijgt de
  bestaande melding, de teller op Berichten loopt op, Gerrie ziet het in de beslislijst. In het
  bericht staat "Geschreven in het klantportaal". Hooguit 20 berichten per 10 minuten per persoon
  (en 10 tickets en 30 reacties op tickets: die gaan ook per mail naar collega's op het portaal).
- **Ieder ziet het eigen gesprek.** Op één portaal kunnen meer mensen van een klant inloggen (het
  hoofdadres en contactpersonen met portaaltoegang, bv. de boekhouding). Elk van hen ziet alleen:
  wat die persoon zelf stuurde, wat het team die persoon stuurde, en wat het team daarna
  antwoordde in een gesprek waar die persoon aan meedeed (vanaf het eigen eerste bericht). Het
  team mailt altijd naar het hoofdadres; zo ziet een contactpersoon die iets vroeg toch het
  antwoord, maar nooit de mailgeschiedenis van het hoofdadres of van een collega.
- **Nooit in het portaal:** nieuwsbrieven of automatische stromen (het hele gesprek blijft weg,
  herkend aan de mail én aan de campagne- en stroomtabellen), post van een derde die het team uit
  de opvangbak aan het dossier koppelde, mail die een teamlid naar het doorstuuradres
  doorstuurde (als bijlage of inline: de tekst is dan de notitie van dat teamlid), mail die niet
  verstuurd is, en verwijderde berichten. Het onderwerp komt van het eerste bericht dat de klant
  wél ziet.
- **Tickets** ook netter: gesorteerd op laatste activiteit, met aantal reacties, "laatst …" en de
  stip met "Nieuw antwoord van …" — ook bij een interne notitie die later zichtbaar wordt gemaakt
  (dan telt het moment van zichtbaar maken). In het ticketgesprek staan **statuswijzigingen als
  regel** tussen de berichten (alleen die van de huidige klant). Ctrl/Cmd+Enter verstuurt.
- **Overzicht:** een kaart *Nieuw voor jou* met tickets die een nieuw antwoord hebben en nieuwe
  berichten; het telletje op de tabs Berichten en Tickets krijgt de merkkleur als er iets nieuws
  is. Openen = gelezen, meteen (ook vóór "Ververs").
- De tab **Galerijen** staat er alleen nog als er een galerij is (creatieve module).

## 4 · Voor het team

- **Instellingen → E-mail → Meldingen aan klanten:** één schakelaar om klantmeldingen voor de hele
  organisatie uit te zetten (owners/admins). Uit = geen ticketmail; het portaal toont alles nog.
- **Tickettijdlijn:** onder het schrijfvak staat bij een ticket van een klant dat een zichtbare
  notitie in het portaal komt én gemaild wordt (of, als het uitstaat, alleen in het portaal).
- **Berichten / klantdossier:** een bericht uit het portaal heeft het herkomstlabel *Geschreven in
  het klantportaal*. Beantwoorden gaat zoals altijd per mail naar het hoofdadres van de klant; in
  het portaal staat het antwoord in hetzelfde gesprek. Schreef een contactpersoon het bericht,
  dan zegt het label dat erbij: het antwoord komt niet in de mailbox van die contactpersoon, wel
  in het portaal.

## 5 · Onder de motorkap

- **Migratie `20261004000000_portal_notifications.sql`:**
  - `organization_portal_settings` (schakelaar per organisatie; lezen elk lid, wijzigen
    owner/admin), `portal_contact_settings` (keuzes per klant × e-mailadres), `portal_reads`
    (wat iemand al zag) — de laatste twee alleen via de service-role (`client-portal`).
  - `portal_ticket_activity`: wat er voor de klant zichtbaar met een ticket gebeurde
    (`created`/`status`/`reply`), tegelijk de wachtrij van de meldingsdienst en de bron van de
    statusregels in het portaal. Gevuld door drie triggers (ticket aangemaakt of aan een klant
    gekoppeld, status gewijzigd, zichtbare notitie of intern → zichtbaar), elk in een eigen
    exception-blok: een fout in het melden houdt het ticket nooit tegen. Eén melding per notitie
    (unieke index), ook als die vaker zichtbaar wordt gemaakt — behalve als de eerste nooit
    verstuurd is (overgeslagen omdat het antwoord bij het versturen weer intern was): dan telt
    opnieuw zichtbaar maken als nieuw.
  - `claim_portal_ticket_activity`: claimt alles van tickets waarvan de oudste wachtende
    gebeurtenis minstens 30 s oud is (`for update skip locked`), herstelt rijen die langer dan
    5 min in `sending` hangen, geeft het na 5 pogingen op.
  - `portal_ticket_overview` en `portal_client_message_overview`: lichte overzichten (aantallen,
    laatste regel, afgekapte preview) zodat het portaal geen volledige mailteksten hoeft te laden.
    Het berichtenoverzicht krijgt de adressen van de portaalgebruikers mee en filtert vóór de
    limiet (nieuwsbrieven duwen geen echte gesprekken uit de lijst); wie wat ziet, beslist
    `_shared/portalMessages.ts` per persoon.
  - Alle security-definer-functies dicht voor `anon`/`authenticated`.
  - **Openbare API:** een sleutel zonder `execute_high` mag de status van een ticket van een
    klant wijzigen (dat mocht al), maar dat levert geen mail aan de klant op: `api_rest_write`
    zet dan een markering voor de transactie, en `portal_ticket_activity_quiet` zet de
    activiteit meteen op `skipped`. In het portaal staat de nieuwe status gewoon. Een mail aan
    de klant blijft zo iets wat alleen met `execute_high` via de API kan, net als een reactie
    die de klant ziet.
- **Edge function `portal-notify`** (nieuw, `verify_jwt = false`): `POST ?cron=drain` met
  `x-cron-secret`. Bepaalt per ticket wie een mail krijgt (`_shared/portalNotify.ts`), controleert
  vlak voor het versturen opnieuw de organisatieschakelaar, het antwoord en de suppressielijst,
  verstuurt met een idempotency-sleutel per ontvanger, legt meteen na elke verzending per
  gebeurtenis vast wie hem kreeg (een nieuwe poging, ook na een fout of crash verderop, slaat die
  over), gaat rustig met de Resend-limiet om en schuift wat niet binnen 90 s lukt door naar de
  volgende minuut.
- **`resend-webhook`:** een harde bounce of spamklacht op zo'n melding (herkend aan de tags) zet
  het adres op de suppressielijst van de organisatie, zoals bij campagnes; de volgende melding
  slaat het dan over.
- **`client-portal`:** nieuwe acties `getNotificationSettings`, `updateNotificationSettings`,
  `getMessageThreads`, `getMessageThread`, `sendMessage`; `getPortalData` geeft per ticket de
  laatste activiteit en de stip mee, plus het aantal (nieuwe) gesprekken; `getTicketThread` geeft
  de statusregels mee en markeert als gelezen. Alles valt stil terug als de migratie er nog niet
  is: het portaal mag niet omvallen op een onderdeel dat nog niet is uitgerold.
- **Mailtemplate `portal.ticketUpdate`** in de bestaande registry (`_shared/emailTemplates`);
  alles wat van mensen komt wordt ge-escaped, het onderwerp blijft één regel.
- **Frontend:** `lib/portalConversations.ts` (gesprekkenlijst, deeplinks, citaten inkorten),
  `lib/portalApi.ts` (nieuwe aanroepen), `features/portal/ClientPortal.tsx` (tab Berichten,
  Instellingen, stippen, deeplinks), `components/TicketTimeline.tsx`, `ClientEmailMessage.tsx`,
  `SimplePages.tsx` (schakelaar), `lib/repository.ts`.
- **Tests:** `_shared/portalNotify.test.ts` (16), `_shared/portalMessages.test.ts` (8) en
  `lib/portalConversations.test.ts` (7) — `npm test` telt er nu 639. De mobiele lay-outtest
  meet ook Berichten en Instellingen in het portaal (geopend via de deeplink), en de mock heeft
  een ticket met een nieuw antwoord, zodat de stip en de kaart *Nieuw voor jou* meegemeten worden.
- **CI:** `portal-notify` staat in de Deno-typecheck. `scripts/supabase-setup-webhooks.sh` zet
  ook `PORTAL_NOTIFY_CRON_SECRET` en de taak `portal-notify-drain`; de rooktest controleert de
  dienst zodra die taak er is.

## Uitrol

1. Migratie `20261004000000_portal_notifications.sql` (gaat mee met *Deploy Supabase (staging)*).
2. Edge functions `client-portal` en `portal-notify` (idem).
3. Eenmalig per omgeving: de cron-taak en het secret — het vinkje *setup_webhooks* in de
   workflow, of `scripts/supabase-setup-webhooks.sh`, of met de hand volgens
   `KLANTPORTAAL_MELDINGEN_SETUP.md`. Zonder deze stap werkt alles in het portaal, maar gaan er
   geen meldingsmails uit (en vervallen ze na 48 uur).

## Wat níét verandert

De mail die het team een klant stuurt (Berichten, klantdossier) gaat zoals altijd naar het
hoofdadres van de klant. De pushmeldingen voor het team, de ticketpagina en het bewerkvenster
van een ticket werken zoals ze werkten. De e-mailteksten van deze melding zijn (nog) niet per
organisatie aan te passen.
