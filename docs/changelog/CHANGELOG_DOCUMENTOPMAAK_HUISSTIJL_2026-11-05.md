# Changelog — Documentopmaak en huisstijlcontrole — 2026-11-05

## Aanleiding

> Controleer of de brandinginstellingen goed staan voor de gebruiker, zodat de klantpagina,
> offerte, facturen, contracten, kleuren etc. goed staan.
>
> Bouw daarbij een functionaliteit in om de offerte, facturen variabele datavelden zelf op een
> document te kunnen slepen en dit als standaard template te handhaven. Voer ook een standaard
> template in als gebruiker geen zin heeft om zelf te configureren.

Wat er misging toen we gingen kijken:

- **Het voorbeeld en de verstuurde PDF waren twee verschillende dingen.** De app tekende het
  voorbeeld zelf (`src/lib/pdf.ts`), de edge functions tekenden de PDF die de klant kreeg met een
  eigen, vaste opmaak. Alleen het voorbeeld gebruikte het briefpapier en de lettergrootte. Het
  voorbeeld beloofde "1:1 wat de klant ontvangt"; dat klopte niet.
- **Geen logo** op offertes en facturen, terwijl Huisstijl het logo "op alles wat je klant ziet"
  beloofde.
- **KvK- en btw-nummer vielen weg** op de verstuurde factuur, offerte, creditfactuur, aanmaning en
  het contract. Het afzenderblok herhaalde de bedrijfsnaam (soms twee keer) en `slice(0, 8)` (of
  `slice(0, 7)`) sneed daarna de nummers eraf. Met een merknaam en een volledig adres stond er
  geen KvK-nummer op, terwijl dat op elk zakelijk stuk hoort.
- **De offerte-PDF** rekende de btw als één bedrag met losse kommagetallen (niet per tarief en
  niet cent-exact) en toonde het adres van de klant niet.
- **Bij Facturatie stond een nagebouwd HTML-voorbeeld** dat niet leek op de echte PDF.
- Verder, bij een rondgang langs alles wat de klant ziet: mails waarvan de knop of de bovenregel
  onleesbaar werd bij een donkere merkkleur, ResoFly-goud waar de merkkleur hoorde, de
  werkruimtenaam in afsprakenmails, "BrandCore" als terugval in de offertemail, en een paar
  kleinere dingen (zie *Huisstijlcontrole* hieronder).

## Wat er is veranderd

### Eén opmaakmodule voor de PDF, in de app én op de server

- `src/lib/documentLayout.ts` beschrijft een offerte of factuur: de velden, de standaardsjablonen,
  de controle van wat uit de database komt, de paginering en het tekenen. pdf-lib komt als
  parameter binnen, zodat precies dezelfde code draait in de browser (npm), in de tests (node) en in
  de edge functions (esm.sh).
- `supabase/functions/_shared/documentLayout.ts` is een kopie voor de edge functions.
  `documentLayout.test.ts` vergelijkt de twee teken voor teken vanaf de markering en faalt zodra ze
  uit elkaar lopen. **Pas ze altijd samen aan.**
- `invoice-workflow` en `quote-workflow` tekenen de verstuurde PDF hiermee
  (`_shared/documentPdf.ts`), met de opmaak, het logo en het briefpapier van de organisatie. Het
  briefpapier (soms een paar MB) wordt alleen opgehaald als er echt een PDF wordt gemaakt.
- Het voorbeeld naast de editor, de detailweergave en "Download concept-PDF" in de app krijgen nu
  ook de btw-codes, de projectnaam en het offertenummer mee. Die staan op de verstuurde PDF; zonder
  liep het voorbeeld daarop achter.
- Wat er nu altijd op staat: logo (of de naam als er geen logo is), de juridische naam boven het
  adres als de merknaam anders is (maar niet dubbel), KvK, btw-nummer en IBAN los van het adres, de
  btw per tarief met de grondslag, de verplichte btw-vermeldingen (ook op de offerte), en
  "Pagina 1 van 2" onderaan.
