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
`nep-agenda.mjs`), `documenten` (maken, rechten per rol en module, andere organisaties,
delen via portaal en link, opruimen) en `verzenddomein` (eigen domein koppelen, verifiëren,
versturen vanaf het eigen adres, de domein-webhook, verwijderen, en wie een domein mag
vasthouden; de nep-Resend kent daarvoor ook de Domains-API en verstuurt, net als Resend,
alleen vanaf een geverifieerd domein) en `bank` (mutaties met de hand invoeren, verdelen over
facturen, creditnota's, inkoopfacturen en grootboekrekeningen, terugdraaien, samenvoegen met wat de
bank later levert, de aansluiting en wie wat mag; zie
`docs/changelog/CHANGELOG_BANK_HANDMATIG_BOEKEN_2026-11-07.md`) en `marketing` (een
campagne versturen terwijl de verzendronde midden in het klaarzetten valt, de ontvangerslijst
zoals het scherm hem laadt, tracking via de webhook, pauzeren en annuleren midden in een batch,
herstel na een omgevallen verzending, afmelden via de link en met één klik, wat het team wel en
niet van de afmeldlijst mag halen, wie welke klantgegevens ziet, en een follow-up-stroom; zie
`docs/rapporten/CONTROLE_MARKETING_2026-11-07.md`). Dat scenario verstuurt in batches van vijf
(`CAMPAIGN_DISPATCH_BATCH` in `omgeving.mjs`). De uitkomst van de documenten staat in
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

## Bestanden

| Bestand | Wat |
| --- | --- |
| `register.mjs`, `loader.mjs`, `std-serve.mjs` | laden de Deno-code in Node: imports van esm.sh/deno.land naar `node_modules`, `serve()` naar de harnas |
| `omgeving.mjs` | de lokale stack en de secrets van de functies |
| `nepdiensten.mjs` | Resend, Mollie en de media-worker, met storingen op bestelling; `registreerDienst` voor eigen nepdiensten |
| `nep-agenda.mjs` | nep-Google en nep-Microsoft voor de agendakoppeling (codes, tokens, agendalijsten, afspraken, intrekken) |
| `werker-documenten.mjs` | de werkertest hierboven (los te draaien, niet via `run.mjs`) |
| `supabase.mjs` | PostgREST als gebruiker of als server, `psql` voor wat alleen de tijd doet |
| `functies.mjs` | roept een functie aan met een `Request`, zoals de browser of Mollie |
| `wereld.mjs` | een organisatie met alle rollen, bedrijfsgegevens en twee klanten met portaal |
| `toets.mjs` | de testloper: stappen, controles, telling |
| `run.mjs` | start de gekozen scenario's |
| `ui.mjs` | de UI-test in Chromium (zie hierboven) |
| `ui-server.mjs` | één adres voor de browser: functies in het testproces, de rest naar de gateway |
