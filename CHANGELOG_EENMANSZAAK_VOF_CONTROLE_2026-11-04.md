# Controle eenmanszaak en vof: privé, vennoten en de IB-kant van de boekhouding

**4 november 2026 · database, schermen en Gerrie/API/MCP · staging**

Doel: alles nalopen wat een eenmanszaak, vof, maatschap of cv in ResoFly doet
(het IB-regime). Bij die rechtsvormen is de winst van de ondernemer of de
vennoten zelf, en de aangifte inkomstenbelasting vraagt dingen die een BV niet
kent. Wat niet klopte of ontbrak, is meteen ingebouwd.

> **Status:** één migratie (`20261104070000_ib_prive_vennoten`) en een nieuwe
> pagina **Eigen vermogen** (eenmanszaak) of **Vennoten** (vof, maatschap, cv).
> Daarnaast aanpassingen in urenregistratie, activa, instellingen en boekjaren,
> en een leeshandeling voor Gerrie, API en MCP. Alles is eerst droog
> nagespeeld op staging.

> **Uitgerold op staging op 4 november** (*Deploy Supabase (staging)* run 167).
> De migratie is toegepast (231 in totaal), alle edge functions zijn uitgerold
> en de rooktest is geslaagd. Daarna gaven dezelfde scenario's tegen de live
> code dezelfde uitkomst. Beide bestaande IB-administraties hebben de
> privérekeningen gekregen, de regressiecijfers zijn ongewijzigd en er is
> niets van de tests blijven staan.

## Wat goed zat

Dit is nagelopen en hoefde niet te veranderen:

- **Schermen per rechtsvorm:** vennootschapsbelasting, DGA, aandeelhouders en
  jaarrekening zijn verborgen bij een eenmanszaak of vof, en de server weigert
  ze ook.
- **Urencriterium in de basis:** de teller telt per kalenderjaar al je eigen
  uren, direct en indirect. Hij staat alleen bij de IB-rechtsvormen, en alle
  uren worden geladen, dus ook die van eerdere jaren.
- **Beginbalans:** het sluitstuk gaat bij een IB-onderneming naar 0500 Eigen
  vermogen.
- **Btw:**
  - met de KOR hoeven de btw-perioden niet te zijn afgesloten voordat het
    boekjaar dicht kan;
  - een eenmanszaak kan een privérekening koppelen;
  - facturen tonen het KvK-nummer en het btw-nummer.

## Bevindingen en fixes

| # | Ernst | Wat er misging | Nu |
|---|---|---|---|
| 1 | hoog | Er was geen rekening voor privé-opnamen of -stortingen. Een eenmanszaak boekte die op 0500 of op een zelfgemaakte rekening, en de jaarafsluiting deed er niets mee. De aangifte inkomstenbelasting vraagt het ondernemingsvermogen aan het begin en het eind van het jaar; de winst volgt uit die vergelijking, plus de opnamen en min de stortingen. | **0550 Privé-opnamen** en **0560 Privé-stortingen** in het rekeningschema van elke IB-onderneming, ook bestaande. De jaarafsluiting zet ze naar 0500 Eigen vermogen. |
| 2 | hoog | Een vof, maatschap of cv kende geen vennoten. De hele winst ging naar één rekening, zonder verdeling, terwijl elke vennoot zijn eigen winstaandeel aangeeft. | **Vennoten** met een winstaandeel. Per vennoot zijn er eigen rekeningen: kapitaal (050n), privé-opnamen (055n) en privé-stortingen (056n). Bij de jaarafsluiting gaat het resultaat (winst én verlies) naar rato naar de kapitaalrekeningen, tot op de cent sluitend. Het privé van elke vennoot gaat naar zijn eigen kapitaal. Telt de verdeling niet op tot 100%, dan weigert de afsluiting met uitleg. |
| 3 | midden | Er was nergens een kapitaalvergelijking: begin, winst, stortingen, opnamen, eind. | Nieuwe pagina **Eigen vermogen**, die bij een vof **Vennoten** heet. Per boekjaar staat er de kapitaalvergelijking, per vennoot of voor de ondernemer. Vermogen dat op geen enkele vennoot staat, wordt apart getoond, met de oplossing erbij. |
| 4 | midden | De prognose van het urencriterium rekende vanaf 1 januari. Wie op 1 juli begon en op 1 oktober 600 uur had, zag "± 802 uur": onder koers, terwijl het tempo op 1200 uur uitkomt. | Het tempo telt vanaf de eerste geregistreerde dag (met tests). |
| 5 | midden | Bij het urencriterium ontbraken voorwaarden: meer dan de helft van de werktijd (behalve voor starters), geen herrekening in het startjaar, 16 weken bij zwangerschap, en dat het per vennoot geldt. | Die staan nu bij de teller. Voor 2026 staat erbij wat het oplevert: zelfstandigenaftrek € 1.200 en startersaftrek € 2.123. |
| 6 | midden | Een activum kon worden afgeschreven over 3 jaar (33% per jaar), terwijl fiscaal ten hoogste 20% per jaar mag (goodwill 10%). Bij een eenmanszaak is de boekhouding meestal de fiscale. | Een waarschuwing boven 20% per jaar: bij een IB-onderneming een gebruiksduur van minstens 60 maanden kiezen, bij een BV de afschrijvingsbeperking in de Vpb. Onder € 450 een hint dat het in één keer als kosten mag. |
| 7 | laag | Bij het btw-nummer stond niets over het verschil tussen btw-id en omzetbelastingnummer. Een eenmanszaak die haar omzetbelastingnummer op de factuur zette, zette daar haar BSN op. | Uitleg bij een eenmanszaak, een vormcontrole (NL, 9 cijfers, B, 2 cijfers), een melding als het nummer zonder NL is ingevuld, als het KvK-nummer ontbreekt, en dat het btw-nummer met de KOR niet op de factuur hoeft. |
| 8 | laag | De keuze waar het jaarresultaat heen gaat (0510 of 0500) had geen uitleg per rechtsvorm. | Advies per rechtsvorm: bij een eenmanszaak 0500, bij een vof met vennoten gaat het naar hun kapitaal, bij een BV blijft het op 0510 tot de bestemming. |
| 9 | laag | De dialoog voor het afsluiten van een boekjaar zei niets over privé of vennoten. | Hij zegt nu wat er gebeurt. |

