# De gekoppelde AI mag het nu ook zelf doen

**18 september 2026 · fase D · volgt op [CHANGELOG_MCP_TOEZICHT_2026-09-17.md](CHANGELOG_MCP_TOEZICHT_2026-09-17.md)**

Fase B liet de eigen AI van een klant wijzigingen *klaarzetten*. Dat is de veilige
standaard en blijft het, maar het is niet altijd het antwoord dat iemand wil. Wie
zijn AI vraagt "zet die factuur op betaald", wil niet horen dat het klaarstaat.

Vanaf nu kan hij dat per koppeling zelf omzetten, onder **Instellingen → AI**.

## Twee schakelaars, geen één

"Rechtstreeks uitvoeren" is één wens maar niet één risico. Een projectstatus die
verkeerd gezet wordt zet je terug; een aanmaning die naar de verkeerde klant ging
niet. De registry wist dat verschil al — `risk: 'high'` op 69 van de 188
schrijf-handelingen, en daarom heet de knop in de app daar *Definitief uitvoeren*
— en dat verschil loopt hier door:

- **Mag rechtstreeks uitvoeren** — omkeerbare handelingen gebeuren meteen.
- **Ook onomkeerbare handelingen** — post naar klanten, aangiftes, boekingen,
  publieke links. Apart aan te zetten, standaard uit, met een vraag vooraf die
  zegt wát er onomkeerbaar is in plaats van dát het onomkeerbaar is.

Zaten ze in één knop, dan koos de gebruiker tussen "mijn AI mag niets doen" en
"mijn AI mag mailen naar klanten" — en dan zet hij hem uit, of hij zet hem aan en
schrikt een keer.

## Waar de schakelaar staat, en waar niet

**Niet op het toestemmingsscherm.** Dat scherm bereik je door in je AI-app op
*Connect* te klikken; dat is niet het moment om af te spreken dat die AI voortaan
ongevraagd mag boeken. Daar kiest de gebruiker dus nog steeds alleen tussen
meelezen en klaarzetten, en staat er bij dat hij het rest zelf aanzet als hij het
wil. Koppelt hij opnieuw, dan begint die keuze weer bij uit.

**Alleen bij je eigen koppelingen.** Een owner ziet sinds gisteren ook die van
zijn team en kan ze stoppen — dat is toezicht. Maar iemand anders méér laten doen
met zijn AI is geen toezicht; dat is namens hem een keuze maken die zíjn rechten
gebruikt. Stoppen kan altijd, verruimen alleen zelf.

Dat staat niet alleen in het scherm. De trigger op `mcp_grants` laat een
scope-wijziging alleen toe van de eigenaar, binnen `scope_ceiling` (wat de
AI-client bij het koppelen vroeg, nu bewaard omdat het ondertekende verzoek weg
is zodra het koppelen klaar is), en zonder losse treden: `execute_high` bestaat
niet zonder `execute`, en niets bestaat zonder `read`. Een scherm is geen slot.

## Uitvoeren zonder de 188 uitvoerders te kopiëren

Hier zat het echte probleem. De schrijf-handelingen hebben hun uitvoerder in de
**browser** (`src/lib/actions/`), bovenop `repository.ts` — met opzet een
doorgeefluik naar dezelfde opslagweg als de knop in het scherm. Een AI-koppeling
draait headless; daar is die browser er niet.

Alles naar Deno kopiëren levert een tweede implementatie op die stil uit de pas
gaat lopen, en juist bij de handelingen waar dat het duurst is (een mail, een PDF,
een bestand in R2) zit de logica niet in de query maar in alles eromheen.

Dus staan in `supabase/functions/_shared/actions/apply.ts` alleen de handelingen
waarvan de serverkant **aantoonbaar dezelfde** is: één org-scoped insert of
update, verder niets. Dat zijn er nu 36 — klantgegevens en klantvelden, mappen en
inhoud verplaatsen, tickets, uren, projectinstellingen, factuurstatus, grootboek-,
leveranciers- en bankstamgegevens, rapportages, galerijen. Vier ervan zijn
`risk: 'high'` en vragen dus die tweede schakelaar.

De overige 152 vallen terug op een voorstel. **Dat is de terugval en geen fout:**
de gebruiker vroeg iets te doen, en "klaargezet, keur het goed" is daar het
eerlijke antwoord op — beter dan een weigering waar hij niets mee kan.

## Wat het model te horen krijgt

