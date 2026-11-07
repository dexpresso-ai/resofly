# Controle marketingfunctie — 7 november 2026

Vraag: "Controleer of de marketingfunctie veilig is en goed werkt."

Bekeken is de module Marketing: campagnes, follow-up-stromen en de
afmeldlijst, met alles wat daaraan hangt (database, de edge functions
`campaigns` en `email-unsubscribe`, de tracking via `resend-webhook`, het
scherm, en de handelingen van Gerrie en de MCP-koppeling). Contracten en
galerijen staan in hetzelfde handelingenbestand maar horen bij Financiën en
Projecten; die vallen erbuiten.

## Kort

De basis is degelijk: elke organisatie blijft in haar eigen wereld, de
modulerechten zitten op elke tabel, alleen de server schrijft ontvangers, en
elke marketingmail heeft een ondertekende afmeldlink. Maar er zaten twaalf
fouten in, waarvan vier ernstig:

1. **Een campagne bereikte soms maar de eerste honderd ontvangers**, en stond
   dan op "Verzonden".
2. **De ontvangerslijst van een campagne laadde nooit** (een kolom die niet
   bestaat).
3. **Elk teamlid kon een afmelding ongedaan maken**, en de persoon daarna weer
   mailen. In strijd met de AVG en de Telecommunicatiewet.
4. **De afmeldpagina meldde "Je bent afgemeld" ook als er niets was
   opgeslagen.**

Elf zijn hersteld in deze branch; per punt staat hieronder wat er misging en
hoe het nu is. Daarnaast staan er zeven open punten, met één die je op staging
met één klik moet nalopen: of de afmeldpagina in een browser als pagina
verschijnt (punt O1).

Op staging is marketing nog nooit gebruikt: drie concept-campagnes, nul
ontvangers, geen stromen, geen afmeldingen (alleen gelezen, 7 november). Er is
dus nog niemand door deze fouten geraakt.

## Wat goed zit

- **Organisatiegrens.** De functie `campaigns` controleert het lidmaatschap en
  filtert elke query op `organization_id`. Een eigenaar van een andere
  werkruimte krijgt 403 (getest).
- **Modulerechten.** Alle zeven marketingtabellen hebben de restrictive
  policies en de schrijftrigger van 20260730100000. De functie leest het
  niveau zelf (`getModuleLevel`), want hij draait op de service-role. Kijker,
  boekhouder en lid zonder Marketing worden geweigerd (getest).
- **Ontvangers, inschrijvingen en verzendingen** schrijft alleen de server. De
  claim-functies voor de verzendronde staan alleen open voor de service-role
  en gebruiken `for update skip locked`. Elke mail heeft een vaste
  idempotency-sleutel bij Resend: een herhaalpoging na een crash verstuurt niet
  dubbel.
- **Afmelden.** Het token is HMAC-SHA256 over organisatie en adres, met een
  tijdsonafhankelijke vergelijking; een vervalste handtekening werkt niet
  (getest). Openen alleen meldt niet af (bevestigen met een knop, tegen
  link-scanners). Afmelden met één klik volgens RFC 8058 werkt, met de headers
  `List-Unsubscribe` en `List-Unsubscribe-Post` in elke campagne- en
  stroommail (getest). Zonder `UNSUBSCRIBE_SECRET` gaat er geen marketingmail
  uit.
- **De afmeldlijst** geldt bij het vastleggen van de ontvangers, nog eens per
  batch, en een trigger zet lopende ontvangers en inschrijvingen meteen stil.
  Een bounce of spamklacht komt er vanzelf op.
- **Geen open relay.** Een testmail gaat alleen naar je eigen adres of een
  actief teamlid (getest), en elke organisatie heeft een mailquotum.
- **Inhoud.** Klantwaarden in de tekst worden ge-escaped; onderwerp, preheader
  en accentkleur worden in het mailsjabloon ontsmet. De app toont verstuurde
  mail alleen na `sanitizeEmailHtml`.
- **Gerrie en MCP** zetten alles klaar; een mens voert uit, met zijn eigen
  rechten, langs dezelfde functie als de knop.

