# Stromen-test: offertes, facturen, herinneringen en contracten end-to-end

Draait de **echte edge functions** (`supabase/functions/<naam>/index.ts`) in Node tegen een
lokale Supabase-stack: echte gebruikers (GoTrue), echte rechten (PostgREST met RLS), de echte
database met alle migraties. Alleen wat buiten Supabase ligt is nep (`nepdiensten.mjs`):

- **Resend**: elke mail wordt vastgelegd (aan wie, onderwerp, tekst, bijlagen) in plaats van verstuurd;
- **Mollie**: betalingen, terugbetalingen en de webhook zoals Mollie ze doet, per API-sleutel;
- **de media-worker**: R2-opslag van PDF's en de omzetting van Word naar PDF.

Waarom zo: de unittests toetsen losse functies, de database-scripts de database. Pas als de
functies, de database, de rechten en de mails samen draaien, zie je of een offerte écht van
concept tot factuur komt, of een herinnering naar het juiste adres gaat met het juiste bedrag,
en of een klant of collega nergens bij kan waar hij niet bij hoort.

## Draaien

```bash
# 1. De lokale stack (database, auth, REST, gateway)
npx supabase start -x studio,imgproxy,mailpit,logflare,vector,supavisor,edge-runtime,postgres-meta,realtime,storage-api

# 2. Drie pakketten die alleen de edge functions gebruiken (via esm.sh)
npm install --no-save xss@1.0.15 fast-xml-parser@4.5.0 ical.js@2.1.0

# 3. Alles, of één scenario
npm run test:stromen
npm run test:stromen -- facturen
```

