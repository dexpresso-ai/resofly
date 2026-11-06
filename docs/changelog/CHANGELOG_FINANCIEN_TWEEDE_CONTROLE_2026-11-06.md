# Financiën: tweede controle op werking en veiligheid

**6 november 2026 · database, edge functions, Gerrie/API/MCP en schermen · staging**

Aanleiding: "Check de gehele financiële module op werking en veiligheid. Voer
aanpassingen door en doe je werk zorgvuldig en foutloos."

> **Status:**
> - één migratie (`20261105233000_financien_tweede_controle`);
> - aanpassingen in twee edge functions (`invoice-workflow`, `client-portal`)
>   en in gedeelde code (Gerrie, de inbox, de documentopmaak, de
>   aanmaningsmail);
> - aanpassingen in veertien schermen en in een reeks bibliotheken (bedragen,
>   bankimport, XAF, CSV, rapportages).
>
> Alles is eerst droog nagespeeld op staging, in transacties die altijd
> worden teruggedraaid.

## Hoe er gecontroleerd is

- **Vier onafhankelijke reviews**:
  - verkoop in de app, de pdf's en de wettelijke inhoud van een factuur;
  - de edge functions voor offertes, facturen, contracten en het portaal;
  - boekhouding, rapportages, aangiftes en exports;
  - bank en inkoop.
- **Zelf nagegaan:** elke bevinding in de code of op staging, voordat er iets
  veranderde.
- **De database opnieuw doorgemeten:** de rollen- en tenantmatrix (827
  combinaties), de eind-tot-eindcyclus per rechtsvorm en `plpgsql_check`
  over 482 functies. Geen verschil met de meting na de vorige uitrol.
- **Parallelle controle:** tegelijk liep de controle van contract, offerte en
  factuur (`20261105230000`, zie
  `CHANGELOG_CONTRACT_OFFERTE_FACTUUR_2026-11-05.md`). Wat die al oploste,
  staat hieronder apart en is hier niet opnieuw gedaan. Waar beide dezelfde
  functie raken, bouwt deze migratie op hun nieuwste versie voort.

## Bevindingen en fixes

### Boekhouding en database

| Ernst | Wat er misging | Nu |
|---|---|---|
| hoog | **Tegenboeken** van een verkoopfactuur liet die op "verzonden" staan, met de boeking eraan. Opnieuw boeken kon niet meer, het openstaande bedrag werd 0, en crediteren, herinneren en de betaallink weigerden. De btw bleef verschuldigd (art. 37 Wet OB), maar was weg uit de aangifte. | Een verkoopfactuur, creditnota of betaling boek je niet meer los tegen; de melding wijst de terugweg (Crediteren, "Boeking ongedaan maken" bij de bank, een terugbetaling). Dat geldt in de database, het scherm en Gerrie. |
| midden | Een **geboekte inkoopfactuur** verwees voor correcties naar tegenboeken. Daarna bleef hij "geboekt" en kon hij nooit meer worden gecorrigeerd. | Tegenboeken zet de inkoopfactuur terug naar concept, ook in de inbox. Is er al op betaald, dan moet eerst die betaling terug. |
| midden | **Btw-periode afsluiten:** de kaart van Gerrie en het scherm tonen het saldo van het moment van bekijken, maar afsluiten rekende opnieuw. Kwam er intussen een boeking bij, dan ging de periode voorgoed dicht op een ander bedrag dan bevestigd. | Het bevestigde saldo gaat mee. Wijkt het af, dan sluit er niets en zegt de melding wat het nu is. |
| midden | **Verkoop van een bedrijfsmiddel** boekte nooit btw. Wie het brutobedrag invulde, boekte de btw als boekwinst. | De opbrengst is exclusief btw, met een btw-code (standaard HOOG, met de KOR geen). De btw gaat naar 1510 en in rubriek 1a. Het scherm noemt ook de btw bij weggeven (art. 3 lid 3 Wet OB). |
| laag | **KOR:** de verkoopboeking zette de btw stil op 0, ook als de factuur btw noemde. | Sinds de parallelle controle gaat een KOR-factuur met btw niet meer de deur uit. Komt er toch een binnen, uitgegeven vóór de KOR aanging, dan boekt het grootboek de btw die erop staat. |
| laag | **"Betaald"** op een geboekte factuur met openstaand saldo kon in het scherm. De status zei betaald, terwijl 1300 open bleef. Dit was open punt 1 van de parallelle controle. | De database weigert dat voor elke gebruiker, met de uitleg: koppel de ontvangst bij de bank of boek een memoriaalpost. Is er niets meer open, dan mag "Betaald" wel. |

