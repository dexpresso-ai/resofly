# Organisatie inrichten: eerst de stappen, dan de werkruimte — 7 november 2026

Vraag: "Wanneer er een nieuwe gebruiker aangemaakt wordt, dien je eerst een
stappenplan te doorlopen om je organisatie in te stellen alvorens je door kunt.
Belangrijk is met name de organisatiekeuze (eenmanszaak, vof, bv, etc.); ook de
overige keuzes moeten voorgelegd worden. Koppeling met Mollie realiseren en hoe
ze dat moeten doen. Zie het als een grafisch mooi vormgegeven stappenlijst die
de gebruiker door de configuratie heen leidt."

## Wat er was

Een nieuwe gebruiker kreeg bij de eerste login vanzelf een organisatie
(`ensure_user_default_organization`), met als naam het begin van zijn
e-mailadres ("Info" voor info@…) en als rechtsvorm de standaard: eenmanszaak.
Daarna stond hij meteen in een lege werkruimte. Bedrijfsgegevens, btw, de
verzendwijze van facturen en Mollie moest hij zelf vinden in vijf tabbladen van
Instellingen. Wie een BV had, zag pas bij de boekhouding dat de administratie
als eenmanszaak liep. Op het dashboard stond alleen een kaartje "Workspace
setup" met vijf vinkjes.

Een uitgenodigd teamlid kreeg bij de eerste login óók zo'n eigen, lege
organisatie, naast de uitnodiging.

## Wat het nu is

Een nieuwe organisatie opent eerst **de inrichting**: een scherm met links de
stappen (op het donkere vlak, met het goud van het merk op de plek waar je
bent) en rechts de stap zelf. Pas na **Naar mijn werkruimte** gaat de werkruimte
open. Elke stap wordt bij Volgende meteen opgeslagen; wie halverwege stopt of
herlaadt, komt terug waar hij was.

| Stap | Wat je kiest of invult |
| --- | --- |
| 1. Welkom | Wat er komt, in drie blokken. Heb je ook een uitnodiging voor een team, dan kun je die hier accepteren. |
| 2. Rechtsvorm | Negen kaarten, in twee groepen: zonder rechtspersoon (eenmanszaak, vof, maatschap, cv) en met (bv, nv, coöperatie, stichting, vereniging). Per keuze: welke belasting, en wat het in ResoFly betekent (vennoten, dga, jaarrekening, urencriterium, boekjaar). **Niets staat vooraf aangevinkt**: de standaard "eenmanszaak" van de database is geen keuze van de gebruiker. |
| 3. Abonnement | Het pakket (Starter, Team, Pro), per maand of per jaar, met of zonder de creatieve module; starten via de betaalpagina van Mollie. Mag later. **Bij een BV, NV of coöperatie niet**: zie hieronder. Een administratie onder een holding slaat deze stap over (het abonnement hoort bij de moeder). |
| 4. Bedrijfsgegevens | Statutaire naam, handelsnaam, adres, e-mail, telefoon, website, KvK, btw-id, IBAN. Naam, adres en e-mail zijn verplicht (ze horen op elke factuur). KvK, btw-id en IBAN mogen nog ontbreken, maar worden gecontroleerd als ze er staan. |
| 5. Btw en boekhouding | Btw rekenen of de KOR; aangifte per kwartaal of per maand; begin van het boekjaar (bij een eenmanszaak, vof, maatschap of cv altijd januari: voor de inkomstenbelasting is dat het kalenderjaar); vanaf wanneer de boekhouding in ResoFly loopt; standaard uurtarief. |
| 6. Huisstijl | Logo en merkkleur, met een voorbeeldfactuur die meteen meeverandert. Mag je overslaan. |
| 7. Facturen versturen | Per e-mail (PDF, overboeking) of via Mollie (met betaallink); de betaaltermijn (14 of 30 dagen, of een eigen tekst) en de voettekst. |
| 8. Mollie koppelen | Hoe je het doet, in vier stappen: account aanmaken op mollie.com, je account laten controleren (KvK, bankrekening, identiteit; meestal één tot drie werkdagen), de API-key kopiëren (Developers → API-keys, de live-key begint met `live_`), en hier plakken. Alleen de eigenaar koppelt; een beheerder ziet de uitleg. Mag later. |
| 9. Klaar | Een overzicht van alles, elke regel klikbaar om terug te gaan, met daarna "Team uitnodigen", "Agenda koppelen" en "Bank koppelen" (die ronden ook af). |