Scenario's: `rook`, `offertes`, `facturen`, `mollie` (de eigen Mollie-koppeling: koppelen met
profiel, auditlog, een ander account met een open link, ontkoppelen, en een key die nog met de
ingebouwde sleutel was opgeslagen), `verzendwijze` (Instellingen → Online betalen: per e-mail
of via Mollie; wie kiest, en dat er per e-mail nergens een betaallink van Mollie of een
Mollie-factuur ontstaat: versturen, losse link, herinnering, klantportaal, een klant op "via
Mollie", en een factuur die Mollie al uitgaf), `herinneringen`, `contracten`, `beveiliging`,
`automatisering`, `agenda` (Google en Microsoft koppelen, met nep-Google en nep-Microsoft uit
`nep-agenda.mjs`), `videovergadering` (Google Meet en Teams: van de agenda en los met de eigen
koppeling, het aparte recht aan en uit, boekingen met Meet, en Gerrie via een echte MCP-koppeling; zie
`docs/changelog/CHANGELOG_GOOGLE_MEET_TEAMS_2026-11-08.md`), `documenten` (maken, rechten per rol en module, andere organisaties,
delen via portaal en link, opruimen) en `verzenddomein` (eigen domein koppelen, verifiëren,
versturen vanaf het eigen adres, de domein-webhook, verwijderen, en wie een domein mag
vasthouden; de nep-Resend kent daarvoor ook de Domains-API en verstuurt, net als Resend,
alleen vanaf een geverifieerd domein) en `bank` (mutaties met de hand invoeren, verdelen over
facturen, creditnota's, inkoopfacturen en grootboekrekeningen, terugdraaien, samenvoegen met wat de
bank later levert, de aansluiting en wie wat mag; zie
`docs/changelog/CHANGELOG_BANK_HANDMATIG_BOEKEN_2026-11-07.md`), `marketing` (een
campagne versturen terwijl de verzendronde midden in het klaarzetten valt, de ontvangerslijst
zoals het scherm hem laadt, tracking via de webhook, pauzeren en annuleren midden in een batch,
herstel na een omgevallen verzending, afmelden via de link en met één klik, wat het team wel en
niet van de afmeldlijst mag halen, wie welke klantgegevens ziet, en een follow-up-stroom; zie
`docs/rapporten/CONTROLE_MARKETING_2026-11-07.md`; dat scenario verstuurt in batches van vijf,
`CAMPAIGN_DISPATCH_BATCH` in `omgeving.mjs`) en `inrichten` (de inrichting van een
nieuwe organisatie: afronden alleen door de eigenaar of een beheerder van díe organisatie en met een
bedrijfsnaam, niet rechtstreeks, niet als teamlid, boekhouder, vreemde of anon, en geen eigen
organisatie voor wie is uitgenodigd; zie `docs/changelog/CHANGELOG_ORGANISATIE_INRICHTEN_2026-11-07.md`)
en `notulen`. Dat laatste gaat over opnames:
- uitschrijven en samenvatten, met nep-ElevenLabs en nep-Claude uit `nep-ai.mjs`;
- de synchrone route en de webhook-route, met echte en vervalste handtekeningen, een herhaalde
  webhook, een foutmelding en een webhook die eerder komt dan het `request_id`;
- het AI-budget: de transcriptie in `ai_usage`, tegoed op voor gebruiker of organisatie, een
  bewaarde opname die later alsnog gaat, en notulen die wachten;
- telefoongesprekken en wie wat mag.

Zie `docs/changelog/CHANGELOG_TRANSCRIPTIE_AI_BUDGET_2026-11-08.md`.

En `rapportages`: de rapportages met Gerrie (Statistieken → Rapportages), met een streamende
nep-Claude die tools aanroept zoals het echte model (in het scenario zelf; niet-streamende
aanvragen beantwoordt hij zoals `nep-ai.mjs`). Getoetst:
- een vraag wordt een pagina, met alleen lees-endpoints, exacte cijfers en alleen de eigen
  organisatie;
- versies, het gesprek en het verbruik in `ai_usage`, en verversen zonder verbruik;
- de rapportage is alleen van de maker, ook tegenover de eigenaar en de beheerder;
- schrijf-tools, een pagina met netwerkverkeer en een dataset die iets verstuurt worden geweigerd;
- rechten die later dichtgaan, tegoed op, en verwijderen.

Zie `docs/changelog/CHANGELOG_RAPPORTAGES_GERRIE_2026-11-09.md`.

En `boekingslinks`: de boekingslinks door `meeting-booking` en `meeting-booking-public`.
Getoetst:
- lezen met leesrecht op de Agenda, schrijven met schrijfrecht, en niets voor de boekhouder
  of een andere organisatie;
- de boekingspagina: huisstijl en contact, geen id's of hash naar de bezoeker, en alleen
  momenten die nog moeten beginnen;
- boeken, vol, annuleren, een mislukte boeking, en een poging die blijft hangen;
- een link van iemand die geen teamlid meer is, gesloten, verlopen en verlengen;
- mailen pas met vrije momenten, verwijderen met afspraken, en de rem per afzender.

Zie `docs/changelog/CHANGELOG_BOEKINGSLINKS_2026-11-10.md`.

En `tickets`: het team in de app, de klant in het portaal (`client-portal`) en de mailronde die
pg_cron elke minuut aanroept (`portal-notify`). Getoetst:
- een ticket van het team, een antwoord met een statuswijziging (één mail), afhandelen en
  een interne notitie die zichtbaar wordt: de klant krijgt de mail, met de link naar het
  ticket en zonder interne tekst;
- een ticket uit het portaal geeft een ontvangstbevestiging; een reactie op een afgehandeld
  ticket zet het weer open, zonder mail aan de klant zelf;
- een collega op hetzelfde portaal, de eigen keuzes, de schakelaar van de organisatie en een
  harde bounce;
- een klant op inactief: geen tickets in het portaal, indienen, openen en reageren geweigerd,
  geen mail, en weer actief zonder een stapel oude mails;
- wie wat mag: een andere klant, een andere organisatie, kijker, boekhouder, anon, een lid
  zonder of met alleen leesrecht op Tickets, en een teamlid met zijn eigen adres als klant.

Zie `docs/changelog/CHANGELOG_TICKETS_CONTROLE_2026-11-10.md`.

En `caldav`: de agendaserver (`workers/caldav`), de echte Worker in Node tegen de lokale stack,
met app-wachtwoorden en deellinks uit `calendar-integrations`. Getoetst:
- inloggen met een app-wachtwoord (fout, kruislings, overgetypt), `.well-known`, en welke agenda's
  je ziet: de eigen, wat het team deelt, niet de privé-agenda van een collega of een andere
  organisatie;
- een afspraak van de iPhone (met tijdzone en herinnering) in ResoFly en andersom, ETags,
  alleen de wijzigingen ophalen, een verwijdering, te groot, en meer dan 1000 afspraken;
- rechten: een collega in een gedeelde agenda, een kijker, de boekhouder, Agenda op "geen
  toegang", een ingetrokken wachtwoord;
- deellinks: "alleen bezet" en "titel, tijd en plaats" zonder omschrijving of genodigden, 304,
  een verzonnen token, alleen de eigen ResoFly-agenda, geen toegang tot de tabel, intrekken,
  Agenda dicht, vertrekken, en een verwijderde agenda.

Zie `docs/changelog/CHANGELOG_AGENDASERVER_DEELLINKS_2026-11-13.md`.

En `vooruitbetaald`: vooruitbetaalde kosten, een betaling die over de maanden naar de kosten gaat
(de functies uit migratie 20261111220000). Getoetst:
- € 1.000 verzekering over 36 maanden: het schema (28 × € 27,78 en 8 × € 27,77, op de laatste dag
  van elke maand), de rekening 1350 Vooruitbetaalde kosten die er één keer bij komt, de boeking naar
  de balans en de termijn van deze maand naar de kosten, nooit dubbel en niet verder vooruit dan het
  einde van deze maand;
- een post die al op de balans stond (de achterstand per maand op zijn eigen datum) en een factuur
  die al als kosten was geboekt (de kostenrekening als tegenrekening);
- wie wat mag: lezen met leesrecht, niets zonder Financiën of van een andere organisatie, en
  niemand schrijft rechtstreeks in de tabellen;
- vastliggen na boeken, tegenboeken in de goede volgorde (het register gaat mee terug),
  beëindigen met een terugbetaling, en daarna alles terug tot de post weg kan;
- een termijn in een afgesloten boekjaar op de eerste open dag, en niets van vóór de start van de
  boekhouding in ResoFly.

Zie `docs/changelog/CHANGELOG_VOORUITBETAALDE_KOSTEN_2026-11-11.md`.

`wereld.mjs` rondt de inrichting van zijn organisaties zelf af, net als de knop in de app; anders bleef
de UI-test in de stappen staan. De uitkomst van de documenten staat in
`docs/rapporten/TESTRAPPORT_DOCUMENTEN_2026-11-06.md`. De uitkomst van 6 november staat in
`docs/rapporten/STROMENTEST_CONTRACT_OFFERTE_FACTUUR_2026-11-06.md`.
Elk scenario maakt zijn eigen organisaties (`wereld.mjs`), dus ze raken elkaar niet en de
database hoeft niet leeg.

**Let op met Postgres 17.6.1.111** (de versie van staging op 2026-11-05): daar laat een
geweigerde functieaanroep de database crashen, en het beveiligingsscenario doet zulke aanroepen
expres. Draai lokaal op 17.6.1.178 of nieuwer: zet `17.6.1.178` in
`supabase/.temp/postgres-version` vóór `supabase start` (en commit die wijziging niet).

## UI-test in de browser (`ui.mjs`)

Dezelfde stromen zoals een gebruiker ze doorloopt: de app (Vite) in Chromium, met klikken op
de echte knoppen en invullen van de echte formulieren. Waarom: hierboven worden de functies
rechtstreeks aangeroepen. Of een knop ook díe functie aanroept, en of de gebruiker daarna de
juiste uitkomst ziet, zie je pas als een browser klikt.

De browser praat met `ui-server.mjs`: `/functions/v1/<naam>` gaat naar de echte edge function in
het testproces (met de nepdiensten), al het andere ongewijzigd naar de gateway. De server houdt
bij welke functie of RPC er werd aangeroepen; de stappen controleren dat. Een klant opent de link
uit de vastgelegde mail in een eigen browser zonder sessie.

```bash
# stack en pakketten als hierboven; in een cloudsessie: RESOFLY_CHROMIUM=/opt/pw-browsers/chromium
node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs
node --enable-source-maps --import ./tests/stromen/register.mjs tests/stromen/ui.mjs offerte contract --schermafdrukken=/tmp/ui
```

Scenario's: `offerte` (formulier, ter goedkeuring, goedkeuren, versturen, akkoord van de klant,
factuur maken), `factuur` (versturen, publieke pagina, herinnering, crediteren), `intrekken`,
`contract` (versturen, ondertekenen, terug naar concept), `rollen` (kijker, lezer en boekhouder
zien geen knoppen die iets veranderen; de medewerker en de beheerder bij dezelfde stukken wel),
`agenda` (Google koppelen met de knop, terugkeer met fout, opnieuw koppelen, loskoppelen),
`mollie` (Instellingen → Online betalen: een geweigerde key met de echte reden in beeld, koppelen
met profiel en de waarschuwing voor de testmodus, kiezen tussen per e-mail en via Mollie,
ontkoppelen, wat een lid ziet) en
`documenten` (maken en bewerken in Inhoud, kwaadaardige inhoud in de app en op de deelpagina,
verwijderen, de kijker) en `bank` (een mutatie invoeren in het venster, de voorgestelde verdeling over
twee facturen aanvullen en boeken met een eigen omschrijving, terugdraaien, de vraag bij een dubbele
mutatie, samenvoegen met de bank en weer losmaken, en de verdeling op telefoonbreedte).