### Bank en inkoop

| Ernst | Wat er misging | Nu |
|---|---|---|
| hoog (met Direct boeken aan) | De **inbox** maakte bij een onbekende afzender een leverancier aan met het IBAN uit die mail. Bij de volgende factuur gold "het IBAN klopt": het werd met zichzelf vergeleken. Wie het inboxadres kende, kon zo kosten en voorbelasting laten boeken zonder dat een mens de leverancier zag. | Zo'n leverancier krijgt "nog bevestigen". De inbox boekt er niets automatisch op tot iemand in het leveranciersformulier aanvinkt dat IBAN en btw-nummer bij de leverancier zijn nagegaan. Bestaande inboxleveranciers zijn ook gemarkeerd. Gerrie en de API kunnen dit vinkje niet zetten. |
| midden | **Inkoopfacturen** kregen nooit een betaalstatus. Gerrie noemde betaalde facturen open of te laat, met het risico van dubbel betalen. | De betaalstatus volgt de bankboekingen, ook bij "ongedaan maken". Bestaande inkoopfacturen zijn bijgewerkt. |
| midden | **De matcher** zocht een factuurnummer als losse letters in de banktekst, ook bij betaalde facturen, en vóór de bankregels. "42" paste op elke pinbetaling "Shell 4211". | Een kenmerk telt alleen als los kenmerk van minstens drie tekens (alleen cijfers: vanaf vijf), en alleen bij een factuur die nog openstaat. |
| midden | **Datums in een CSV** zonder voorloopnul (zo slaat Excel een Rabobank-CSV op) werden maand-dag gelezen en een dag verschoven: 5-1-2026 werd 30 april, 13-1-2026 viel weg. | Een Nederlandse datum is altijd dag-maand-jaar, zonder Date-gok en zonder UTC. |
| midden | **MT940:** een `:86:` na het eindsaldo (ING zet daar `/SUM/`) overschreef de omschrijving van de laatste transactie van de dag, en daarmee het factuurnummer. | Na het eindsaldo hoort niets meer bij een transactie. |
| midden | **CSV:** de kolom "Type betaling" (Knab) gold als af/bij-kolom. Alle uitgaven werden ontvangsten, zonder waarschuwing. | Een kolom telt alleen als af/bij-kolom als de waarden er ook zo uitzien. |
| midden | **Scan van een inkoopfactuur:** de valuta viel weg, zodat $ 500 als € 500 werd geboekt. | De valuta gaat mee. Bij een andere valuta toont het formulier wat je moet doen; boeken in vreemde valuta weigert de database al. |
| laag | De **Belastingdienst** ging altijd naar 1530 (btw), ook bij loonheffing of Vpb op hetzelfde IBAN. | Alleen bij een passend btw-saldo of btw in de omschrijving. |
| laag | Een **banktransactie in een andere valuta** werd als euro's geboekt. | Geweigerd, met uitleg. |
| laag | **CAMT.053** las alleen de saldi van dag 1, nam posten "in behandeling" mee, liet de omschrijvingen van een batch vallen en las `AddtlNtryInf` niet. | Meerdere dagafschriften van één rekening, posten in behandeling overgeslagen (met melding), en de batch- en pinomschrijving erbij. |
| laag | **Buitenlandse btw** in een e-factuur (UBL) werd als Nederlandse voorbelasting geboekt (art. 15 Wet OB). | Een waarschuwing, die het automatisch boeken ook tegenhoudt. |
| laag | **Dubbele inkoopfactuur:** alleen de inbox waarschuwde; de scan en het handmatige formulier niet. | Zelfde leverancier en factuurnummer: eerst bevestigen. |
| laag | **Bedrag van een bankregel:** "12,50" werd € 12,00. | Goed gelezen. |