- Bedragen: dezelfde rekenregels als `src/lib/money.ts` (cent-exact, btw per tarief afgerond). De
  test vergelijkt 200 willekeurige documenten met de geldmodule van de app.
- Tekst die de standaardletters van een PDF niet kennen (een emoji) valt weg in plaats van de hele
  PDF te laten mislukken; het euroteken staat er nu als €.
- Een logo of briefpapier dat niet te lezen is laat de PDF niet mislukken: dan zonder, met een
  waarschuwing in het log. WebP kan een PDF niet aan; dan staat de naam er (de logo-upload maakt
  er al PNG of JPEG van).
- Lettertype: een PDF heeft zonder ingesloten bestanden alleen Helvetica, Times en Courier. Bij
  *Zoals je huisstijl* krijgt een merk met een schreefletter (Playfair, Cormorant, Lora) Times,
  de rest Helvetica. (Achterhaald door de tweede ronde: de PDF sluit nu de echte letters in.)
- De merkkleur als tekst op wit papier wordt donkerder tot hij 4,5 : 1 haalt (merkgoud was als
  titel onleesbaar); vlakken en lijnen blijven de merkkleur zelf.

### Instellingen → Documentopmaak: velden zelf op de pagina slepen

- Een nieuw tabblad. Links de velden (jouw bedrijf, klant, document) en vormen (eigen tekst, logo,
  lijn, vlak), in het midden het A4-blad, rechts de instellingen.
- **Slepen of klikken**: sleep een veld naar de pagina, of klik erop (toetsenbord: Enter) en het
  komt op een vrije plek. Op een aanraakscherm voegt tikken toe en kiest tikken een blok; een
  gekozen blok sleep je met je vinger.
- **Verplaatsen en schalen** met de muis, met hulplijnen (kantlijnen, het midden, de randen van
  andere blokken; Alt houdt slepen los). Pijltjestoetsen schuiven 1 pt, met Shift 10 pt. Delete
  verwijdert, Ctrl+D dupliceert, Ctrl+Z en Ctrl+Shift+Z maken ongedaan en opnieuw.
- **Wat je ziet is de PDF.** Het blad is het plan van de opmaakmodule zelf, als SVG getekend en
  gemeten met de lettertypen van pdf-lib: elke regelbreuk is dezelfde als in de PDF. Met
  *PDF-voorbeeld* zie je de echte PDF, met briefpapier.
- **Drie zones.** De kop (pagina 1, of elke pagina met *De kop op elke pagina herhalen*), de inhoud
  (regels, totalen, btw-vermeldingen, betaling, notities, online link, met een eigen inleiding en
  afsluiting) die doorloopt op een volgende pagina, en de voet (elke pagina). Zet je een veld net
  boven de regels, dan zakken de regels mee; een groeiend klantadres duwt het blok eronder en de
  regels omlaag in plaats van eroverheen te vallen.
- **Inhoud instellen**: volgorde, welke kolommen (aantal, prijs, btw), bedrag per regel inclusief of
  exclusief btw, tabelstijl en hoe het totaal eruitziet. Inleiding en afsluiting kunnen velden
  bevatten: `{{klant.contactpersoon|klant.naam}}` valt terug op de klantnaam.
- **Controle**: ontbreekt iets wat op een factuur of offerte moet (nummer, datum, je naam en adres,
  KvK-nummer, btw-nummer behalve met de KOR, naam en adres van de klant), dan staat dat er met een
  knop om het toe te voegen. Met briefpapier zegt de melding dat het daar ook mag staan.
- **Stijl** staat hier bij elkaar: lettertype, lettergrootte, tekstkleur en briefpapier. Merkkleur
  en logo komen uit Huisstijl (één plek voor het merk).
- Factuur en offerte hebben elk een eigen opmaak; *Ook voor offertes/facturen* kopieert hem.
- Opslaan gaat met de knop van de instellingenpagina. Wat al verstuurd is, verandert niet: de
  verzonden PDF is een opgeslagen momentopname.