En `klantdomein`: het klantportaal op een eigen domein en op `<naam>.resofly.com`, zoals een klant
en de eigenaar het doen. Een eigen domein bestaat hier niet echt: Chromium vraagt
`https://portaal.<ronde>.nl/…` op, en de test antwoordt zoals de Worker van de klantadressen,
met diens eigen beslisregels (`workers/client-domains/src/logic.ts`) en de echte opzoeking in
`client-domains`. Getoetst:
- de schakelaar in Instellingen → Domein (eigenaar wel, medewerker niet);
- op het eigen domein inloggen met de code van ResoFly en met de link: een sleutel in de
  browser, nooit een inlog bij Supabase, alleen het dossier van die organisatie, de sleutel in
  elke aanroep, herladen, uitloggen, de link in een andere browser;
- het portaal uitzetten terwijl een klant binnen is, en daarna doorsturen naar de naam bij ResoFly;
- op de naam bij ResoFly en het algemene portaal alleen een link (geen code), vastgelegd met het
  juiste bereik.

Goed om te weten: Chromium volgt een redirect uit `route.fulfill` buiten de route om (naar het
echte netwerk); de nagebootste Worker stuurt daarom door met een pagina die meteen doorverwijst,
en legt vast wat de echte Worker zou doen (301 of 302).