### Verkoop

| Ernst | Wat er misging | Nu |
|---|---|---|
| midden | **Voorstellen van Gerrie** voor een factuur of offerte kenden geen btw-code. Na een wijziging werd een ICP- of verleggingsregel een kale 0%-regel: geen vermelding, geen controle op het btw-id, rubriek 1e in plaats van 3b. | Een regel kan een btw-code hebben. Bij een wijziging houdt een regel zonder code de code van de bestaande regel, als omschrijving of plek en tarief overeenkomen. |
| laag | **De eenheidsprijs** werd overal op centen afgerond ("1000 × € 0,13" naast € 125,00). | Tot vier decimalen waar de prijs die heeft: pdf, publieke pagina's en portaal. |
| laag | **De aanmaningsmail** rekende in UTC en schreef "reageer vóór": dertien dagen in plaats van veertien (art. 6:96 lid 6 BW). | Nederlandse datum, en "uiterlijk op", zoals de brief. |
| laag | **Databasetekst** kwam nog in het portaal (bij een mislukte betaling) en in de melding over een betaallink. | Een zin; de details staan in het logboek. |

### Schermen en exports

- **Bedragen typen:** "1.500" werd € 1,50 en "8.000.000,00" niets. Nu is
  "1.500" vijftienhonderd (`parseDutchAmount`). Dat geldt in de jaarrekening
  (balanstotaal, en daarmee de groottetoets), de Vpb-correctie, dividend,
  aandelen (ook het aantal), de terugbetaling en het bedragfilter bij
  facturen.
- **XAF:**
  - **Verlengd boekjaar:** krijgt alle perioden, niet twaalf; de eerste
    periode begint op de startdatum.
  - **Volgorde:** `taxRegIdent` staat vóór `custSupTp`, zoals de XSD van
    XAF 3.2 vraagt.
  - **Ids:** blijven binnen 35 tekens.
- **CSV:** de ICP-opgaaf en de rapportbouwer schrijven bedragen met een komma,
  zoals Nederlandse Excel verwacht.
- **Winst-en-verliesrekening, vrij bereik:** de vergelijkperiode schoof rond
  de wissel van zomer- naar wintertijd een dag op. Nu niet meer.
- **Activa:** "Huidige boekwaarde" telde verkochte activa mee. Nu niet meer.
- **Rapportsjablonen:** "Omzet per klant" en "Omzet per maand" telden de btw
  mee. Nu exclusief btw.
- **Balanstest:** de tekst noemt nu wat de database doet: de besluitdatum én
  vandaag, de laagste telt.
- **Rechtsvorm via Gerrie:** de handeling schreef de hele bedrijfsinstellingen
  terug. Wat een collega intussen wijzigde, ging zo verloren. Nu schrijft hij
  alleen de rechtsvorm.
- **Memoriaal:** een klant kan ook op een omzetregel. Zo komt een
  ICP-correctie ook in de opgaaf.

### Al opgelost door de parallelle controle van contract, offerte en factuur

KvK-nummer en btw-id op de pdf (documentopmaak), de KOR in het scherm en bij
versturen, het openstaande bedrag in portaal en op de publieke pagina, btw per
tarief in het grootboek, de totalen in de mails en de offerte-pdf, geen
herinnering of aanmaning voor een concept, een aanmaning pas na de vervaldatum,
de concept-pdf gelijk aan wat de klant krijgt, btw per tarief op de
creditnota, datums in Nederlandse tijd en notities over meerdere pagina's.

## Getest

**Op staging**, in transacties die altijd worden teruggedraaid:

