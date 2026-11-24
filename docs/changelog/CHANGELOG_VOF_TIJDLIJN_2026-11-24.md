# Vof: in- en uittreden met een datum, de rekening-courant en de verliesgrens

**24 november 2026 · database, rekenkern, Gerrie, auditfile, schermen en tests · staging**

Vervolg op de controle van 22 november
(`CHANGELOG_VOF_HERSTELWEGEN_2026-11-22.md`). Daar stonden vier punten onder
*Bewust open*. Die zijn nu gebouwd:

1. automatisch splitsen als iemand halverwege het jaar in- of uittreedt (eerst
   via de verdeling met een bedrag vooraf);
2. het kapitaal van een uittreder omzetten in een schuld aan hem;
3. een verliesgrens voor de commanditaire vennoot;
4. een aparte rekening-courant per vennoot.

> **Status:**
> - **Database:** één migratie,
>   `20261124120000_vof_tijdlijn_en_rekening_courant`.
> - **Rekenkern:** de raming inkomstenbelasting splitst per periode, net als de
>   database, en kent de verliesgrens.
> - **Gerrie, API en MCP:** `owners.save_partner` krijgt een ingangsdatum; de
>   afsluitkaart noemt de perioden, de rekening-courant en de verliesgrens.
> - **Auditfile:** een rekening-courant per vennoot wordt herkend.
> - **Schermen:** Vennoten, Boekjaren en de verdeling.
> - **Tests:** een nieuw stromenscenario `vof-tijdlijn`; `vof`, de
>   databasetest en de rekenkern bijgewerkt.
>
> Uitrol: zie onderaan.

## Wat er nu kan

### 1. Een tijdlijn per vennoot, en perioden binnen het jaar

Elke vennoot heeft een tijdlijn (`partnership_partner_timeline`): per
ingangsdatum zijn percentage, zijn soort (beherend of commanditair) en of hij
vennoot is.

- **Met een ingangsdatum** (Vennoten → vennoot → *Met ingang van*; Gerrie:
  `effective_date`) maak je een nieuwe stand. "Bram treedt per 1 juli uit" en
  "Chris komt per 1 juli bij, Anna gaat naar 40%" zijn zo elk één wijziging.
- **Zonder ingangsdatum:**
  - een nieuwe vennoot is er bij de eerste vennoten vanaf het begin van de
    boekhouding, en anders vanaf vandaag;
  - uittreden of weer toetreden geldt per vandaag;
  - een ander percentage of een andere soort corrigeert de stand die nu geldt.
    Die correctie raakt nooit een afgesloten jaar: ligt de stand van nu in of
    vóór het laatste afgesloten boekjaar, dan geldt de correctie vanaf de dag
    erna. Anders gaf heropenen en opnieuw afsluiten dat jaar de nieuwe
    percentages.
- Een ingangsdatum op of vóór het einde van het laatste afgesloten boekjaar
  wordt geweigerd: heropen dat jaar eerst. Ook voor een nieuwe vennoot. Een
  stand van vóór dat jaar loopt er namelijk doorheen. Zonder datum schuift een
  nieuwe vennoot naar de dag na dat jaar.
- Een verkeerde stand haal je weg (de prullenbak in het venster); de eerste
  stand van een vennoot niet, en geen stand op of vóór het laatste afgesloten
  jaar.

**Het jaar valt uiteen in perioden**, op elke ingangsdatum die erin valt. Per
periode telt het resultaat van de boekingen in die periode: een tussentijdse
resultaatbepaling, niet naar tijd. Dat resultaat gaat naar rato naar de
vennoten van die periode, met de restcent zoals altijd (grootste rest, bij
gelijke rest de laagste vennootnummer).

- Elke periode moet op 100% uitkomen, en in elke periode moet iemand
  meedoen. Anders weigert het afsluiten, met de periode erbij.
- **Een vastgelegde verdeling gaat voor.** Wie de afspraak anders maakt (een
  bedrag vooraf, een andere sleutel), legt de verdeling van het jaar vast,
  zoals eerst. Dan is het één periode.