En `rapportage`: op Rapportages een vraag stellen. Daarna komt de pagina met de echte cijfers in
het afgeschermde kader, en dan verversen zonder AI, aanpassen via de chat, een oude versie
terugzetten, het menu en verwijderen. Het scenario heeft een eigen organisatie: de cijfers
moeten exact kloppen.

En `tickets`: een medewerker maakt een ticket in het venster, plaatst een interne notitie en een
zichtbaar antwoord en zet de status. De klant krijgt één mail, opent de knop daaruit, logt in en
komt meteen bij het ticket, zonder de interne notitie. Zijn reactie staat na Ververs bij het team
als nieuw. Afhandelen met de knop haalt het ticket van de werklijst; de klant vindt het onder
Afgehandeld. Een open venster zet een heropend ticket niet terug, een andere klant koppelen vraagt
eerst, en een klant op inactief ziet geen tabblad Tickets meer.

En `opname`: een telefoongesprek loggen en opnemen met de nep-microfoon van Chromium.
- de knop "Opname starten" bij een gesprek;
- transcript en notulen in beeld, de duur die de browser meet;
- de waarschuwing als het AI-tegoed op is, de echte reden in beeld, en "Opname uitschrijven" zodra
  er weer tegoed is.

De UI-test vangt daarvoor de upload naar de media-worker zelf op en legt de audio in nep-R2.

