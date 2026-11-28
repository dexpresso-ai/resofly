# Een gedeelde map vult zich niet meer vanzelf (2026-11-27)

Stap 0 van het bouwplan voor pagina's (`docs/plannen/PAGINAS_BOUWPLAN_2026-11-27.md`, §7).
Een gedeelde map was live. Zette een collega er later een bestand, notitie of document in,
dan zag de klant dat meteen, zonder dat iemand op Delen drukte. Vastgelegd op 27 november:
*"klantbestanden worden pas gedeeld, wanneer de gebruiker van de app de deel functie
gebruikt"*.

## Wat er nu kan of klopt

- **Een map delen legt vast wat er op dat moment in staat**, submappen inbegrepen. De
  ontvanger ziet alleen die items, in het portaal en via een geheime link. Wat er later
  in de map komt, ziet hij niet en kan hij ook niet openen of downloaden.
- **"Niet gedeeld"** staat in de drive achter elk item dat in een gedeelde map staat, maar
  dat de ontvanger nog niet ziet.
  Op een telefoon staat er alleen een klein icoon (een doorgestreept oog), zodat er meer
  van de naam overblijft.
- **De balk boven de map** zegt wat er nog niet gedeeld is en met wie, bijvoorbeeld "1
  notitie in deze map is nog niet gedeeld met Jan de Vries". De knop **Ook delen** deelt
  het alsnog; daarna verdwijnen de balk en de labels. De knop staat er alleen voor wie op
  Inhoud mag schrijven.
- **Een melding bij "Ook delen"**, die je per keer kunt uitzetten met het vinkje
  **Melding sturen**. Het vinkje staat standaard aan, en deze browser onthoudt je keuze.
  Vastgelegd op 27 november: *"Ja ik wil een melding die men ook uit kan zetten"*.
  - De ontvanger krijgt de mail "Nieuw in “Oplevering”", met de namen van wat er nieuw
    is (hoogstens tien, daarna "en nog 3").
  - Een organisatie kan de tekst aanpassen bij Instellingen → E-mail, sjabloon "Nieuw in
    een gedeelde map" (`file.added`), net als "Bestand gedeeld".
  - Bij een deling met een geheime link gaat er een nieuwe link mee, net als bij "Opnieuw
    versturen". De vorige link werkt daarna niet meer.
  - Gaat de mail mis, dan is het delen wel gelukt, en zegt de app dat.
- **Opnieuw delen** van de map (zelfde ontvanger) neemt mee wat er nu in staat, in
  dezelfde deling.
- **Verplaats je een gedeeld item uit de map**, dan verdwijnt het bij de ontvanger. Zet je
  het terug, dan staat het er weer: het blijft op de lijst van de deling.
- **Bestaande mapdelingen** krijgen bij de migratie één keer hun huidige inhoud op de
  lijst. Bij de ontvanger verdwijnt dus niets.
- **De teksten zeggen het ook.** Het deelvenster van een map zegt: "Wat je er later in
  zet, deel je apart". Een deelvoorstel van Gerrie zegt het in zijn waarschuwing.

## Hoe het werkt

- `drive_share_entries` (migratie `20261127120000_gedeelde_mappen_niet_meer_live.sql`):
  per mapdeling de gedeelde items, met wie ze deelde (`added_by`) en wanneer
  (`added_at`).
  - Lezen gaat zoals bij `drive_shares`, met de module Inhoud als poort.
  - Schrijven kan alleen via de functies hieronder.
- `drive_folder_tree_items`: één bron voor "wat staat er nu in deze map". De regel is
  dezelfde als die er al was: elk item hoort bij dezelfde klant als de map. Vastleggen,
  tonen en aanvullen gebruiken allemaal deze functie, zodat ze niet uit elkaar lopen.
  Zonder rechten voor de app.
- `drive_share_capture`: legt de inhoud vast.
  - Bij een nieuwe deling doet een trigger dat.
  - Bij opnieuw delen roept de deeldienst (`file-share`) hem aan, want die werkt een
    bestaande deling bij in plaats van een nieuwe te maken.
  - Alleen voor de service-role.
- `drive_share_items` (zelfde naam en uitvoer, dus het portaal en de deellink hoeven
  niets te veranderen) geeft van een map alleen wat op de lijst staat. Ook het downloaden
  leunt hierop.