- Het afsluiten bewaart wat het verdeelde (`fiscal_year_partner_shares` met
  `source = 'afsluiting'`). Heropenen en opnieuw afsluiten rekent opnieuw met
  de tijdlijn; een vastgelegde verdeling blijft vastgelegd.
- **Vennoten** toont per vennoot *sinds* en *uitgetreden per*, en de perioden
  van het jaar. Een afgesloten jaar toont wat er geboekt is.
- **Wat eerst weigerde, gaat nu goed.** Trad Bram in februari 2026 uit en ging
  2025 in april dicht, dan weigerde het afsluiten en moest je de verdeling van
  2025 vastleggen. Nu deed Bram in heel 2025 mee en sluit 2025 gewoon af.
- **Wijzigingen van vóór de tijdlijn** kent ResoFly alleen als "gewijzigd op".
  Daarvoor blijft de weigering van 22 november gelden: leg de verdeling van
  dat jaar vast.

### 2. Het kapitaal van een uittreder wordt een schuld aan hem

Is een vennoot aan het einde van het boekjaar uitgetreden, dan gaat bij het
afsluiten zijn kapitaal, na zijn winstaandeel en zijn privé, naar zijn
rekening-courant. Dat is wat de vof hem schuldig is (of hij de vof, bij een
negatief kapitaal).

- In het afsluitboekstuk: "Naar rekening-courant: kapitaal Bram (uitgetreden
  per 01-07-2025)".
- Vennoten toont het als *naar rekening-courant*; het eind van zijn kapitaal is
  dan € 0.
- Uitbetalen boek je via de bank op zijn rekening-courant. Eerst stond dat als
  privé-opname bij een vennoot die er niet meer was.

Stakingswinst, goodwill en de waardering blijven bij de adviseur.

### 3. De verliesgrens van de commanditaire vennoot

Een commanditaire vennoot draagt verlies tot zijn eigen vermogen bij het begin
van de verdeling (art. 20 lid 3 WvK). Het meerdere gaat naar rato naar de
beherende vennoten.

- Voorbeeld uit de test: Anna 50% en Bram 20% beherend, Kees 30%
  commanditair met € 1.000 inbreng, € 10.000,01 verlies. Kees draagt
  € 1.000, Anna € 6.428,58 en Bram € 2.571,43. Zonder grens was dat
  € 3.000 voor Kees.
- De raming, Vennoten (*verlies overgenomen*) en de afsluitkaart tonen de
  verschuiving.
- Ook met een vastgelegde verdeling: de wet laat hem niet meer dragen, welke
  afspraak er ook is.
- Zijn eigen vermogen is wat er geboekt is op zijn kapitaal en privé. Een
  toegezegde inbreng die hij nog niet stortte, telt niet mee; de wet telt die
  wel. Boek hem dan eerst als vordering op de vennoot.

De fiscale kant (verliesverrekening bij de commanditaire vennoot) is niet
nagelezen; de raming volgt de boekhouding.

### 4. Een rekening-courant per vennoot

Elke vennoot krijgt een eigen rekening-courant: 141n (1411 voor de eerste
vennoot, 1412 voor de tweede, …), een kortlopende schuld op zijn naam.

- Een lening van of aan een vennoot boek je daarop, niet op zijn privé. Op
  privé verdween ze bij de jaarafsluiting in zijn kapitaal.
- De jaarafsluiting laat de rekening-courant staan.
- Een eigen rekening met een code 141n kan niet: die is van de vennoten.
- Btw op de rekening-courant wordt geweigerd, net als op privé.
- **Auditfile:** "Rekening courant Anna" of een rekening 1411/1412 uit een
  ander pakket komt op de rekening-courant van die vennoot. Eerst ging die
  naar niets, of naar privé.

## De schermen

- **Vennoten, de tabel:** onder de naam "sinds 1 jan 2025", "uitgetreden per
  1 jul 2026" of wat er nog komt ("treedt uit per …"). *Winstaandeel nu* is de
  stand van vandaag; de rekening-courant staat bij de rekeningen.