En `vooruitbetaald`: € 1.000 verzekering over 36 maanden via het formulier. Het voorbeeld vóór het
vastleggen (28 × € 27,78 en 8 × € 27,77), de bevestigingsvraag, de drie functies achter "Vastleggen
en boeken", het venster daarna (kerncijfers, de nieuwe balansrekening, het schema), de rij in de
lijst, de twee boekstukken in het Grootboek, Tegenboeken van de termijn (die staat daarna weer klaar),
de knop Vooruitbetaald in het journaal, en een lezer die alles ziet maar niets kan boeken.

Elke stap controleert ook: geen JavaScript-fout, geen foutmelding of "laden…" die blijft staan,
en geen mislukte aanroep die de stap niet verwachtte. Mislukt een stap, dan komt er een
schermafdruk (standaard in `<tmp>/stromen-ui`). Een run duurt ruim twee minuten.

Goed om te weten:

- de app draait op een eigen poort (vanaf 5310). De test zet die herkomst bij de toegestane
  origins van de functies en als adres in de mails; de gewone `ORIGIN` blijft geldig;
- inloggen gaat met een magische link via de admin-API (`generate_link` + `verify`). Niet met
  een nieuw wachtwoord: GoTrue trekt dan alle sessies van die gebruiker in;
- het werkblad begint op Offertes (dat scherm hoort bij deze stromen; `calendar-integrations`
  laadt sinds 6 november wel, met `ical.js` uit `node_modules`);
- realtime draait niet in de lokale stack: die websocketfouten in de console tellen niet mee.
  Ook de Word-editor (Collabora) en de media-worker van de browser zijn er niet, dus alleen
  rich-text contracten. Die maakt de test aan zoals het contractformulier ze opslaat: het
  formulier maakt zelf alleen nog Word-contracten;
- Vite gebruikt een eigen cachemap (`node_modules/.vite-stromen-ui`) en geen HMR, zodat andere
  Vite-servers of wijzigingen in `src/` de pagina niet midden in een stap herladen.

## Werkertest: de media-worker voor Word-documenten (`werker-documenten.mjs`)

De echte `workers/media-api` in workerd (wrangler dev, met een lokale R2) tegen dezelfde lokale
stack: uploaden, downloaden per rol, een documentrij die naar een bestand van een andere module
wijst, en de online editor (WOPI) met tokens die na het intrekken van rechten niet meer werken.
Collabora draait niet; de WOPI-tokens maakt de test zelf met dezelfde sleutel als de worker.

```bash
# wrangler in een eigen map (niet in de repo), en een config die naar de lokale stack wijst:
#   main = "<repo>/workers/media-api/src/index.ts", [[r2_buckets]] binding = "MEDIA_BUCKET",
#   [vars] SUPABASE_URL = "http://127.0.0.1:54321", ALLOWED_ORIGINS = "http://localhost:5173",
#   .dev.vars: SUPABASE_SERVICE_ROLE_KEY (uit `supabase status`), MEDIA_SIGNING_SECRET,
#   INTERNAL_UPLOAD_SECRET, OFFICE_CONVERT_SECRET
wrangler dev --local --port 8788
node tests/stromen/werker-documenten.mjs   # MEDIA_DEV_URL / MEDIA_DEV_SIGNING_SECRET / MEDIA_DEV_INTERNAL_SECRET
```

Zet ook `COLLABORA_URL` in `[vars]` (een adres waar niets draait is genoeg): zonder die
waarde geeft de PDF-omzetting een 500 in plaats van de weigering die de test verwacht.

## Werkertest: de galerij (`werker-galerij.mjs`)

Dezelfde worker en dezelfde stack, nu voor de galerij. Getoetst:
- uploaden en kijken per rol, en niet bij de buren;
- dat twee keer openen hetzelfde token geeft, en de cache-instelling van een beeld;
- range en HEAD, de zip;
- wie een foto of album mag verwijderen: niet de buren, een kijker, de boekhouder of wie
  Projecten alleen leest;