## Bevindingen, en hoe ze nu zijn

### 1. Een campagne kreeg maar een deel van de doelgroep (ernstig)

"Nu versturen" zette de campagne eerst op *verzenden* (met `started_at`) en
berekende daarna de doelgroep. De verzendronde draait elke minuut (pg_cron op
staging). Viel die ronde in die tussentijd, dan zag hij een campagne zonder
ontvangers, telde nul wachtenden en zette hem op *verzonden*. Daarna kwamen de
ontvangers alsnog in de lijst en ging de eerste batch (honderd) uit; de rest
bleef voor altijd wachten, want de ronde kijkt alleen naar campagnes op
*verzenden*. Hoe groter de klantenlijst, hoe langer het berekenen en hoe groter
de kans.

**Nu:** `started_at` blijft leeg tot de ontvangerslijst klaarstaat, en de
verzendronde slaat een campagne zonder `started_at` over. Valt de functie om
tijdens het klaarzetten, dan maakt de verzendronde het na tien minuten zelf af
(het klaarzetten is idempotent). De ingeplande route deed het al in de goede
volgorde.

*Bewijs:* in de stroomtest valt een verzendronde precies midden in het
klaarzetten. Oude code: 5 van de 12 mails, campagne op *verzonden*. Nieuwe
code: 12 van 12. Een tweede stap zet een campagne op *verzenden* zonder
`started_at`: vers laat de ronde hem staan, na de wachttijd maakt hij hem af.

### 2. De ontvangerslijst laadde nooit (ernstig)

Het scherm vroeg de kolom `created_by` op bij `email_campaign_recipients`. Die
kolom bestaat niet (ook niet op staging: gecontroleerd). PostgREST weigert dan
de hele vraag: in de campagnedetails stond een foutmelding in plaats van wie
er opende, klikte of antwoordde.

**Nu:** de kolom is weg uit de lijst en uit het type. Een nieuwe test
(`src/lib/marketingColumns.test.ts`) legt de kolomlijsten van het scherm naast
de migraties, zodat dit niet stil terugkomt.

*Bewijs:* oude code `400 column email_campaign_recipients.created_by does not
exist`; nieuwe code 12 ontvangers.

### 3. Een afmelding was ongedaan te maken (ernstig, AVG)

Onder Afmeldingen stond bij elk adres "Weer toestaan", ook als de ontvanger
zich zelf had afgemeld of de mail als spam had gemeld. De database liet het toe
voor iedereen met schrijfrecht op Marketing. Daarna kreeg die persoon gewoon
weer campagnes. Gerrie waarschuwde ervoor, maar zette het wel klaar.

**Nu:** het team kan alleen nog opheffen wat het zelf of de techniek erop zette:
een handmatige blokkade of een bounce. Een afmelding of spamklacht blijft
staan. De database dwingt het af (policy in 20261107140000), het scherm toont
daar een slot met uitleg, Gerrie zet zo'n voorstel niet meer klaar, en
`removeSuppression` meldt het als er niets is weggehaald (eerst: "opgeheven"
terwijl de database niets deed). Opnieuw aanmelden kan dus alleen de ontvanger
zelf; daar is nog geen weg voor (zie O6).

*Bewijs:* oude code: het lid haalt de afmelding weg (`200`, de rij is weg).
Nieuwe code: lid en eigenaar halen niets weg; een handmatige blokkade kan wel.

### 4. "Je bent afgemeld" zonder dat er iets was opgeslagen (ernstig, AVG)

`email-unsubscribe` keek niet of het wegschrijven lukte (supabase-js gooit
niet, het geeft `{ error }` terug). Mislukte het, dan las de ontvanger toch dat
hij was afgemeld, en bleef hij mail krijgen.

**Nu:** elke stap controleert zijn fout; bij een fout toont de pagina "Er ging
iets mis" (500) en kan de ontvanger het opnieuw proberen.

*Bewijs:* een geldige link van een werkruimte die niet meer bestaat: oude code
`200 Je bent afgemeld`, nieuwe code `500`.

### 5. Pauzeren en annuleren stopten de lopende batch niet