- **Het vennootvenster** (eerst een formulier onder de tabel; nu een venster
  dat met de terugknop dichtgaat):
  - een datumveld dat zegt wat het doet: *Vennoot sinds*, *Uitgetreden per*
    (standaard vandaag), *Weer vennoot per* of *Met ingang van*;
  - eronder wat er gebeurt ("Tot en met 30 jun 2026 50%, vanaf 1 jul 2026
    100%"), en bij een correctie zonder datum na een afgesloten jaar "vanaf
    1 jan 2026";
  - een datum op of vóór het laatste afgesloten jaar zet Opslaan uit, met de
    uitleg erbij;
  - de standen onder elkaar, met een prullenbak bij elke latere stand.
- **De kapitaalvergelijking:**
  - de perioden met hun resultaat en wie wat kreeg;
  - een melding als een periode niet op 100% uitkomt;
  - de kolom *Naar rekening-courant* (bij een open jaar "bij afsluiten");
  - het blok *Rekening-courant eind …* ("nu vordering op Bram € 3.000; na het
    afsluiten schuld aan Bram € 12.000");
  - de zin over de verliesgrens;
  - uitleg over een lening, de uitbetaling aan een uittreder en rente.
- **De verdeling (venster):**
  - de perioden onder elkaar, en "50% → 30%" als een percentage in het jaar
    verandert;
  - het totaal wordt per periode gecontroleerd. Bij Bram eruit en Chris erin
    telde het eerst op tot 150%, en stond afsluiten uit.
- **Boekjaren → Afsluiten:** de perioden, de regel over de rekening-courant, en
  een blokkade die de periode noemt.
- **CSV van Vennoten:** een kolom *Naar rekening-courant*.
- **Telefoon:** de naamkolom van de vennotentabel was 80 px en brak midden in
  woorden (de telefoonregels werden overschreven); nu 104 px.

## Gerrie, API en MCP

- `owners.save_partner`: nieuw veld `effective_date`. De kaart zegt wat er
  gebeurt: "vennoot sinds …", "uitgetreden per …", "met ingang van …", of
  "correctie van de stand van nu (zonder ingangsdatum)".
- `fiscal_year.close`: de kaart noemt
  - de perioden ("2 perioden volgens de ingangsdatums bij Vennoten");
  - wie uittrad en hoeveel er naar zijn rekening-courant gaat, ook als in dat
    jaar niemand meer meedeed;
  - hoeveel verlies er van de commanditaire vennoot naar de beherende gaat.
- `owners.equity_overview`: de beschrijving noemt de nieuwe velden.

Gerrie stelt alleen voor; uitvoeren gaat langs dezelfde functie als het scherm,
met de rechten van wie goedkeurt.

## Beveiliging

- `partnership_partner_timeline` heeft RLS op `my_organization_ids()`, de
  modulepoort van Financiën en een auditlog. Niemand schrijft er rechtstreeks
  in; alleen via `save_partnership_partner` en
  `delete_partnership_partner_change`.
- Alle nieuwe functies zijn `security definer`, controleren lid en recht
  zelf, en zijn niet aan `anon` gegeven.
- De export (`exportManifest.ts`) neemt de tijdlijn mee; schemaversie
  `20261124120000`.

## Verificatie

Op een lokale stack met alle migraties, als de eigenaar met zijn eigen sessie
(RLS geldt):

- **De keten vanaf nul** (`supabase db reset`) en de nieuwe migratie daarna
  nog een keer: zonder fouten.
- **Databasetests** (`npm run test:database`): alles geslaagd, ook de
  bijgewerkte `vennoten_jaarafsluiting.sql`, met een uittreden per datum.
- **Stromentests:** de hele reeks, 1461 stappen, 0 fout. Daarin:
  - `vof-tijdlijn`, nieuw: elk van de vier punten, met Gerrie;
  - `vof`, bijgewerkt: wat eerst weigerde, gaat nu goed.
- **Zonder de nieuwe migratie** falen 25 van de 50 stappen van `vof-tijdlijn`
  en `vof`, waaronder elke nieuwe functie.
- **Unittests** (`npm test`): 2256 geslaagd. Daarin:
  - de rekenkern: perioden, prognose, restcent en verliesgrens;
  - de auditfile: een rekening-courant per vennoot;
  - de kaarten van Gerrie;
  - de CSV.
- **`deno check`** van de CI-lijst: schoon.
- **Schermen:**
  - `test:mobile --theme=both`: 914 pagina's gemeten, 0 met problemen. Nieuw
    daarin: `owners-perioden`, `owners-vennoot-datum` en
    `boekjaren-vof-uittreder`.
  - `test:loading`, `test:inrichten`: alle controles geslaagd.
  - `test:terugknop`: 16 gelukt. Nieuw: terug sluit het venster van een
    vennoot.
- **In de browser** (lokale stack, desktop en 390 × 844): een vof met Anna en
  Bram 50/50, Bram uit en Chris in per 1 juli 2026.
  - 2026 valt uiteen in twee perioden.
  - Bram gaat bij het afsluiten met zijn kapitaal naar zijn rekening-courant.
  - De afsluitvensters van 2025 en 2026 kloppen.
  - Geen JavaScript-fouten.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Splitsen naar tijd (naar dagen) in plaats van naar de boekingen per periode | De wet schrijft het niet voor; de afspraak tussen de vennoten beslist. Wie naar tijd wil, legt de verdeling van het jaar vast, met een bedrag vooraf. |
| Een rechtsvormwissel halverwege het jaar (eenmanszaak wordt vof per 1 juli) | Een boekjaar heeft één rechtsvorm. Nu als vof, met de eenmanszaakwinst tot 1 juli als bedrag vooraf in de vastgelegde verdeling. |
| Stakingswinst, goodwill en de waardering bij uittreden | Het kapitaal gaat naar de rekening-courant; de waardering hoort bij de adviseur. |
| Een toegezegde inbreng die nog niet gestort is, in de verliesgrens | De wet telt hem mee, ResoFly alleen wat er geboekt is. Boek hem als vordering op de vennoot. |
| Rente over de rekening-courant | Niet automatisch. Fiscaal is het winstverdeling: leg hem vast als bedrag vooraf. |
| Verdeling aanpassen begint met de percentages van de laatste periode | Niet met wat ieder over het hele jaar kreeg. Het venster zegt dat de perioden dan vervallen. |

## Uitrol

Eén migratie: `20261124120000_vof_tijdlijn_en_rekening_courant`. Veilig om
opnieuw te draaien.

Wat ze met bestaande gegevens doet:

- **Rekening-courant:** elke bestaande vennoot krijgt er een (141n).
- **Tijdlijn:** de eerste stand van elke vennoot geldt vanaf het begin van de
  boekhouding (of het eerste boekjaar). Wie op uitgetreden staat, is dat sinds
  de dag dat dat werd vastgelegd.
- **Afgesloten jaren:** wat er geboekt is, blijft staan. De verdeling van die
  jaren telt als vastgelegd.
- **Er verandert geen boeking.**

Ook de edge functions gaan mee: de handelingen van Gerrie, MCP en de API.

**Staging: uitgerold op 24 november 2026** (merge `bd7b877`):

- *Deploy Supabase (staging)* run 257:
  - de migratie is toegepast ("Push database migrations" in 4 seconden; de
    CLI breekt af bij een fout in een migratie);
  - alle 40 edge functions zijn uitgerold, met de handelingen van Gerrie, MCP
    en de API;
  - de rooktest is geslaagd (Postgres 17.11). Daarin ook "boekhouder-hek: elke
    organisatietabel is afgeschermd" (de tijdlijn valt eronder) en "anon heeft
    geen rechten in public".
- *Frontend checks* run 287: alles groen.
  - De keten vanaf nul op een lege database, elk migratiebestand toegepast, en
    de databasetests.
  - `deno check` op de edge functions.
  - Typecheck, de unit tests, en de mobiele lay-outtest in licht en donker.
  - Laden per module, de inrichtingsstappen en de terugknop.
- Cloudflare Pages bouwt de app bij de push naar `staging`; dat is van hieruit
  niet te zien.

De staging-database zelf is niet ingezien: Supabase is in deze sessie niet als
koppeling verbonden. De controle is de uitrol, de rooktest, en dezelfde
migratie op een lege en een gevulde lokale database.

Voor productie: dezelfde migratie, na `20261124100000_meeting_in_inhoud`.
