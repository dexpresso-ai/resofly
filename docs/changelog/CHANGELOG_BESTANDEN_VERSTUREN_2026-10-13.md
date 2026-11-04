# Changelog — Bestanden versturen — 2026-10-13

Bestanden naar een klant sturen kon tot nu toe alleen als bijlage bij een mail (met de
grens van de mailserver, zonder vervaldatum, zonder spoor) of door een map te **Delen…**
(live, dus wat je daarna in de map verandert, verandert ook bij de klant). Vanaf nu is er
een derde, eigen begrip: de **zending** — een bevroren pakket kopieën met een bericht en
een vervaldatum, aan de klant of een contactpersoon, met een logboek van wie wat wanneer
opende en downloadde. Achtergrond en afwegingen: `BESTANDEN_VERSTUREN_ONDERZOEK_2026-10-13.md`.
Uitrollen: `BESTANDEN_VERSTUREN_SETUP.md`.

## De regels

| Regel | Hoe hij bewaakt wordt |
|---|---|
| Klantgerelateerde bestanden gaan **alleen** naar het hoofdadres van die klant of een (actieve) contactpersoon van die klant. Een los e-mailadres kan alleen bij een zending die bij geen klant hoort. | trigger op `file_transfer_recipients` (de database vult het adres zelf in bij `client`/`contact`); de klant van een zending volgt uit de bestanden (`drive_item_client`) en kan daarna niet meer veranderen; alle items moeten bij dezelfde klant horen |
| Hoogstens **1 GB per bestand** (grote video's dus niet) | media-worker (upload en multipart), database-CHECK op `size_bytes`, en al in het venster |
| Nieuwe uploads komen **niet** in het klantdossier | ze staan alleen in `{org}/transfer/{zending}/` in R2 |
| Een **vervaldatum** (1 dag – 1 jaar, standaard 30 dagen); daarna is de data weg | pg_cron-taak `file-transfer-purge` elk kwartier; intrekken verwijdert meteen |
| Uploads tellen mee in de **opslag van het account** | `organization_storage_status` telt `transfers_bytes` mee in `used_bytes`; de worker toetst de ruimte vóór elke upload en kopie |

**"Na de vervaldatum verdwijnt ook de data"** is zo uitgelegd: de **bestanden** (de
kopieën in R2 en de tekst van meegestuurde notities/documenten) worden verwijderd; wat
blijft is het **bewijs** — wie wat kreeg, wanneer het verstuurd, geopend en gedownload
is. Wil je ook dat weg, dan verwijder je de zending (Gedeeld & verzonden → Verwijderen).

## Waar je het vindt

- **Inhoud** — ⋮ → **Versturen…** op een map, bestand, notitie of document; in de
  selectiebalk; en **+ Nieuw → Bestanden versturen…** voor uploads van je computer.
- **Klantdossier** — knop **Bestanden versturen** bovenaan; in Communicatie een
  ontvangerkeuze (hoofdadres of contactpersoon) en een paperclip onder het bericht.
- **Berichten** — dezelfde paperclip bij een antwoord en een nieuw bericht.
- **Tickets** — bestanden bij een antwoord dat zichtbaar is voor de klant (ticketvenster
  en Berichten); de klant ziet ze in het portaal onder dat antwoord.
- **Gedeeld & verzonden** (was "Gedeeld") — tabblad **Verzonden**: per zending de status,
  per ontvanger afgeleverd/geopend/gedownload, verlengen, intrekken (per persoon of
  alles), opnieuw mailen, iemand toevoegen, het logboek.
- **Gerrie / gekoppelde AI** — `files.list` (bestanden zoeken), `files.send` (risico
  hoog, met de adressen op de kaart), `files.list_transfers`, `files.extend_transfer`,
  `files.revoke_transfer`.
- **Instellingen** — e-mailtekst "Bestanden verstuurd" (Instellingen → E-mail),
  pushmelding "Verstuurde bestanden gedownload", en de opslagmeter noemt hoeveel er in
  verstuurde bestanden zit.

## Wat de ontvanger ziet

Een mail (eigen verzenddomein, Reply-To naar het klantgesprek) met een knop naar
`/ontvang/<token>`. Daar komt de ontvanger pas binnen met een **code van zes cijfers** die naar
het eigen adres gaat: tien minuten geldig, één keer bruikbaar, hoogstens vijf codes per
uur. Foute pogingen tellen over codes heen: vijf op één code = een kwartier dicht, tien in
24 uur = een dag dicht, twintig in totaal = de link gaat dicht tot je opnieuw verstuurt
(de afzender ziet dat als "Link dicht" bij de ontvanger). Daarna een sessie van een uur:
lijst met bestanden, downloaden per stuk of alles als zip, notities en documenten lezen op
de pagina. Wie al in het **klantportaal** is ingelogd met dat adres, hoeft geen code. De
naam van de ontvanger staat pas op de pagina na de code.

Downloadlinks zijn een kwartier geldig en gebonden aan de zending en de ontvanger: de
media-worker kijkt bij elke aanvraag of de zending nog loopt en de ontvanger niet is
ingetrokken. Intrekken of verlopen stopt dus ook een link die al uitgedeeld was.

In het portaal staan zendingen ook zelf: tab **Bestanden → Ontvangen**, onder het bericht
waarmee ze meekwamen, en onder het ticketantwoord.

## Toegevoegd

- **Migratie `20261013100000_file_transfers.sql`** (+ `20261013110000_file_transfers_accountant_fence.sql`:
  het boekhouder-hek op de drie interne tabellen; de rooktest na de eerste deploy ving dat ze
  het misten — ze waren al dicht, nu ook expliciet. `roles.test.ts` vangt zo'n vergeten tabel
  voortaan al vóór de deploy.)
  - `file_transfers`, `file_transfer_items`, `file_transfer_recipients`,
    `file_transfer_codes`, `file_transfer_sessions`, `file_transfer_events`,
    `storage_purge_queue`, met RLS (lezen voor de organisatie, modulepoort Inhoud);
    schrijven gaat alleen via de edge function.
  - Triggers: statusovergangen en vervaldatum, inhoud vast na versturen, klant van items
    gelijk aan die van de zending, ontvangerregel, tellers, opruimwachtrij, pushmelding bij
    de eerste download, activiteitenlog.
  - Service-role-functies voor token, code, sessie, logboek, portaaloverzicht en opruimen.
  - Delen kent nu ook het **hoofdadres** van de klant (`recipient_kind 'client'`).
  - `organization_storage_status` met `transfers_bytes`.
- **Edge functions** `file-transfer` (team: klaarzetten, uploaden, versturen, beheren,
  opruimtaak) en `file-transfer-public` (de ontvangstpagina).
- **Media-worker**: uploads en multipart naar `transfer/`, kopiëren uit Inhoud,
  ondertekende downloadlinks (15 minuten) en een zip die bij elke aanvraag opnieuw toetst
  of de zending nog loopt.
- **Frontend**: `SendFilesDialog`, `TransfersPanel`, `MessageFiles`, `PublicTransferPage`,
  `src/lib/transfers.ts` (+ tests), `src/lib/transfers-api.ts`, de Gerrie-uitvoerders in
  `src/lib/actions/files.ts`, CSS onder "Bestanden versturen" in `globals.css`.

## Gewijzigd

- `mail` — een klantmail kan naar een contactpersoon, en kan een concept-zending
  meenemen (blok met link onder de tekst, geen bijlage).
- `client-portal` — zendingen in Bestanden, bij berichten en bij ticketantwoorden.
- `file-share` / `file-share-public` / portaal — downloads van gedeelde bestanden gaan
  via een ondertekende link in plaats van base64 door de functie (grote bestanden lukten
  daardoor niet); base64 blijft als terugval.
- `resend-webhook` — afgeleverd / gebounced / klacht per ontvanger van een zending.
- `supabase/config.toml`, de CI (`deno check` voor beide nieuwe functies) en
  `scripts/supabase-setup-webhooks.sh` (stap 5: de opruimtaak).

## Nagelopen

Twee onafhankelijke beveiligingsreviews (de ontvangerskant en de teamkant + database)
leverden geen kritieke punten op; alles wat ze vonden is verwerkt:

- **Codes raden** — foute pogingen tellen over codes heen (zie hierboven). Een nieuwe code
  aanvragen zette de teller eerst terug.
- **Uitgedeelde downloadlinks** — gebonden aan zending en ontvanger en bij elke aanvraag
  getoetst; daarvoor werkte een link na intrekken van één persoon of na verlopen nog tot
  een kwartier.
- **Alleen bestanden uit Inhoud** — een bijlage van een taak, ticket of project kan niet
  mee (die hoort bij een module waar de verzender misschien niet bij mag). En een
  opslagsleutel moet bij precies dat ene item horen, uit Inhoud of een dossier: een rij in
  een map zonder klant die naar het bestand van een klant (of een factuur) wijst, gaat niet
  naar buiten. Dat geldt ook voor **Delen**, dat dit gat al had.
- **Opslag** — een upload in delen wordt bij het afronden opnieuw getoetst aan de
  aangekondigde grootte en aan de vrije ruimte; uploads en kopieën staan vooraf in de
  opruimwachtrij tot hun bestandsrij er is, zodat er nooit iets in R2 blijft dat nergens bij
  hoort; geen `..` meer in gegenereerde sleutels.
- **Rechten** — verlengen en verwijderen vragen ook Klanten-rechten; een verstuurde zending
  verwijderen (met het bewijs) mag alleen wie hem verstuurde of een beheerder; opnieuw
  mailen alleen naar een adres dat nu nog op de klantkaart staat; wie Klanten niet mag
  lezen, ziet ook geen klantzendingen (met contactpersonen en hun adressen).
- **Overig** — een bestand kan niet meer bij een zending komen terwijl die verstuurd wordt;
  een ticket dat naar een andere klant verhuist neemt de bestanden van de vorige klant niet
  mee; de naam van de ontvanger staat pas na de code op de pagina; een mapnaam kan in de
  zip geen pad buiten de map maken.

De migratie is in een echte Postgres (PGlite, met een nagebootste Supabase) twee keer
achter elkaar toegepast en daarna met 90 gedragscontroles doorgelopen: de klantregel, de
statusovergangen, de codes en blokkades, links, leesrechten per module, logboek en
pushmelding, opslagtelling en opruimen. De schermen zijn tegen de nagebootste backend van
de mobiele test gerenderd (desktop en telefoon) zonder JavaScript-fouten.

## Tests

`src/lib/transfers.test.ts`, `supabase/functions/_shared/fileTransfer.test.ts` (o.a. dat
de geblokkeerde extensies, de 1 GB-grens en de zip-padregel in worker, server en browser
gelijk zijn), pariteit van het mailsjabloon (`emailTemplateContent.test.ts`), de registry-,
tenancy- en kolomtests voor de nieuwe Gerrie-acties, en zoekgevallen in
`actionSearch.test.ts`.

## Bewust niet gebouwd

- **Virusscan** van uploads — vraagt een externe dienst (en een keuze waar de bestanden
  dan heen gaan). Uitvoerbare bestanden (`.exe`, `.js`, `.bat`, …) worden wel geweigerd.
- **Bestanden opvragen** (een klant die iets terug uploadt) — een eigen
  beveiligingsafweging (uploads van buiten, opslag op jouw account) en privacykeuzes.
- De melding over een ticketantwoord in de mail noemt de bestanden nog niet; ze staan wel
  in het portaal onder het antwoord.
