# Vennoten: urencriterium per vennoot, privé dat altijd sluit, en een databasetest

**17 november 2026 · database, schermen, Gerrie/API/MCP en CI · staging**

Doel: de vier punten uit de nacontrole van de vof-administratie oplossen, en de
tip over de beginbalans inbouwen. Het vervolg op
`CHANGELOG_EENMANSZAAK_VOF_CONTROLE_2026-11-04.md`.

> **Status:** één migratie (`20261117100000_vennoten_uren_en_prive`) en een
> databasetest die in CI meedraait (`tests/database/`). Daarnaast aanpassingen op
> de pagina's Vennoten, Grootboek → Beginbalans, Uren en Boekjaren, en in twee
> handelingen voor Gerrie, de API en MCP.

## Wat er nu kan of klopt

| # | Wat er misging | Nu |
|---|---|---|
| 1 | Bij een vof zonder vennoten stond op de pagina Vennoten dat de winst naar 0500 Eigen vermogen gaat. Maar een vof krijgt bij het inrichten 0510 Onverdeeld resultaat, en de jaarafsluiting volgt die instelling. Waren alle vennoten uitgetreden, dan waarschuwde de pagina dat de verdeling op 0% stond en bij de afsluiting 100% moest zijn; de afsluiting weigert dan juist niet. | De tekst noemt de rekening uit Instellingen → Boekhouding. Zonder actieve vennoot staat er wat er dan gebeurt: de winst gaat zonder verdeling naar die rekening, het privé van elke vennoot naar zijn eigen kapitaal. De afsluitdialoog bij Boekjaren zegt "geen actieve vennoot" in plaats van "nog geen vennoten vastgelegd". |
| 2 | De verdeling over de vennoten had geen test in de repo. Ze was alleen droog op staging nagespeeld, terwijl `close_fiscal_year` bij elke wijziging helemaal opnieuw wordt geschreven. Viel het vennotendeel daarbij weg, dan zag geen test dat. | `tests/database/vennoten_jaarafsluiting.sql`: 67 controles op een verse database, in één transactie die wordt teruggedraaid. Draait in CI (job `migrations`) en lokaal met `npm run test:database`. Zie "Wat de databasetest nagaat". |
| 3 | Het urencriterium geldt per vennoot, maar ResoFly telde per gebruiker. Een vennoot was niet aan een teamlid gekoppeld, en nergens stonden de uren van de vennoten bij elkaar. | Een vennoot hangt aan het teamlid dat hij is (Financiën → Vennoten → potlood → Teamlid). De tabel met vennoten heeft een kolom **Urencriterium** met de uren van elke vennoot in het kalenderjaar van het gekozen boekjaar, en of hij de 1225 uur haalt. |
| 4 | Werd een vof met vennoten een eenmanszaak, of stond elke vennoot op uitgetreden, dan nam de jaarafsluiting het privé van de vennoten (055n, 056n) niet meer mee. Het saldo schoof ongemerkt mee naar het volgende jaar, en in de kapitaalvergelijking telde een opname als "overig". | Het privé van elke vennoot gaat bij elke jaarafsluiting naar zijn eigen kapitaal, welke rechtsvorm de administratie nu ook heeft. De kapitaalvergelijking telt het als opname of storting. |
| tip | De sluitpost van de beginbalans kwam bij een vof helemaal op 0500 en stond daarna bij Vennoten als "nog niet aan een vennoot toegewezen". Rechtzetten kon alleen met een memoriaal. | Bij een vof, maatschap of cv staat in de beginbalans dat elke vennoot zijn kapitaal op zijn eigen kapitaalrekening krijgt, met de rekeningen erbij. De knop **Regel per vennoot** zet per actieve vennoot een regel klaar. Blijft er een sluitpost over, dan zeggen het scherm en de bevestiging dat die op geen enkele vennoot staat. Zonder vennoten zegt het scherm dat je die eerst vastlegt. |

Verder:

- **Kapitaalvergelijking:** bij een vennoot zonder opnamen stond "€ -0,00". Nu
  "€ 0,00".

## Het urencriterium per vennoot

- **Koppelen:** bij het bewerken van een vennoot kies je het teamlid. Je kunt
  kiezen uit de actieve teamleden, behalve de boekhouder. Een teamlid hoort bij
  één vennoot: anders telden dezelfde uren twee keer.
- **De kolom:** de uren van het kalenderjaar, direct en indirect samen, zoals
  de teller bij Uren. Daarnaast staat:
  - "gehaald" vanaf 1225 uur;
  - in het lopende jaar "op koers", of "onder koers, nog …", met dezelfde
    prognose als bij Uren (vanaf de eerste geregistreerde dag);
  - in een voorbij jaar "niet gehaald".

  Een vennoot zonder teamlid krijgt een streepje. Een commanditaire vennoot
  krijgt "n.v.t.": hij is voor de inkomstenbelasting geen ondernemer.
- **Wie het ziet:** alleen wie Financiën én Uren mag lezen. Zonder Uren staat
  de kolom er niet, en zegt de pagina dat je de uren met leesrecht op Uren ziet.
- **Bij Uren** zegt de teller van het urencriterium nu dat de uren van elke
  vennoot samen bij Financiën → Vennoten staan.

## Database

| Wat | Waarom |
|---|---|
| `partnership_partners.user_id`, met een unieke index per organisatie | Het teamlid dat de vennoot is. Bij het verwijderen van de gebruiker wordt het leeg. |
| `set_partnership_partner_member(organisatie, vennoot, teamlid)` | Koppelen, of loskoppelen met `null`. |
| `partnership_partner_hours(organisatie, jaar)` | De uren per vennoot in een kalenderjaar: direct, indirect en de eerste dag met uren. |
| `close_fiscal_year` | Het privé van de vennoten gaat altijd naar hun kapitaal. Verder letterlijk de versie van `20261105000000`; dat is met een diff nagelopen. |
| `owners_equity_overview` | Zonder actieve vennoot telt het privé van de vennoten als storting of opname, niet als "overig". |

