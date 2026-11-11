# Berichten: eigen mappen per klant, en mail van map naar map verplaatsen (2026-11-11)

## Aanleiding

"Maak een functionaliteit waarbij men bij berichten zelf mappenstructuren per
klant kan ingeven. De gebruiker kan deze mails dan ook verplaatsen naar andere
mappen, etc."

Bij een klant met veel post was het mailvenster op Berichten één stapel op
datum: offertes, facturen, een project en losse vragen door elkaar. Wie een
afspraak van drie weken terug zocht, moest zoeken of scrollen.

## Wat er nu kan

**Mappen per klant.** Kies op Berichten één klant in het klantfilter. Het
mailvenster is dan een verkenner met de mappen van die klant: per laag eerst de
mappen, dan de gesprekken, en onderaan **Zonder map**. Mappen kunnen in mappen,
tot vijf lagen diep ("Project website › Feedback › Ronde 2"). Ze staan op naam,
met getallen als getallen: wie een vaste volgorde wil, zet er een nummer voor
("1 Offertes", "2 Oplevering", "10 Nazorg").

**Een map maken, hernoemen, verplaatsen, verwijderen.**

- **Nieuwe map** bovenin het mailvenster maakt een map op het bovenste niveau.
  De naam typ je op de plek zelf; Enter slaat op, Esc annuleert. Een naam die
  er op die plek al staat (ook met andere hoofdletters) zie je meteen in het
  rood, nog vóór je opslaat.
- Het menu **…** naast een map: **Submap maken**, **Naam wijzigen**,
  **Map verplaatsen…** (met alles erin) en **Map verwijderen…**.
- **Verwijderen gooit nooit mail weg.** Wat in de map staat, gesprekken én
  submappen, schuift één laag omhoog. Het venster zegt vooraf precies wat er
  gebeurt: "3 gesprekken en 1 submap gaan naar de map "Project website". Er gaat
  geen mail verloren." Komt een submap daarbij naast een map met dezelfde naam,
  dan krijgt hij " (2)" achter zijn naam.

**Gesprekken verplaatsen**, op drie manieren:

1. **Verplaatsen** in de kop van een open gesprek. Daar staat ook in welke map
   het gesprek nu staat (een klik erop doet hetzelfde). Het venster toont de
   hele boom van de klant, met "nu hier" bij de huidige plek; je kunt er ook
   meteen een nieuwe map maken. Dubbelklikken verplaatst direct.
2. **Slepen** naar een map (met een muis). Blijf je even boven een dichte map
   hangen, dan klapt hij open, zodat je ook een submap bereikt. Terug naar
   **Zonder map** kan ook door te slepen.
3. **Selecteren** voor meerdere tegelijk: vink gesprekken aan (of **alles**) en
   kies **Verplaatsen**. Handig bij het inrichten van een klant met jaren post.

Na elke verplaatsing staat er onderin een melding met **Ongedaan maken**.
Slepen gaat snel, en soms net naast de bedoelde map; terugzetten is dan één
klik. Bij een selectie gaat elk gesprek terug naar waar het vandaan kwam.

**Niets missen.** Een dichte map met ongelezen post laat dat zien met het
gouden getal, ook als het nieuwe antwoord diep in een submap zit. Zonder iets
ongelezens staat er hoeveel gesprekken erin zitten. Eerst stonden die twee
getallen naast elkaar ("2" en een gouden "1"); dat las als een rekensom.

**Zoeken en filteren** werken door de mappen heen: mappen zonder treffers gaan
uit beeld, mappen mét treffers klappen vanzelf open. Zoeken op de naam van een
map ("offertes") vindt ook de gesprekken die erin staan.

**In de lijst van alle klanten** staat de map als klein label vóór het
onderwerp, zodat je ook daar ziet waar een gesprek hoort.

**In het klantdossier** (tabblad Communicatie) staan dezelfde mappen, met
dezelfde knoppen. Een map hoort bij de klant, dus hij hoort op beide plekken.
Klap je daar een gesprek open, dan staat de map erboven; een klik verplaatst.

## Regels

- Een **gesprek** staat in hooguit één map, van zijn eigen klant. Bewust het
  gesprek en niet het losse bericht: een antwoord van de klant hoort bij het
  gesprek en komt dus vanzelf in dezelfde map. Een nieuw gesprek begint in
  **Zonder map**.
- Een map blijft bij de klant waarvoor hij gemaakt is. Wordt een gesprek later
  aan een andere klant gekoppeld, dan gaat het terug naar **Zonder map**: de
  map van de vorige klant past niet meer.