Verder:

- **Gerrie, API en MCP:** de nieuwe leeshandeling `owners.equity_overview` geeft
  de kapitaalvergelijking en de vennoten.
- **Auditlog:** wijzigingen aan vennoten komen onder Financiën in het auditlog.

## Beveiliging

- **Vennoten:** de tabel is alleen leesbaar met leesrecht op Financiën. Schrijven
  gaat alleen via `save_partnership_partner`, die schrijfrecht op de organisatie
  én op Financiën vraagt. Die functie maakt ook de rekeningen aan, als
  systeemrekening, zodat code, soort en subsoort vastliggen.
- **De verdeling:** `partnership_result_shares` is intern (alleen
  `service_role`).
- **Het overzicht:** `owners_equity_overview` vraagt leesrecht op Financiën.

## Verificatie

- **Droog op staging**, in een transactie die altijd wordt teruggedraaid:
  - eenmanszaak met € 500 winst, € 100 opname en € 20 storting: het overzicht
    geeft € 420, na afsluiten staan de privérekeningen op nul en 0500 op −€ 80,
    en heropenen zet alles terug;
  - vof met 60/40 en € 1.000,01 winst: € 600,01 en € 400,00. Opname en storting
    gaan naar het kapitaal van de juiste vennoot;
  - verlies van € 300,01: € 180,01 en € 120,00;
  - 60/30 wordt geweigerd;
  - een commanditaire vennoot bij een vof, een vennoot bij een eenmanszaak en
    een lege naam worden geweigerd, net als het overzicht bij een BV;
  - alle eerdere testscripts (finance, btw, verkoop, guards, BV, Vpb) geven
    dezelfde uitkomst als vóór deze migratie.
- **Lokaal:**
  - typecheck ✓;
  - `npm test` 894/894, waarvan 9 nieuw (prognose urencriterium, btw-id);
  - build en CSP ✓, Deno-check voor mcp, api en gerrie ✓;
  - mobiele lay-outtest op de geraakte pagina's: 36 metingen, 0 problemen;
  - de nieuwe pagina op telefoon en desktop, als vof en als eenmanszaak, gaf
    geen fouten en loopt niet uit beeld.

## Bewust open

| Punt | Waarom nog niet |
|---|---|
| Btw-correctie privégebruik auto (rubriek 1d) en de bijtelling in de winst | Het kan nu via een memoriaal met een eigen btw-code. Een standaardcode vraagt eerst zekerheid over hoe 1d precies wordt ingevuld (grondslag of alleen btw); die heb ik niet kunnen nalezen. |
| De inkomstenbelasting zelf (ondernemersaftrek, mkb-winstvrijstelling, box 1) | ResoFly levert de bouwstenen (winst, urencriterium, kapitaalvergelijking per vennoot). De aangifte hangt af van het hele inkomen van de persoon. |
| Winstverdeling met eerst een arbeidsvergoeding of rente over het kapitaal | Kan als memoriaal tussen de kapitaalrekeningen; de automatische verdeling is naar rato. |
| Een vennoot die halverwege het jaar in- of uittreedt | De verdeling volgt de stand bij de jaarafsluiting. Een tijdsevenredige verdeling vraagt een datum per vennoot. |
| Kleinschaligheidsinvesteringsaftrek (KIA) voor IB-ondernemers | Hoort bij de aangifte; nu niet berekend. |

Bronnen (Belastingdienst):

- urencriterium;
- ondernemersaftrek en mkb-winstvrijstelling 2026;
- afschrijving (maximaal 20% per jaar, goodwill 10%, onder € 450 in één keer);
- btw-id voor een eenmanszaak;
- art. 3.6 Wet IB 2001.
