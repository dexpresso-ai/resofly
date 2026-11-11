# Vooruitbetaalde kosten — 11 november 2026

Vraag: "Voeg een financiële functionaliteit toe als boeking waarbij men vooruit
betaalde bedragen kan boeken. Dus stel ik heb nu 1000 euro aan verzekering
betaald, waarbij de dekking 3 jaar is. Die wil ik dus over 36 maanden
verspreiden."

## Wat er niet kon

Een vooruitbetaling kon je alleen met de hand verwerken:

- de factuur op een kostenrekening boeken: dan stond de hele € 1.000 in de maand
  van betalen, en de twee jaar daarna niets;
- of zelf 36 memoriaalboekingen maken, en onthouden welke al gedaan waren.

Stopte de verzekering eerder, dan was er ook geen weg om de rest netjes af te
wikkelen.

## Wat er nu kan

### Financiën → Vooruitbetaald

Een nieuwe pagina onder Financiën, naast Activa (in elke look: zijbalk, Zenit,
Stroom en de onderbalk).

- **Vooruitbetaling vastleggen**: omschrijving, bedrag (exclusief btw), betaald
  op, geldt vanaf, looptijd in maanden, de kostenrekening, en hoe het bedrag nu in
  je boekhouding staat:
  - *nog niet geboekt*: ResoFly boekt het naar de balans, tegen de bank of een
    andere tegenrekening;
  - *al als kosten geboekt* (inkoopfactuur of bank op een kostenrekening):
    ResoFly haalt het van die kostenrekening af en zet het op de balans;
  - *staat al op de balansrekening* (bank of inkoopfactuur direct daarop, of de
    beginbalans): ResoFly boekt alleen de maandtermijnen.
- Vóór het vastleggen staat er wat er gebeurt: "€ 27,78 per maand (28×) en
  € 27,77 (8×), van november 2026 t/m oktober 2029", de boeking naar de balans
  met beide rekeningen, en het hele schema.
- Met één knop (**Vastleggen en boeken**) wordt het vastgelegd, naar de balans
  geboekt en, als je dat aangevinkt laat, worden de termijnen t/m het einde van
  deze maand meteen naar de kosten geboekt. Ook een periode die al eerder begon:
  de achterstand gaat dan per maand op zijn eigen datum.
- Een inkoopfactuur kiezen vult bedrag, datum en omschrijving in, en of hij al
  als kosten of op de balans stond.
- De lijst toont per post de periode, het bedrag, wat al naar de kosten ging en
  wat er nog op de balans staat. Bovenaan: "N termijnen staan klaar om te boeken"
  met **Alles boeken** (tot en met een datum, uiterlijk het einde van deze maand),
  en de kerncijfers *nog op de balans* en *deze maand naar de kosten*.
- Het venster van een post: de kerncijfers, het schema (geboekt of gepland), **Boek
  t/m**, en **Eerder stoppen**: eerst de termijnen t/m de einddatum, dan gaat de
  rest in één keer weg, een terugbetaling naar de rekening die je kiest (bank of
  een vordering) en de rest naar de kosten.
- Op de telefoon is de lijst een stapel kaarten (zoals de facturen) en het
  schema laat de kolom "daarna op de balans" weg, zodat de status in beeld blijft.

### In het Grootboek

Naast **Memoriaalboeking** staat **Vooruitbetaald**: hetzelfde formulier, want
wie een vooruitbetaling wil boeken, zoekt hem daar.

### Gerrie, de agents en de AI-koppeling

Vier handelingen in de registry:

| Id | Wat |
| --- | --- |
| `prepaid.list` | de posten met wat er geboekt is, wat er op de balans staat en wat klaarstaat |
| `prepaid.create` | vastleggen en boeken (zoals de knop); de kaart noemt de verdeling en de rekeningen |
| `prepaid.post_releases` | de termijnen t/m een datum boeken, van één post of van alle; goed als maandtaak van een agent |
| `prepaid.end` | eerder stoppen, met of zonder terugbetaling |

De drie schrijfhandelingen hebben `risk: 'high'`: het zijn definitieve
boekingen. Zoals altijd zet Gerrie ze alleen klaar; een mens keurt goed
(CLAUDE.md, regel 2).

