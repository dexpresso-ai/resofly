# Handelingenregistry — alles wat de app kan, kan een agent ook

**22 augustus 2026 · staging `c417fab` t/m `9f3d593`**

Twee dingen die de PO vroeg: (1) een agent moet in te zetten zijn voor élke functie die
de app biedt en waar de gebruiker zelf bij kan, en (2) je moet acties ook rechtstreeks
vanuit de chat kunnen laten uitvoeren. Allebei achter een akkoord.

## Wat er ontbrak

Een inventarisatie over tien domeinen telde **575 gebruikershandelingen**. Gerrie had er
65 als tool — ~430 handelingen waren aan een agent simpelweg niet te geven.

En wat hij wél kon, deed hij half. Zeventien voorstellen (factuur, offerte, klant,
project, taak, ticket, notitie, document, leverancier, inkoopfactuur, contract,
rapportage) openden alleen een vooringevuld scherm; jij moest daarna zelf op Opslaan
drukken. Voor een geplande agent die om 08:00 draait was dat onwerkbaar: die zet een
factuur klaar en er is niemand om dat scherm te openen.

## Waarom het geen 430 tools zijn geworden

Elke tooldefinitie gaat bij **elke** chatbeurt en **elke** agentronde mee als
invoertokens. Vijfhonderd definities is tienduizenden tokens per verzoek, bij een
maandtegoed van een paar euro per account. En een model dat uit vijfhonderd tools moet
kiezen, kiest slechter dan een model dat er twintig ziet.

Handelingen staan daarom als **data** in een registry. Het model krijgt drie meta-tools:

| tool | wat het doet |
| --- | --- |
| `find_actions` | zoek op wat de app kan, in de woorden van de gebruiker |
| `run_action` | voer een leeshandeling uit |
| `propose_action` | zet een wijziging klaar — die komt als kaart bij de gebruiker |

De lange staart kost pas tokens op het moment dat hij nodig is. De agent-bouwer toont
wél de volledige lijst, met een zoekveld erboven.

## Wat er nu in zit

**262 handelingen: 188 die iets wijzigen, 74 die lezen.** Tien domeinen: klanten,
verkoop, boekhouding, BV/Vpb, projecten, agenda, tickets, marketing, beheer en inzicht.
Van "adres en btw-nummer bijwerken" tot "btw-periode afsluiten", "jaarrekening opmaken",
"campagne versturen", "galerij publiceren" en "banktransactie afletteren".

## De grens: er gebeurt niets zonder akkoord

- `plan()` op de server schrijft **nooit**. Er staat geen `insert`, `update` of `delete`
  in de hele serverregistry, en de RPC's die hij leest zijn allemaal `STABLE` —
  Postgres weigert daar een schrijfactie. Nagemeten, niet aangenomen.
- Schrijven gebeurt in de browser, ná jouw akkoord, langs **dezelfde**
  repository-functie als de knop in het scherm. Geen tweede weg die kan gaan afwijken.
- Modulerechten worden per handeling getoetst (`resolveAction`), en een agent kan
  alleen wat je hem gegeven hebt. Een lees-agent krijgt `propose_action` niet eens mee.
- **69 van de 188** schrijf-handelingen zijn onomkeerbaar of naar buiten gericht. Die
  krijgen de knop "Definitief uitvoeren" en een waarschuwing vóóraan op de kaart. Die
  waarschuwing zit niet in een eigen veld maar in het onderschrift: anders moet elk
  scherm dat een voorstel toont hem apart leren tonen, en het scherm dat dat vergeet
  toont hem niet.
- Het auditspoor legt `action:<id>` vast en niet `propose_action`, zodat het logboek
  vertelt wélke handeling er klaarstond.

## Bewust niet gebouwd

| | waarom |
| --- | --- |
| Definitief verwijderen | een agent hoort niets weg te gooien; archiveren, deactiveren en annuleren zijn de wél gebouwde uitwegen |
| API-sleutels, app-wachtwoorden, OAuth, verzenddomeinen | inloggegevens horen niet door een agent te gaan |
| Abonnement, seats, opslag, modules, terugbetaling via Mollie | dat geeft geld uit |
| Bestanden uploaden of downloaden | een agent heeft geen bestand in handen; koppelen en verplaatsen kan wel |
| Puur schermwerk | navigeren, sorteren, thema, meldingen op dit apparaat |
| Teamchat | eerder bewust buiten Gerrie gehouden |

Onomkeerbare fiscale handelingen zijn er **wel** — daar zit jouw akkoord tussen, precies
zoals bij de knop in het scherm.

## Het zoeken bleek de kwetsbare plek

Met 262 handelingen bepaalt `find_actions` of iets voor Gerrie *bestaat*. Drie fouten
kwamen pas boven water door er een test op te zetten met dertig vragen zoals iemand ze
stelt:

1. Tokeniseren op `a-z` maakte van "definiëren" twee halve woorden.
2. Een stamvergelijking op lengte alleen liet "aanmaning" op "aanmaken" matchen en
   "memo" op "memoriaalboeking" — dan verdringt de verkeerde handeling de juiste.
3. Alledaagse woorden verdrongen zeldzame: "memoriaalboeking maken" vond de
   memoriaalboeking niet, omdat "maken" op vijftig handelingen past en ze allemaal op
   dezelfde score zet. Een zoekwoord weegt nu naar hoe zeldzaam het is.

Nu 30/30 binnen de eerste zes treffers. Faalt er ooit een: voeg een trefwoord toe aan
die handeling, verlaag de lat niet.

## Twee tests bewaken de naad

- `actionRegistry.test.ts` — elke schrijf-handeling heeft een uitvoerder in de browser,
  elke uitvoerder een bestaande handeling, elke handeling een bekende module. Zonder
  die eerste zet Gerrie iets klaar dat bij het akkoord blijft steken.
- `actionSearch.test.ts` — de dertig vragen hierboven, plus de modulefilter en de
  agent-allowlist.

## Nog te doen

1. **Deployen, in deze volgorde: frontend eerst, edge functions daarna.** Een oude
   frontend die een `action`-voorstel binnenkrijgt, crasht in de goedkeurwachtrij.
   Daarna `gerrie-agent` en `gerrie-agent-runner`.
2. E2e met login: chat → kaart → Aanmaken, en agent-bouwer → handeling aanvinken →
   Nu draaien → wachtrij → afvinken → logboek.
3. Productie.