- `drive_share_add_items`: "Ook delen".
  - De organisatie komt uit de deling zelf, nooit uit de invoer.
  - Het vraagt schrijfrechten op Inhoud.
  - Het weigert een ingetrokken of verlopen deling, en elk item dat niet (meer) in de map
    staat of bij een andere klant hoort.
- `file-share`, actie `notifyAdded`: de melding bij "Ook delen". Het aanvullen zelf gaat
  met `drive_share_add_items` onder de rechten van wie klikt. De melding gaat alleen over
  wat nu echt in de deling staat; wordt er om iets anders gevraagd, dan gaat er geen mail
  uit.
- `drive_share_folder_gaps`: wat er in een map nog ontbreekt, per lopende mapdeling die de
  map omvat. De drive vraagt dit alleen op als er ergens een lopende mapdeling is, en
  opnieuw als er iets in de map bij komt. Daarmee blijft het opstarten van de app even
  zwaar (regel 5).

**Niet in het logboek, met opzet.** Een regel per toegevoegd item zou bij het delen van
een volle map honderden regels geven. De lijst zelf onthoudt wie wat wanneer deelde. Het
maken en intrekken van een deling staat er, zoals altijd, wel in.

**Een bestandsoverdracht** (Verzenden) blijft zoals hij was. Verzenden is al een handeling
op één moment.

## Getest

- `tests/database/gedeelde_mappen.sql`, 25 controles:
  - wat de ontvanger ziet bij delen en na toevoegen;
  - de melding in de drive;
  - aanvullen met en zonder schrijfrechten, vanuit een andere organisatie, met een item
    van buiten de map, met een lege lijst, en bij een ingetrokken deling;
  - verplaatsen en terugzetten;
  - zelf een regel schrijven kan niet, vastleggen is alleen voor de deeldienst;
  - opnieuw delen.
- `tests/stromen/documenten.mjs`, 7 nieuwe stappen door de echte deeldienst en het echte
  portaal:
  - een klantmap delen;
  - later toegevoegd is niet te zien en niet te openen;
  - een lezer kan niet aanvullen;
  - "Ook delen";
  - opnieuw delen in dezelfde deling.
  - met melding krijgt de klant een mail met wat er nieuw is;
  - over iets wat niet in de deling staat, gaat geen mail uit.
- `tests/stromen/ui.mjs documenten`, een nieuwe stap in Chromium:
  - de balk, het label alleen bij het nieuwe item, en "Ook delen" laat beide verdwijnen;
  - het vinkje Melding sturen staat standaard aan, en de klant krijgt de mail;
  - de database legt vast wie klikte;
  - op 390 pixels breed past de balk, en blijft het label in beeld.
- De naam in een rij mag nu korter worden, zodat de labels erachter niet wegvallen. Op een
  telefoon viel "Niet gedeeld" eerst weg achter de afgekapte naam.
- `src/lib/emailTemplateContent.test.ts`: de editor en de mail hebben dezelfde
  standaardtekst; namen worden ge-escaped en een lange lijst wordt afgekort.
- `npm test`, `npm run typecheck`, `npm run test:database` (de keten vanaf nul) en
  `npm run test:mobile -- --theme=both` voor de vier Inhoud-pagina's: groen.
- **Niet gedraaid in de cloudsessie:** `deno check`. De proxy blokkeert deno.land. CI deed
  het wel: de workflow Frontend checks op de branch (job `edge-functions`), groen op 27
  november, vóór de merge naar staging.

Ook hersteld: de testhulp `naarKlantdossier` in `tests/stromen/ui.mjs` zocht in het menu
naar "Inhoud". Sinds 23 november heet dat "Alle inhoud", onder het kopje Documenten.
Daardoor liep het UI-scenario voor documenten sindsdien vast.

## Nakijken op staging

De migratie zet de huidige inhoud van bestaande mapdelingen op de lijst. Dat is vanuit
deze sessie niet op staging te zien. Controleer het in de app:

1. Open een map die al met een klant gedeeld was.
2. Er hoort geen balk te staan, en geen label "Niet gedeeld". Dat betekent dat alles wat
   erin staat op de lijst van de deling staat.
3. Wil je het portaal zelf zien, log dan in als die contactpersoon, of open de geheime link
   van een deling met een los adres. Het voorbeeld van het portaal in de app toont
   voorbeeldgegevens, geen echte delingen.