## Gerrie, API en MCP

- **`fiscal_year.close`:** de kaart zegt het als het privé van (vroegere)
  vennoten naar hun eigen kapitaal gaat. Bij een vof waarvan iedereen is
  uitgetreden, weigert de kaart niet meer vooraf op "0% in plaats van 100%".
  Dat deed de database al niet.
- **`owners.equity_overview`:** geeft per vennoot ook het teamlid (`user_id`).
  Daarnaast de uren per vennoot (`hours`), alleen als de aanroeper Uren mag
  lezen; anders `null`.

## Beveiliging

- **`set_partnership_partner_member`:**
  - vraagt schrijfrecht op de organisatie én op Financiën;
  - werkt alleen bij een vof, maatschap of cv;
  - neemt alleen een actief teamlid van dezelfde organisatie aan, en niet de
    boekhouder.
- **`partnership_partner_hours`:** vraagt leesrecht op Financiën (de vennoten)
  én op Uren (de uren).
- **Via Gerrie:** de handeling draait als service-role, die de database niet
  op rechten controleert. Daarom vraagt de handeling zelf of de aanroeper Uren
  mag lezen (`ctx.canRead('time')`) voordat er uren meegaan (CLAUDE.md, regel 3).
- **Rechten van anon:** beide nieuwe functies staan dicht voor anon.
- **Gegevens meenemen:** `user_id` gaat mee met de vennoten in de export.
  `EXPORT_SCHEMA_VERSION` staat op `20261117100000`.

## Wat de databasetest nagaat

`tests/database/vennoten_jaarafsluiting.sql`, met echte rollen: de functies
worden aangeroepen als ingelogde gebruiker, met RLS, zoals PostgREST het doet.

1. **Beginbalans:** kapitaal per vennoot, en de sluitpost op 0500.
2. **Kapitaalvergelijking:** van het open en het afgesloten jaar. Die zijn
   gelijk.
3. **Winst:** 60/40 tot op de cent: € 1.000,01 wordt € 600,01 en € 400,00.
   - Het privé van elke vennoot gaat naar zijn eigen kapitaal.
   - Algemeen privé gaat naar 0500.
   - Er komt geen afrondingsregel op 4900.
4. **100%-controle:** 60/30 wordt geweigerd.
5. **Heropenen en opnieuw afsluiten:** geeft dezelfde standen.
6. **Verlies:** € 300,01 wordt € 180,01 en € 120,00.
7. **Zonder actieve vennoot, en na de overstap naar een eenmanszaak:**
   - het resultaat gaat naar 0510;
   - het privé gaat naar het kapitaal van de vennoot;
   - in de kapitaalvergelijking telt het als opname.
8. **Koppelen:** een teamlid hoort bij één vennoot. Iemand van buiten en de
   boekhouder worden geweigerd.
9. **Uren:** alleen het eigen kalenderjaar en de eigen organisatie tellen mee,
   en een vennoot zonder teamlid telt niets.
10. **Wie wat mag:**
    - een lezer van Financiën ziet de vergelijking, maar sluit niet af en
      wijzigt of koppelt niets;
    - een lid zonder Uren ziet geen uren;
    - een buitenstaander ziet niets.

Bewezen dat hij bewaakt wat hij moet bewaken:

- **Tegen de jaarafsluiting van 5 november** faalt hij op punt 4: "kreeg 7000,
  verwacht 0".
- **Tegen een jaarafsluiting zonder vennotendeel** (de versie van 4 november,
  vóór de vennoten) faalt hij op de 100%-controle.

## Verificatie

**Lokaal:**

- `supabase db start`: alle 280 migraties op een lege database (Postgres
  17.11.0.018), en de nieuwe migratie draait ook een tweede keer zonder fout;
- `npm run test:database`: 67 controles geslaagd;
- typecheck ✓;
- `npm test`: 1920/1920, waarvan 2 nieuw (de afsluitkaart met vroegere
  vennoten, en de uren alleen met leesrecht op Uren);
- `npm run test:loading` ✓;
- mobiele lay-outtest, donker en licht: volledige ronde zonder problemen, met
  drie nieuwe pagina's (Vennoten, Vennoten met het formulier open, en de
  beginbalans van een vof na "Regel per vennoot"). De mock kent daarvoor
  `vof: true`;
- `deno check` op de registry van de handelingen ✓. De volledige lijst uit CI
  kon hier niet, omdat esm.sh en deno.land in deze omgeving dicht staan. Die
  draait in CI (job `edge-functions`).

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Een vennoot zonder eigen login in ResoFly | Zijn uren tellen pas mee als hij een teamlid is (een licentie). Uren op naam van een vennoot zonder login vraagt een andere opzet van Uren. |
| Meer dan de helft van de werktijd aan de onderneming | ResoFly weet niet wat iemand verder werkt. De uitleg staat bij de teller en bij Vennoten. |
| Een vennoot die halverwege het jaar in- of uittreedt | Ongewijzigd: de verdeling volgt de stand bij de jaarafsluiting. |
| Arbeidsvergoeding of rente over het kapitaal vóór de verdeling | Ongewijzigd: als memoriaal tussen de kapitaalrekeningen. |
| De afsluitdialoog bij Boekjaren van een eenmanszaak die eerst een vof was | Noemt het privé van de vroegere vennoten niet. De kaart van Gerrie doet dat wel, en de afsluiting boekt het goed. |