- Mapnamen: niet leeg, hooguit 80 tekens, één keer per plek.
- Rechten: mappen zie je als je Klanten mag lezen; maken, wijzigen en
  verplaatsen kan alleen wie Klanten mag schrijven. Een lezer ziet de mappen,
  zonder knoppen. De boekhouder (Klanten dicht) ziet niets.
- Een klant verwijderen ruimt zijn mappen mee op.

## Database

Migratie `20261111210000_berichten_mappen.sql`:

- tabel `client_email_folders` (per klant een boom via `parent_id`), met de
  modulepoort Klanten (`apply_module_gate`) en geen schrijfrecht voor de app;
- kolom `client_email_threads.folder_id` (`on delete set null`);
- triggers die de boom heel houden (zelfde klant, geen kringen, vijf lagen, ook
  bij verplaatsen van een map met submappen) en een gesprek alleen in een map
  van zijn eigen klant laten;
- rpc's `create_client_email_folder`, `rename_client_email_folder`,
  `move_client_email_folder`, `delete_client_email_folder` en
  `move_client_email_threads`: security definer, met een eigen check op
  schrijven op Klanten en overal gefilterd op `organization_id`; dicht voor
  anon;
- de view `client_email_thread_overview` krijgt `folder_id` erbij, achteraan.
  `security_invoker` staat er expliciet bij: `create or replace view` zonder
  die optie zet hem terug op uit.

De app vangt het gaatje tussen uitrol van de app en de migratie op: zolang de
tabel of kolom er niet is, laadt alles zoals vroeger, zonder mappen en zonder
foutmelding. De export (`exportManifest.ts`) neemt de mappen mee.

## Getest

- **Database**, op een verse database met de hele migratieketen
  (`supabase db start`, Postgres 17.11.0.018): als eigenaar mappen maken
  (ook een dubbele naam met andere hoofdletters: geweigerd), tot vijf lagen
  (de zesde: geweigerd), een map van een andere klant als ouder (geweigerd),
  gesprekken verplaatsen (ook naar een map van een andere klant of uit een
  andere organisatie: geweigerd), een map in zijn eigen submap (geweigerd),
  verwijderen met een naamconflict ("L3 (2)"), rechtstreeks in de tabel
  schrijven (geen recht). Als lezer: ziet de mappen, kan niets wijzigen. Als
  boekhouder en als lid van een andere organisatie: ziet niets, kan niets. Een
  gesprek naar een andere klant: map vervalt. Klant verwijderd: mappen weg.
- **In de browser** (nagebootste backend uit `tests/mobile/mock`, die nu ook
  mappen kent): map maken, dubbele naam, slepen, Ongedaan maken, Verplaatsen
  via het venster, Selecteren, het mapmenu, verwijderen, een map verplaatsen,
  zoeken door de mappen; op 1440 en 1280 breed, op de telefoon, in donker en
  licht, en in het klantdossier. Geen JavaScript-fouten.
- Wat dat opleverde en is aangepast: het mailvenster was naast tickets en
  telefoon 220px breed ("Project h…"); het krijgt nu meer ruimte. Op de
  telefoon kreeg het in de gestapelde weergave eerst geen hoogte (flex-basis
  0 naast tweemaal 50%); nu de helft. De melding na verplaatsen viel op de
  telefoon onder de Gerrie-knop. En de dubbele tellers per map zijn één getal
  geworden.
- Na het samenvoegen van de logica voor Berichten en het dossier
  (`useMailFolderActions`) gaf **Verplaatsen** in de gesprekskop een leeg
  scherm: het venster vroeg tijdens het renderen de klantnaam op via een
  variabele die verderop in de component pas bestond. Gevonden door alles
  opnieuw door te klikken; de naam komt nu uit `data.clients`. En mislukte
  **Ongedaan maken**, dan verdween de foutmelding meteen weer met de oude
  melding; een melding sluit nu alleen zichzelf.
- `npm run typecheck`, `npm test` (met nieuwe tests in
  `src/lib/mailFolders.test.ts`), `npm run test:mobile -- --theme=both` en
  `npm run test:loading`.

## Bewust (nog) niet

- **Gerrie** kan nog geen mappen maken of mail verplaatsen. Dat zou als
  voorstel (`propose_action`) moeten, langs dezelfde rpc's; nu niet gebouwd.
- Mappen van een **collega** verschijnen niet live: na verversen of bij de
  volgende binnenkomende mail wel.
- Geen eigen **sleepvolgorde** voor mappen: die zou per teamlid anders
  onthouden worden. Op naam, met een nummer ervoor als je wilt sturen.
- **Slepen** alleen met een muis: op een aanraakscherm zou een rij vastpakken
  het scrollen blokkeren. Daar zijn Verplaatsen en Selecteren.