## Hoe het boekt

Voor € 1.000 verzekering, betaald van de bank, 36 maanden vanaf november 2026:

| Wanneer | Boeking | Soort |
| --- | --- | --- |
| de betaaldatum | debet 1350 Vooruitbetaalde kosten € 1.000 / credit 1100 Bank | `prepaid_start` |
| elke maand, op de laatste dag | debet de kostenrekening / credit 1350: € 27,78 (28×), € 27,77 (8×) | `prepaid_release` |
| bij eerder stoppen | debet bank (terugbetaling) en kostenrekening (rest) / credit 1350 | `prepaid_end` |

- De verdeling is cent-exact, zoals het afschrijvingsschema van de activa: het
  restant van de deling gaat met een cent per termijn naar de eerste maanden.
  Samen precies het bedrag, nooit een termijn van nul.
- De rekening **1350 Vooruitbetaalde kosten** (rubriek Vorderingen) komt er
  vanzelf bij de eerste keer bij. ResoFly herkent hem aan zijn subsoort
  (`prepaid_expenses`), niet aan de code: 1400 is bij een BV de rekening-courant
  DGA, en is 1350 al bezet, dan kiest hij de eerstvolgende vrije code. Het is
  geen systeemrekening; je mag hem hernoemen.
- Een termijn in een **afgesloten boekjaar** komt op de eerste open dag daarna
  (zoals een afschrijving). Een afgesloten **btw-periode** houdt hem niet tegen:
  deze boekingen raken de aangifte niet.
- Termijnen boeken kan tot en met het einde van **deze maand**. Een klik die 36
  maanden vooruit boekt, zet kosten in het grootboek die nog niet gemaakt zijn,
  en terugdraaien moet dan termijn voor termijn.
- Niets van vóór de **start van de boekhouding in ResoFly**: wat daarvoor gebeurde,
  zit in de beginbalans. Begon de periode eerder, dan vul je in wat er op die dag
  nog op de balans stond, met de maanden die toen over waren, en kies je "staat
  al op de balans". Het scherm en Gerrie zeggen dat ook zo.
- De btw hoort bij de inkoopfactuur; het bedrag hier is exclusief btw.
- In de auditfile (XAF) staan de drie soorten in het memoriaal, net als de
  afschrijvingen.

## Vastliggen en corrigeren

- Zodra er iets geboekt is, liggen bedrag, datums, looptijd, balansrekening en de
  manier van boeken vast. De omschrijving, de notities, de inkoopfactuur en de
  kostenrekening (voor de termijnen die nog komen) kunnen altijd.
- Corrigeren gaat met **Tegenboeken** in het Grootboek, en het register gaat mee
  terug: een tegengeboekte termijn staat weer gepland, een tegengeboekte
  beëindiging zet het schema terug, en na het tegenboeken van de boeking naar de
  balans is de post weer te wijzigen of te verwijderen. De volgorde is die van de
  activa: eerst de beëindiging, dan de termijnen, dan de boeking naar de balans.
  De database weigert een andere volgorde, met uitleg.
- Verwijderen kan zolang er netto niets in het grootboek staat. De boekstukken
  zelf blijven bewaard (bewaarplicht, CLAUDE.md regel 6).

## Veiligheid

- De app schrijft niets rechtstreeks in `prepaid_expenses` en
  `prepaid_expense_releases`: er is geen policy voor insert, update of delete en
  de rechten daarop zijn ingetrokken. Alles loopt via vijf databasefuncties
  (`save_prepaid_expense`, `book_prepaid_expense_start`, `post_prepaid_releases`,
  `end_prepaid_expense`, `delete_prepaid_expense`), die schrijfrecht op de
  organisatie én op Financiën eisen. Bij de activa moesten die bewakers er later
  bij komen (20261104030000), omdat een geboekt activum via de API nog te wijzigen
  was; hier kan dat vanaf het begin niet.
- Elke rekening en inkoopfactuur moet van dezelfde organisatie zijn; een
  omzetrekening of btw-rekening kan geen tegenrekening zijn, een bank- of
  debiteurenrekening geen balansrekening voor vooruitbetaalde kosten.