### Standaardsjablonen, voor wie niet zelf wil schuiven

- **Standaard** — logo en een balk in de merkkleur bovenaan, de klant links, de documentgegevens
  rechts. Dit krijgt iedereen die niets instelt, en het groeit mee met verbeteringen in ResoFly
  (een niet-aangepaste opmaak wordt als `null` opgeslagen, niet als kopie).
- **Strak** — veel wit, de titel in de merkkleur, het totaal in een vlak.
- **Voor briefpapier** — laat boven en onder ruimte vrij voor je eigen papier.
- Met eigen briefpapier en zonder eigen opmaak valt de gekleurde balk weg, zoals vroeger.

### Database

- Migratie `20261105100000_document_layouts.sql`: `company_settings.document_layouts` (jsonb,
  `null` = standaard), met een CHECK op type (object) en grootte (256 kB; het grootste wat de
  editor kan maken is ~110 kB). De inhoud keurt de code bij opslaan én bij het tekenen
  (`normalizeDocumentLayout`): wat uit de database komt, wordt nooit blind getekend.
- Zelfde rechten als de rest van `company_settings`: lezen voor leden, wijzigen voor owners en
  admins.
- Wordt de app eerder uitgerold dan de migratie, dan slaat de rest van de instellingen gewoon op;
  alleen een eigen opmaak geeft dan een melding. De edge functions vallen in dat geval terug op de
  standaardopmaak.

### Huisstijlcontrole: wat er verder is rechtgezet

| Waar | Wat er misging | Nu |
|---|---|---|
| Contract-PDF | Naam dubbel, KvK en btw-nummer afgekapt | Naam één keer, juridische naam eronder, KvK en btw op één regel |
| Creditfactuur, aanmaning | Idem | Idem |
| Klantmails (knop, bovenregel) | Knoptekst vast `#111111`, bovenregel in de merkkleur zelf: bij `#00084D` onzichtbaar | Tekst op de knop zwart of wit wat het best leest; merkkleur als tekst opgehelderd tot 4,5 : 1 |
| Bestandsmails | Toegangscode in de merkkleur op donker, notitiestreep in ResoFly-goud | Leesbare merkkleur, streep in de merkkleur |
| Welkomstmail portaal | ResoFly-goud | Merkkleur |
| Campagnes en flows | Nieuwe campagne of stap in ResoFly-goud | Begint in de merkkleur |
| Afsprakenmails | Werkruimtenaam (vaak het begin van een e-mailadres), geen merkkleur | Merknaam of bedrijfsnaam, merkkleur |
| Offertemail | Terugval "BrandCore" | "ResoFly", zoals de andere mails |
| Publieke factuurpagina | "Neem contact op met ." zonder bedrijfsnaam | "… met de afzender van deze factuur" |
| Klantportaal | Nieuwe kopkleur pas na een nieuwe sessie zichtbaar | Kopkleur zit in de sleutel van het thema |
| Overschrijving (portaal, aanmaning) | "T.n.v." met de merknaam | Juridische naam: de bank controleert de naam op de rekening |
| Galerij | Donker logo onzichtbaar op de donkere achtergrond; knoptekst, vinkje en hover in ResoFly-goud; tabblad "ResoFly Werkruimte" | Lichte logoversie of plaatje; tekst en hover uit de merkkleur; tabblad met de merknaam (ook bij delen en versturen) |
| Teksten bij Huisstijl en Facturatie | Beloofden logo en lettertypen in mails, accentkleur bij Facturatie | Zeggen wat er gebeurt |

## Niet gedaan (bewust, of voor later)

- ~~Logo in e-mails~~, ~~creditfactuur en aanmaning in de nieuwe opmaak~~ en ~~eigen lettertypen
  in de PDF~~: dezelfde dag gedaan in een tweede ronde, zie
  `CHANGELOG_MAILLOGO_PDFLETTERS_2026-11-05.md`. Het logo gaat als ingesloten afbeelding (cid) mee,
  dus hosten was niet nodig.