De verzendronde verstuurde een opgepakte batch (tot honderd) helemaal, ook als
iemand intussen op Pauzeer of Annuleer drukte. Na annuleren bleven de
wachtenden op "In wachtrij" staan, ook in de tellingen, terwijl er nooit meer
iets zou gebeuren.

**Nu:** de ronde kijkt vóór elke mail naar de status. Gepauzeerd: de rest gaat
terug in de wachtrij. Geannuleerd: de rest wordt *overgeslagen*. Annuleren
zet ook alles wat nog wacht op *overgeslagen*.

*Bewijs:* pauze na de tweede mail van een batch van vijf: oude code 5 mails,
nieuwe code 2, en na hervatten de rest. Annuleren: oude code 6 wachtend, nieuwe
code 0 wachtend en 6 overgeslagen.

### 6. Klantgegevens voor wie Klanten niet mag zien (harde regel 3)

De doelgroeptelling gaf twintig adressen met naam terug, en de testmail vulde
de variabelen met een echte klant (naam, adres, telefoon, vrije velden). Ook
voor een teamlid met Marketing maar zonder Klanten: zo las hij klantgegevens in
zijn eigen inbox. Gerrie zette bij "blokkeren" en bij een handmatige doelgroep
klantnamen op de kaart.

**Nu:** zonder Klanten geeft de telling alleen aantallen, en krijgt de testmail
voorbeeldwaarden ("[Klantnaam]"). Gerrie laat de namen dan weg
(`ctx.canRead('clients')`). Met Klanten verandert er niets.

*Bewijs:* oude code: twaalf adressen en "Bakkerij 7" in de testmail van het
lid zonder Klanten. Nieuwe code: geen adressen, "[Klantnaam]".

### 7. De afzender was vrij te kiezen

Campagne- en stroommail gaat uit met de persoonlijke afzender van
`created_by` (naam en adres op het eigen domein). Die kolom kon elk teamlid via
de API zetten, ook op een collega. Zo ging een campagne uit op naam van
bijvoorbeeld de eigenaar.

**Nu:** een trigger zet de maker (de ingelogde gebruiker) en houdt hem vast bij
wijzigen, zoals bij boekingen (20261101120000). De service-role houdt wat hij
meegaf.

*Bewijs:* oude code: maker = de eigenaar, ingevuld door een lid. Nieuwe code:
het lid, ook na een poging het te wijzigen; bij stromen hetzelfde.

### 8. De platte tekst bleef de oude

Een campagne die Gerrie opstelde heeft een eigen platte tekst. Het scherm
bewerkt alleen de HTML, dus na bewerken bleef de platte tekst Gerries eerste
versie. Wie de tekstversie las (en een spamfilter dat beide vergelijkt) kreeg
iets anders dan de HTML. Bij stappen van een stroom net zo.

**Nu:** het scherm slaat de platte tekst leeg op; de verzending maakt hem uit
de HTML. Gerrie leest bij `flow.get` de tekst uit de HTML als er geen platte
tekst is (punt 11).

### 9. Een spamklacht na een handmatige blokkade bleef opheffbaar

Stond een adres al op de lijst als handmatige blokkade of bounce, dan bleef die
reden staan bij een klacht of een afmelding via de link. Met punt 3 betekende
dat: het team kon de blokkade van iemand die zich afmeldde toch opheffen.

**Nu:** een klacht maakt er *klacht* van, een afmelding via de link
*afgemeld*.

*Bewijs:* oude code: na een klacht reden "manual". Nieuwe code: "complained",
en weghalen lukt niet.

### 10. Triggers zonder organisatiefilter (harde regel 1)

De security-definer-triggers op `client_emails` werkten campagne- en
stroomrijen bij op id of thread, zonder te filteren op organisatie. Misbruik
was niet mogelijk (de moduletrigger houdt een ingelogde gebruiker van een
andere organisatie tegen, en de ids komen van de server), maar de regel is:
wie RLS overslaat, filtert zelf.

**Nu:** ze filteren op de organisatie van de mail. Voordat ik ze verving heb
ik de versie op staging naast de migratie gelegd (md5 van de functietekst):
gelijk.

