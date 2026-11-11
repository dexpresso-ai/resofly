# Klantportaal: de accountlead en wie het ticket oppakt — 11 november 2026

Vraag: *"Ik wil dat de accountleadnaam en de naam wie de ticket oppakt ook terugkomt in het
klantportaal."*

Vervolg op `CHANGELOG_ACCOUNTLEAD_TICKETTOEWIJZING_2026-11-11.md`. Daar stond nog: "De klant
ziet niet wie zijn ticket heeft". Dat is nu anders.

## Wat de klant nu ziet

- **Zijn vaste contactpersoon.** Op het overzicht van het portaal, in de kaart *Contact*, staat
  boven de bedrijfsgegevens: *Je vaste contactpersoon — Anna de Vries*. Dat is de accountlead
  van de klant.
- **Wie zijn ticket oppakt.**
  - In de ticketlijst en bovenaan een geopend ticket staat *Opgepakt door Anna de Vries*.
  - Heeft dat teamlid geen naam voor klanten, dan staat er *Opgepakt door* met de naam van het
    bedrijf. Zo weet de klant toch dat er iemand mee bezig is.
  - Zonder behandelaar staat er niets.
- Het voorbeeld van het portaal (Instellingen → Huisstijl) laat een verzonnen contactpersoon en
  behandelaar zien.

## Welke naam: de afzendernaam, nooit het e-mailadres

Er is geen profieltabel. In de app is de naam van een teamlid zijn inlogadres. Dat adres gaat
bewust niet naar het portaal: sinds de controle van 10 november toont het portaal bij een
antwoord van het team de bedrijfsnaam, en niet het adres van het teamlid (`sanitizeTicketNote`).
Een naam afleiden uit dat adres ("anna.devries@…" → "Anna") gaf het alsnog half prijs, en
gokte vaak mis.

Daarom de **afzendernaam** uit *Instellingen → E-mail → Persoonlijke afzender → Jouw
afzendernaam*:

- het teamlid koos die naam zelf, voor klanten;
- klanten zien hem al boven zijn mails.

Zonder afzendernaam:

- bij de accountlead: geen contactpersoon in het portaal;
- bij een ticket: de bedrijfsnaam.

Het portaal krijgt alleen de naam. Het user-id en het e-mailadres blijven op de server.

## In de app

- Onder *Accountlead* en *Toegewezen aan* in het formulier staat wat de klant te zien krijgt.
  Bijvoorbeeld *In het klantportaal: "Opgepakt door Anna de Vries"*.

  Heeft het teamlid nog geen afzendernaam, dan zegt de app dat, met de plek waar je die instelt.
  Zonder die regel zag je in de lijst "anna@bureau.nl", en wist je niet dat de klant "Anna de
  Vries" ziet, of niets.
- De goedkeurkaart van `ticket.assign` en `client.set_account_lead` zegt nu vooraan dat de klant
  de naam in het portaal ziet.
  - Bij een ticket alleen als het aan een klant hangt.
  - Vooraan, omdat de kaart na 170 tekens wordt afgekapt.
- Ook de beschrijvingen voor Gerrie, MCP en de API zeggen het nu.

## Techniek

- `client-portal`:
  - `teamNamesForPortal` zoekt de afzendernamen op, binnen de organisatie van de klant;
  - `buildAccount` geeft `accountLead: { name } | null`;
  - een ticket heeft `assigned` en `assignee_name`, in de lijst en in `getTicketThread`;
  - de accountlead komt met een eigen vraag uit `clients`, op organisatie en klant.
    `portal_clients_for_email` geeft die kolom niet.
- `src/lib/repository.ts`: `loadClientFacingNames`, één keer per organisatie. De cache gaat weg
  zodra je je eigen afzender wijzigt.
- Geen migratie: de afzendernamen bestonden al (`user_sender_identities`, leesbaar voor de
  organisatie).

## Getest

- `npm run typecheck` en `npm test`: 1581 tests groen. Nieuw in `actionHolders.test.ts`: de
  kaart noemt het portaal vooraan, en niet bij een ticket zonder klant.
- **Stromentest** `tickets` (`npm run test:stromen -- tickets`): 42 stappen, 0 fout. De echte
  `client-portal` tegen de lokale database. Drie stappen zijn nieuw:
  - opgepakt door een teamlid zonder afzendernaam: wel "opgepakt", geen naam;
  - met afzendernaam: de naam bij het ticket (lijst en geopend) en als vaste contactpersoon;
  - klant B ziet de contactpersoon van klant A niet.

  In alle drie staan het e-mailadres en het user-id van het teamlid nergens in het antwoord.
- `deno check` op de lijst uit `frontend-checks.yml`: schoon. `client-portal` ook, terwijl die niet
  in de CI-lijst staat. Gedraaid met dezelfde tijdelijke importmap als eerder vandaag: esm.sh en
  deno.land zijn vanuit de cloudsessie niet bereikbaar.
- Mobiele lay-outtest op de geraakte pagina's (portaal, portaaltickets, inactief portaal,
  portaalvoorbeeld, tickets, klanten, klantdossier), licht en donker, op alle formaten: 42
  metingen, 0 problemen. De nep-backend heeft nu een contactpersoon en tickets met en zonder
  naam.
- `npm run test:loading`: alle controles geslaagd.