- **PDF-briefpapier in de editor.** De editor toont een afbeelding als briefpapier op het blad; een
  PDF-briefpapier zie je in het PDF-voorbeeld (de browser kan een PDF niet als achtergrond tekenen
  zonder pdf.js).
- Publieke deel- en verzendpagina: nog geen logo in de kop (wel de merknaam in het tabblad).

## Getest

- `npm run typecheck` schoon.
- `npm test`: 969 groen op de eigen branch, 983 na het samenvoegen met staging. Nieuw: `src/lib/documentLayout.test.ts` (17 tests: spiegel teken voor
  teken gelijk en zonder imports, standaard bij rommel, sjablonen overleven de controle, controle
  laat niets van buiten de pagina of lijst door, wettelijke velden in de standaard, notatie,
  juridische naam niet dubbel, alles op de pagina en de inhoud tussen kop en voet, paginering met
  elke regel precies één keer, meegroeiend klantadres, `{{velden}}` met terugval, stijl en
  lettertype, PDF met logo en briefpapier en met kapotte bestanden, app en server maken hetzelfde
  plan, bedragen gelijk aan `money.ts`, migratie), `supabase/functions/_shared/emailLayout.test.ts`
  (knop en merkkleur in mails halen 4,5 : 1 voor 14 merkkleuren) en een test op de galerijtokens in
  `branding.test.ts`.
- `deno check` schoon op de twee nieuwe gedeelde modules en op alle aangeraakte functies uit de
  CI-lijst. `invoice-workflow`, `quote-workflow` en `client-portal` staan buiten die lijst; ze
  hebben dezelfde (bestaande) Deno-fouten als staging (12, 9 en 1), ook na het samenvoegen. De
  twee gedeelde modules staan nu wel in de CI-controle. (Lokaal gecontroleerd met een import map
  naar dezelfde npm-pakketten: esm.sh is vanuit de cloudsessie niet bereikbaar.)
- Mobiele lay-outtest (`--theme=both`), met de nieuwe pagina `settings-documenten`: 294 pagina's,
  0 met problemen. Na het samenvoegen met staging de geraakte pagina's opnieuw (publieke offerte,
  factuur, contract en galerij, facturen, offertes, bank, instellingen, portaal): 66 pagina's, 0
  met problemen. Eén eerdere ronde gaf één misser terwijl Docker tegelijk de database opbouwde; de
  twee rondes daarna waren schoon.
- `npm run test:loading`: alle controles geslaagd. `vite build` lukt.
- Migratieketen vanaf nul (`supabase db start`, Docker): alle 236 migraties toegepast, ook
  `20261105100000`. De CHECK geweigerd op een lijst en op een te groot object, een gewone opmaak
  toegelaten. Op staging is de laatste migratie `20261105010000`; deze komt daarna.
- Interactietest met Playwright tegen de nagebootste backend: slepen, hulplijnen, pijltjes,
  eigenschappen, ongedaan maken en opnieuw, sjabloon, offerte met inleiding, controle met
  Toevoegen, PDF-voorbeeld, klik naast een blok en Opslaan (met de opgeslagen opmaak
  gecontroleerd): 25/25. Op telefoonformaat met touch: 5/5.
- Voorbeeld-PDF's gerenderd en bekeken: drie sjablonen voor factuur en offerte, een factuur van drie
  pagina's, en de contract-PDF.

## Uitrol

Op de branch `ccr-f419f057-zisitq`, samengevoegd met de nieuwste staging. Nog niet op staging:
samenvoegen naar `staging` en pushen rolt de app uit (Cloudflare Pages) en zet de migratie en de
edge functions klaar (workflow *Deploy Supabase (staging)*). Migraties gaan daar vóór de functies;
draait een functie toch eerder, dan valt hij terug op de standaardopmaak.