- dat de bestanden daarna uit R2 verdwijnen, via `/gallery/purge`, via de geplande taak en na
  een verwijderd project, met de tweede ronde voor een te laat geland bestand;
- dat een rij die naar het bestand van een ander album wijst, dat bestand niet kost.

```bash
# als hierboven, maar met de geplande taak aan:
wrangler dev --local --port 8788 --test-scheduled
MEDIA_DEV_DIR=<map van wrangler dev> node tests/stromen/werker-galerij.mjs
```

`MEDIA_DEV_DIR` is optioneel: daarmee zet de test een bestand rechtstreeks in de lokale R2,
zoals een upload die pas na het verwijderen landt.

## Galerij: dubbele bestandsnamen

Twee delen, zonder worker:

- `npm run test:stromen -- galerij-namen` (`galerij-namen.mjs`): de regel in de database
  (20261114150000). Dezelfde naam in één album, ook in andere hoofdletters of Unicode-vorm,
  wordt geweigerd met de hint die de app herkent. In een ander album mag hij. Oude dubbele
  bestanden blijven bij te werken. Twee transacties tegelijk geven één rij. Een kijker,
  boekhouder of buitenstaander krijgt nooit "deze naam bestaat al" te zien.
- `ui.mjs galerij`: de vraag in het scherm. Eén dubbel bestand, meer tegelijk, Overslaan,
  Andere naam, Escape, en de vraag boven het venster "Bestanden". De media-worker is hier
  nagebootst in de browser (`nepGalerijWerker`).

Daarna, in hetzelfde scenario, publiceren en delen op het eigen webadres (14 november, met
`CLIENT_DOMAINS_LIVE=albums` zoals op staging): Publiceren, Delen, "Deellink maken". De link
staat op `<naam>.resofly.com`, met de hash van precies dat token in de database. Een klant
opent hem in een eigen browser op dat adres (via de nagebootste Worker van `klantdomein`) en
ziet het album; gallery-public kreeg het webadres als herkomst. In `klantdomein.mjs` (zonder
browser): het overzicht met alleen albums live (albums naar het eigen domein, facturen en het
portaal nog naar het algemene adres), en een album op het klantadres: CORS, en het album van
een andere organisatie bestaat daar niet.

## Bestanden

| Bestand | Wat |
| --- | --- |
| `register.mjs`, `loader.mjs`, `std-serve.mjs` | laden de Deno-code in Node: imports van esm.sh/deno.land naar `node_modules`, `serve()` naar de harnas |
| `omgeving.mjs` | de lokale stack en de secrets van de functies |
| `nepdiensten.mjs` | Resend, Mollie en de media-worker, met storingen op bestelling; `registreerDienst` voor eigen nepdiensten |
| `nep-agenda.mjs` | nep-Google en nep-Microsoft voor de agendakoppeling (codes, tokens, agendalijsten, afspraken, intrekken) |
| `nep-ai.mjs` | nep-ElevenLabs (Scribe, synchroon en met webhook, ondertekend zoals ElevenLabs) en nep-Claude (de notulen) |
| `werker-documenten.mjs` | de werkertest hierboven (los te draaien, niet via `run.mjs`) |
| `werker-galerij.mjs` | de werkertest voor de galerij (los te draaien, niet via `run.mjs`) |
| `supabase.mjs` | PostgREST als gebruiker of als server, `psql` voor wat alleen de tijd doet |
| `functies.mjs` | roept een functie aan met een `Request`, zoals de browser of Mollie |
| `wereld.mjs` | een organisatie met alle rollen, bedrijfsgegevens en twee klanten met portaal |
| `toets.mjs` | de testloper: stappen, controles, telling |
| `run.mjs` | start de gekozen scenario's |
| `ui.mjs` | de UI-test in Chromium (zie hierboven) |
| `ui-server.mjs` | één adres voor de browser: functies in het testproces, de rest naar de gateway |