**Een BV, NV of coöperatie** hoort bij de zakelijke module, en die zet je alleen
aan op een lopend abonnement. De database weigert de rechtsvorm zonder module
(`enforce_company_legal_form`, 7 augustus); dat blijft zo. De stappen leggen het
uit en regelen het: kies je BV, dan onthoudt de inrichting die keuze, gaat de
stap Abonnement van "optioneel" naar nodig, en toont die drie vinkjes:
abonnement starten, de zakelijke module aanzetten (€ 19 per maand op staging),
de rechtsvorm vastleggen. Dat laatste gaat vanzelf zodra de module aan staat.
Wil je de module niet, dan kies je een andere rechtsvorm (knop "Andere
rechtsvorm"). Afronden kan niet zolang een gekozen BV nog niet vastligt.

**Wie ziet wat**

- De eigenaar en een beheerder doorlopen de stappen. Alleen de eigenaar kan
  Mollie koppelen (zoals in Instellingen sinds 7 november).
- Een ander teamlid (lid, kijker, boekhouder) van een organisatie die nog wordt
  ingericht, ziet "… wordt nog ingericht", met **Opnieuw kijken** en, als hij
  ze heeft, de weg naar zijn andere organisaties.
- **Wie is uitgenodigd, krijgt geen eigen organisatie meer** bij de eerste login
  (dat gold al voor de boekhouder). Hij ziet zijn uitnodiging met Accepteren, en
  "Of maak een eigen organisatie". Zonder die wijziging had elk uitgenodigd
  teamlid de inrichtingsstappen gekregen, voor een bedrijf dat hij niet heeft.
- **Bestaande organisaties merken niets**: de migratie zet ze op "ingericht".
- Een nieuwe organisatie via "Nieuwe organisatie" of "+ administratie" krijgt
  ook de stappen.

Na het afronden heet de organisatie in ResoFly zoals het bedrijf (de
handelsnaam, anders de bedrijfsnaam), niet meer naar het e-mailadres.

## Database — `20261107190000_organisatie_inrichten.sql`

- `organizations.onboarding_completed_at` (en `onboarding_completed_by`).
  Bestaande organisaties krijgen de tijd van de migratie: de kolom komt erbij
  met een standaardwaarde, die daarna weer weggaat. Zo vuren er geen triggers
  (geen regel "gewijzigd" in het auditlog van elke organisatie, geen nieuwe
  `updated_at`) en begint een nieuwe organisatie leeg. Draait de migratie nog
  eens, dan gebeurt er niets; een organisatie van ná de uitrol slaat de stappen
  dan dus niet alsnog over.
- `complete_organization_onboarding(organisatie, naam)`: rondt af. Alleen een
  actieve owner of admin van díe organisatie (de rol uit `auth.uid()`), alleen
  met een bedrijfsnaam in `company_settings`. Wie geen lid is, krijgt dezelfde
  melding als wie de verkeerde rol heeft. De naam gaat op één regel en hooguit
  120 tekens. Nog eens aanroepen verandert niets. Dicht voor anon.
- Rechtstreeks bijwerken kan niet: op `organizations` mag een gebruiker sinds
  26 september alleen `name` wijzigen, dus de nieuwe kolom niet.
- `ensure_user_default_organization`: geen eigen organisatie bij een
  openstaande uitnodiging van elk soort (was: alleen de boekhouder).

## Code

- `src/features/OrganizationSetup.tsx`: de stappen, en het wachtscherm voor
  een teamlid. Elke stap schrijft alleen zijn eigen velden
  (`saveOnboardingSettings` in `src/lib/repository.ts`: update, en bestaat de
  rij nog niet, dan een insert met alleen die velden). Een volledige upsert
  zoals in Instellingen zou de huisstijl en de documentopmaak met standaarden
  overschrijven. De verzendwijze gaat via `saveInvoiceSendMethod`, Mollie via
  `saveInvoiceMollieKey`, het abonnement en de modules via de bestaande
  billing-functie: dezelfde wegen als de knoppen in Instellingen, met dezelfde
  controles op de server.
- `src/lib/onboarding.ts` (met `onboarding.test.ts`): de stappen, de uitleg per
  rechtsvorm, en de controles: KvK (8 cijfers), postcode, IBAN (lengte per land
  en het controlegetal), btw-id (ook het omzetbelastingnummer zonder NL), e-mail,
  telefoon en website. Een website wordt altijd een gewoon http(s)-adres: een
  `javascript:`- of `data:`-adres komt niet op een factuur of in het portaal.
- `src/main.tsx`: de poort, direct na "Geen organisatie gevonden". Alleen bij
  `onboarding_completed_at === null`: ontbreekt de kolom (de app is eerder
  uitgerold dan de migratie), dan werkt alles zoals daarvoor. Na afronden gaat
  de organisatie zoals de database hem teruggaf meteen in de context, dus de
  werkruimte opent ook als het verversen daarna even niet lukt.
- `src/styles/onboarding.css`: licht en donker, in elke look; op de telefoon
  een kop met de voortgang als bolletjes, en Terug en Volgende onderaan in beeld.
- Waar je was, staat per organisatie in deze browser
  (`resofly.onboarding.<organisatie>`): alleen de stap, de afgeronde stappen en
  een gekozen BV. Uitloggen ruimt het op (`src/lib/signOut.ts`).

## Veiligheid

- De organisatie komt uit de sessie: de stappen schrijven alleen naar de
  organisatie waarvan de server zegt dat je er lid van bent, en RLS laat alleen
  owners en admins schrijven. Afronden controleert de rol in de database.
- De Mollie-key gaat alleen naar `invoice-workflow` (die hem bij Mollie
  controleert en versleuteld bewaart). Hij staat nooit in de opslag van de
  browser, en is na het koppelen weg uit het scherm. Een access token, een
  profiel-id of een key met een spatie wordt herkend vóór hij de deur uit gaat.
- Het logo wordt opnieuw getekend (`logoToDataUrl`): alleen pixels, nooit een
  SVG met script.
- De betaalpagina van het abonnement volgt de app alleen naar een
  https-adres.
- De inrichting is een weg voor de gebruiker, geen slot: wie de voortgang in
  zijn browser vervalst, kan stappen overslaan, maar niet afronden zonder
  bedrijfsnaam, en kan alleen zijn eigen organisatie raken.

## Getest

- `npm test`: 1231 van 1231. Nieuw: `src/lib/onboarding.test.ts` (31): de
  volgorde, het onthouden van de voortgang (en wat er gebeurt met onzin in de
  opslag), dat de zakelijke module bij precies de rechtsvormen hoort die de
  database bewaakt, de controles, en dat een website nooit een script-adres
  wordt. `migrationGrants.test.ts` ziet dat de nieuwe functies dicht zijn voor
  anon.
- `npm run typecheck` en `npm run build`: schoon.
- `npm run test:inrichten` (nieuw, ook in CI), 80 controles: de hele weg in
  Chromium tegen de nagebootste backend, op desktop en op de telefoon. Een BV wordt niet
  opgeslagen zonder module, en na testbetaling en module vanzelf; verkeerde
  gegevens houden de stap tegen zonder iets op te slaan; een access token gaat
  niet naar de server, een test-key wel, en staat daarna nergens in de browser;
  afronden opent de werkruimte; herladen halverwege; een verse organisatie
  zonder bedrijfsgegevens; een teamlid wacht; een beheerder koppelt geen Mollie;
  een database zonder de kolom opent gewoon de werkruimte.
- `npm run test:mobile -- --theme=both`: 404 pagina's, 0 met problemen. Nieuw
  daarin: elke stap en het wachtscherm (`inrichten-*`) op telefoon, tablet en
  liggend, licht en donker. Op de telefoon begint de kop van elke stap op 215px;
  de grens staat op 258px, zodat een groeiende stappenkop opvalt. Onderweg
  gevonden en rechtgezet: op de tablet kapten KvK, btw-id en IBAN naast elkaar
  het IBAN af, en Uitloggen kostte op de telefoon een eigen rij.
- `npm run test:loading`: alles geslaagd.
- Migratieketen vanaf nul (`supabase db start`, Postgres 17.6.1.111 zoals
  staging): 253 van 253. De nieuwe migratie draait daarna nog eens zonder fout.
  Met de stand van staging nagespeeld (kolom weg, een bestaande organisatie,
  dan de migratie): de bestaande staat op ingericht, met dezelfde `updated_at`
  en geen nieuwe regel in het auditlog; een nieuwe organisatie begint leeg.
- Stromentest (lokale stack, Postgres 17.6.1.178), nieuw scenario `inrichten`:
  19 van 19. Afronden zonder bedrijfsnaam geweigerd; rechtstreeks bijwerken
  geweigerd, ook als eigenaar; een BV zonder module geweigerd; lid, kijker,
  boekhouder, iemand van buiten en anon kunnen niet afronden; de eigenaar wel,
  met de naam op één regel; nog eens afronden verandert niets; een beheerder van
  een andere organisatie raakt deze niet; wie is uitgenodigd krijgt geen eigen
  organisatie, wie niet is uitgenodigd wel (en die moet worden ingericht).
- Stromentest `rook` en `beveiliging`: 166 stappen, 0 fout. `wereld.mjs` rondt de
  inrichting van zijn organisaties nu zelf af, met de RPC.
- UI-test tegen de echte stack (`tests/stromen/ui.mjs`), nieuw scenario
  `inrichten`: 15 van 15. Een nieuwe gebruiker krijgt bij de eerste login een
  organisatie en de stappen, kiest VOF (de bedrijfsgegevens ontstaan dan pas),
  vult alles in (in de database netjes: `1015 AA`, `NL91 ABNA 0417 1643 00`,
  `NL001234567B01`), kiest de KOR, een merkkleur (ook de factuurkleur), per
  e-mail, Mollie later, en rondt af: de werkruimte opent, de organisatie heet
  "Studio Jansen", en na herladen blijft het de werkruimte. Een uitgenodigd
  teamlid ziet zijn uitnodiging en geen stappen, en komt na accepteren in de
  werkruimte. De scenario's `offerte`, `rollen` en `mollie`: 27 van 27.

## Wat niet in deze wijziging zit

- **Het abonnement kiezen is niet verplicht** (behalve voor een BV). Een nieuwe
  organisatie staat zoals voorheen op Starter zonder betaald abonnement. *Jouw
  keuze of starten in de stappen verplicht moet worden.*
- **Een BV zonder abonnement** kan de stappen niet afronden als BV. Dat volgt
  uit de bestaande regel dat boekhouden als BV bij de zakelijke module hoort.
  Wie eerst wil rondkijken, kiest voorlopig een andere rechtsvorm; omzetten kan
  later bij Instellingen → Facturatie.
- **Team uitnodigen, agenda en bank** zijn geen stap: ze staan bij Klaar als
  knop naar de plek waar dat al kan.
- Het kaartje "Workspace setup" op het dashboard is gebleven (eerste klant,
  eerste project).