### 11. Gerrie zag de tekst van stappen uit het scherm niet

`flow.get` gaf alleen `body_text`, en stappen uit het scherm hebben alleen HTML.
Het model zag dus lege stappen. `flow.set_steps` vervangt de héle reeks; wie
één stap liet aanpassen, liep het risico dat het model de andere moest raden.

**Nu:** `flow.get` maakt de tekst uit de HTML als er geen platte tekst is.

### 12. Een regeleinde in het onderwerp

Een klantnaam met een regeleinde (een CSV-import) kwam via `{{klantnaam}}`
letterlijk in het onderwerp. Nu worden onderwerp en preheader na het invullen
één regel.

## Open punten (niet in deze branch)

- **O1. Toont de afmeldpagina als pagina?** De link in de mail wijst naar de
  functie op het standaardadres van Supabase
  (`<project>.supabase.co/functions/v1/email-unsubscribe`). Voor zover ik weet
  geeft Supabase een HTML-antwoord op een GET daar als platte tekst door, tenzij
  er een eigen domein voor de functies staat. Dan ziet de ontvanger de broncode
  in plaats van de knop. De documentatie was vanuit deze sessie niet bereikbaar
  en staging ook niet, dus ik kon het niet nagaan. Afmelden met één klik vanuit
  Gmail of Apple Mail (een POST) werkt hoe dan ook. **Controle:** stuur op
  staging een testmail van een campagne naar jezelf en klik op "Afmelden voor
  deze mails". Is het platte tekst, dan hoort de bevestiging in de app (zoals
  de factuurpagina) of achter een eigen domein.
- **O2.** Inhoud en status van een lopende of verzonden campagne, en de
  stappen van een lopende stroom, zijn via de API nog te wijzigen. Het scherm
  en de RPC voorkomen het; de policies niet. Geen rechtenverhoging (het kan
  alleen met schrijfrecht op Marketing), wel een gat in de integriteit.
- **O3.** Valt de functie om tussen het versturen en het bijwerken van een
  ontvanger, dan pakt de ronde hem na een kwartier opnieuw op. Er gaat geen
  tweede mail uit (Resend-idempotency), maar er komt een tweede gesprek in de
  mailgeschiedenis van de klant. De stromen doen dit al goed (ze hergebruiken de
  thread); campagnes nog niet.
- **O4.** Activeren van een stroom verwerkt in hetzelfde verzoek de
  verzendronde van alle organisaties. Veilig (alles blijft per organisatie),
  maar het maakt één klik trager naarmate er meer stromen lopen.
- **O5.** Het scherm laat inplannen in het verleden toe (dan gaat hij bij de
  volgende ronde uit). Gerrie weigert dat al.
- **O6.** Opnieuw aanmelden: een ontvanger die zich afmeldde kan dat nu niet
  meer terugdraaien, en het team ook niet (punt 3). Wil je dat mogelijk maken,
  doe het dan met nieuwe toestemming van de ontvanger zelf (bijvoorbeeld een
  bevestigingsmail), niet met een knop voor het team.
- **O7.** Het afmeldtoken bevat het e-mailadres (base64, niet versleuteld) en
  staat dus in logboeken van wie de URL ziet. Gangbaar en laag risico.

## Getest

- **Stroomtest** `tests/stromen/marketing.mjs` (nieuw, 28 stappen): de echte
  functies `campaigns`, `email-unsubscribe` en `resend-webhook` tegen een
  lokale database met alle migraties, echte gebruikers en rechten, en
  nep-Resend. Op de code van vóór deze controle: 27 stappen, 16 fout (11
  rechtstreeks door de fouten hierboven, 5 als gevolg daarvan). Met de
  herstellingen: 28 stappen, 0 fout.
- **De hele stroomtest** (alle scenario's): 682 stappen, 0 fout.
- `npm test`, `npm run typecheck`, `deno check` op de 34 functies uit de CI,
  en de migratieketen vanaf nul: zie
  `docs/changelog/CHANGELOG_MARKETING_CONTROLE_2026-11-07.md`.