- **Migratietest:** elk nieuw gedrag apart:
  - btw per tarief: € 2,47 op 1300 en € 0,43 op 1510;
  - de btw van een factuur van vóór de KOR, met de KOR aan;
  - tegenboeken van een verkoopfactuur en een betaling: geweigerd; "ongedaan
    maken" werkt;
  - inkoop: deels betaald, betaald, weigering met betaling, onbetaald na
    ongedaan maken, terug naar concept en opnieuw geboekt;
  - USD geweigerd;
  - "Betaald" met € 121 open geweigerd;
  - btw-periode met een verkeerd saldo geweigerd en met het juiste
    afgesloten;
  - desinvestering met 21%: 1100 € 1.210, 1510 € 210, rubriek 1a € 1.000 /
    € 210, en na tegenboeken weer 0;
  - de kenmerken in de banktekst;
  - "42" niet aan "Shell 4211";
  - loonheffing niet naar 1530, btw wel.
- **Eind-tot-eindcyclus per rechtsvorm:** dezelfde cijfers als zonder de
  migratie.
- **Rollen- en tenantmatrix:** 827 combinaties, geen verschil.
- **`plpgsql_check`:** geen nieuwe meldingen.

**Lokaal:**

- typecheck ✓;
- `npm test` 1072/1072, met nieuwe tests in `src/lib/financeControl.test.ts`
  en `invoiceInboxRules.test.ts`;
- `deno check`: de 34 functies uit CI en de documentopmaak zijn schoon.
  `invoice-workflow` en `client-portal` (buiten CI) houden precies dezelfde
  meldingen als vóór de wijziging.
- mobiele lay-outtest (donker en licht): 324 pagina's gemeten.
  - Eén meting haperde: de projectpagina op een tablet in donker, toen de
    migratieketen tegelijk draaide.
  - Die pagina opnieuw gemeten: alle zes de varianten in orde.
- `npm run test:loading`: alle controles geslaagd.
- de migratieketen vanaf nul (`supabase db start`): 240 van 240. Daarna de
  nieuwe migratie nog een keer: foutloos, met één versie van elke functie.

## Open punten

| Punt | Waarom nog niet |
|---|---|
| **Betaallinks zijn 30 minuten geldig** (op staging gemeten bij alle 41 links). Wie de factuur- of herinneringsmail later opent, kan niet meer online betalen; de pagina zegt dan dat er geen actieve link is. | Voorstel: de publieke factuurpagina maakt bij "Betaal nu" zelf een nieuwe checkout voor het openstaande bedrag (zoals het portaal), en de mails linken naar die pagina in plaats van rechtstreeks naar Mollie. Dit raakt de betaalflow waar de parallelle controle net aan werkte (hun open punten 4 en 6), dus eerst afstemmen. |
| Mollie-e-factuur (Peppol) bij een deelbetaling | Of Mollie dan het volle bedrag vraagt, moet op een Mollie-testaccount blijken. |
| Een 401/403 van Enable Banking zet elke bankkoppeling op verlopen | Welke status Enable Banking geeft bij een fout in onze eigen sleutel, moet eerst blijken. |
| De hoofdsom van een verstuurde aanmaning in het register, en de brief zelf bewaren | De brief zelf klopt; alleen het register loopt achter. Bewaren vraagt opslag zoals bij facturen. |
| Leverdatum op de factuur (art. 35a lid 1 onder g) | Alleen verplicht als die afwijkt van de factuurdatum. Een nieuw veld is een productkeuze. |
| Winst-en-verliesrekening "Jaar" volgt de startmaand, niet de tabel met boekjaren | Een verlengd eerste boekjaar kun je zien met "Vrij". |
| Een verkeerde of dubbele bankrij verwijderen | Bankregels zijn bewust alleen-lezen (spoor van wat de bank aanleverde). Verwijderen vraagt een keuze over dat spoor. |
| XAF tegen de officiële XSD valideren | De XSD staat niet in de repo; de volgorde volgt de XSD van XAF 3.2. |