- Lezen: leden met leesrecht op Financiën (ook de boekhouder), met de modulepoort
  erop. Zonder Financiën, of van een andere organisatie: niets.
- De handelingen van Gerrie filteren zelf op de organisatie uit de sessie
  (`orgQuery`, `row`) en schrijven via de uitvoerders in de browser, dus met de
  rechten van wie goedkeurt.
- Het logboek kent de soort `prepaid_expense` (Financiën), met bedrag, datums,
  looptijd en status als waarde; omschrijving en notities alleen als "gewijzigd".

## Techniek

- Migratie `20261111220000_vooruitbetaalde_kosten.sql`: de twee tabellen, de
  functies, de drie boekingssoorten, `reverse_journal_entry` met het register
  (verder gelijk aan 20261107110000), `audit_entity_module` en
  `audit_field_spec` (verder gelijk aan 20261108230000 en 20261108190000).
- App: `src/features/Prepaid.tsx` (pagina en venster), `src/lib/prepaid.ts`
  (het schema, dezelfde regel als de database, met tests), `repository.ts`,
  `dataGroups.ts` (de tabellen horen bij de groep *bookkeeping*; de pagina
  `prepaid` laadt die groep), de navigatie, `xaf.ts`, `auditLog.ts`,
  `exportManifest.ts` (beide tabellen gaan mee in de export, met een leesbare
  lijst; schemaversie 20261111220000).
- Registry: `supabase/functions/_shared/actions/bookkeeping.ts` en de
  uitvoerders in `src/lib/actions/bookkeeping.ts`; `reportRecords.ts` kent nu
  alle boekingssoorten (ook dividend, loonjournaalpost en de drie nieuwe), zodat
  een filter erop niet meer als "ongeldige waarde" wordt geweigerd.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: 1602 tests, 0 fout (nieuw: `src/lib/prepaid.test.ts`, en zoekgevallen
  in `actionSearch.test.ts`, waaronder de vraag zelf).
- De migratieketen vanaf nul (`supabase db start`, Postgres 17.11.0.018), en de
  nieuwe migratie een tweede keer: veilig.
- Stromentest `vooruitbetaald` (nieuw, tegen de lokale stack): 20 stappen, 0 fout.
  Ook `bank`, `rook` en `facturen` (die tegenboeken): 112 stappen, 0 fout.
- UI-test `vooruitbetaald` (nieuw, Chromium tegen de lokale stack): 7 stappen,
  0 fout. Die vond één fout die nu weg is: na vastleggen stond er bij
  Balansrekening alleen "Selecteer…", omdat het formulier nog op "nieuwe
  rekening" stond terwijl die rekening er inmiddels was.
- De handelingen van Gerrie (`plan()` en `read()`) tegen de lokale database: de
  kaart van `prepaid.create` noemt "€ 27,78 per maand (28×) en € 27,77 (8×),
  november 2026 t/m oktober 2029", en onzin wordt geweigerd.
- `npm run test:loading`: alle controles geslaagd (de pagina laadt alleen de
  boekhoudgroep).
- `npm run test:mobile -- --theme=both`: 530 metingen, 0 problemen. Nieuw gemeten zijn
  `prepaid` (eerste post op de telefoon 435px, grens 522px), `prepaid-venster`,
  `prepaid-nieuw` en `ledger-journaal` (het journaal met de nieuwe knop).
- `deno check`: niet te draaien in de cloudsessie (deno.land en esm.sh zijn daar
  niet bereikbaar). De gewijzigde servercode en het hele handelingenregister gaan
  schoon door een strikte `tsc`; de CI-workflow draait `deno check` bij de push
  naar staging.

## Niet in deze stap

- Automatisch boeken op de eerste van de maand. Dat zou zonder mens in het
  grootboek schrijven; nu boek je de termijnen met één klik (Alles boeken), of
  laat je een agent `prepaid.post_releases` elke maand klaarzetten om goed te
  keuren.
- Vooruit ontvangen omzet (een abonnement dat je klant vooruit betaalt): hetzelfde
  idee aan de andere kant van de balans, nog niet gebouwd.
- Een bijlage (de polis) aan de post hangen; koppel hem aan de inkoopfactuur.