Een tool erbij, `execute_action`, en alleen voor een koppeling die mag uitvoeren:
wat er niet is, kan een model ook niet proberen. Het antwoord draagt een `status`
die het verschil hard maakt — `uitgevoerd` of `klaargezet_voor_goedkeuring`, met
een `reason` waarom. In `find_actions` staat het er vooraf al bij als `direct:
true` of `direct: false`, zodat het model kan kiezen in plaats van gokken.

Die `reason` is geen beleefdheid. Een model dat alleen "klaargezet" terugkrijgt op
een vraag om iets te dóén, probeert het de volgende keer gewoon opnieuw; eentje
dat weet dat DEZE handeling nu eenmaal langs een mens gaat, zegt dat tegen de
gebruiker en houdt op.

De koppelinstructies zijn navenant aangepast, met één regel die er bij het
klaarzetten niet stond: *voer pas iets uit als hij daar duidelijk om vraagt;
twijfel je, vraag het dan eerst — een uitvoering draait niemand voor je terug.*

## Wat er niet verandert

- **De organisatie komt uit de koppeling**, nooit uit wat het model meestuurt.
- **De payload komt uit ons `plan()`**, niet uit het model. Het model levert
  invoer; wij zoeken de rijen op, controleren ze binnen de organisatie en bepalen
  wat er precies gebeurt. Dat pad is hetzelfde gebleven — er is geen tweede manier
  bijgekomen waarop een model bepaalt wat er in de database komt.
- **De modulerechten van het teamlid gelden onverkort.** Een member met Financiën
  op "lezen" voert via zijn AI geen factuurstatus om, hoe de schakelaars ook staan.
- **Intrekken werkt meteen** en annuleert wat er nog klaarstond.

Wat wél wegvalt is de tweede grens die het uitvoeren-in-de-browser oplegde: RLS
onder een menselijke sessie. Dat is precies waarom de lijst in `apply.ts` met de
hand is nagelopen en waarom het risiconiveau een aparte schakelaar heeft.

## De melding

Dezelfde push als bij een voorstel, met "heeft iets uitgevoerd" erin. Bij een
voorstel is die melding een verzoek; bij een uitvoering is het het enige moment
waarop de gebruiker ziet dat er iets in zijn administratie is gewijzigd terwijl
hij ergens anders mee bezig was. Geen nieuw push-type — wie het belletje van zijn
AI uit zette, heeft het voor allebei uit staan.

## Wat de tests bewaken

`mcpExecute.test.ts` — 15 tests langs de vier grenzen: wat kán (elke uitvoerder
hoort bij een bestaande schrijf-handeling, én bij een uitvoerder in de browser,
anders kan een mens niet goedkeuren wat een AI zelf wél doet), wat mág (de tool
bestaat alleen met de scope, en toetst het risico van het gebouwde plan en niet
dat van de handeling in het algemeen), wie beslist (het toestemmingsscherm deelt
geen uitvoerrecht uit; alleen de eigenaar verruimt; geen losse treden), en dat de
trap in de browser dezelfde is als op de server — lopen die uit de pas, dan
weigert de database een stand die het scherm net heeft aangeboden.

Plus drie in `mcpAuth.test.ts` op de scope-trap (en de bestaande scope-tests
bijgewerkt op de twee nieuwe niveaus), en twee nieuwe in
`actionTenancy.test.ts`: sinds de registry ook echt wegschrijft, moet elke insert
de organisatie **zetten** (filteren kan een insert niet) en mag geen patch
`organization_id` bevatten — anders wordt een rij binnen de eigen organisatie
gevonden en naar een andere geschreven.

## Wat er níét in zit

| Niet gebouwd | Waarom |
|---|---|
| Server-uitvoerders voor de andere 152 | De dekking groeit per handeling, niet in één keer. Wat mail verstuurt, een PDF rendert of bestanden aanraakt hoort er bewust niet bij te komen: daar is de browser-uitvoerder geen query maar een weg langs een half systeem. |
| Rechtstreeks uitvoeren aanzetten bij het koppelen | Zie hierboven: verkeerde scherm, verkeerd moment. |
| Een admin die het voor een teamlid aanzet | Stoppen is toezicht, verruimen is een keuze met andermans rechten. |
| Een scherm met alles wat een gekoppelde AI heeft uitgevoerd | Het staat in `ai_action_audit` met koppeling, client en tijdstip erbij, maar er is nog geen overzicht voor de gebruiker zelf. Dat is een eigen vraag — ook voor de opvragingen uit fase A. |

Nagemeten: `npm test` 238 tests groen (218 + 20 nieuw), `npm run typecheck` en
`npm run build` groen, `deno check` groen op beide edge functions. Eén migratie
erbij (vijf in totaal voor de connector).
