# Directe uitvoering via API en MCP: overal als het teamlid

**5 november 2026 · database en de handelingen voor API en MCP · staging**

Aanleiding: bij de controle van Financiën (zie
`CHANGELOG_FINANCIEN_WERKING_VEILIGHEID_2026-11-05.md`) schrijft de directe
uitvoering voor de tabellen van Financiën sinds vandaag als het teamlid. De
rest stond nog open: klanten, projecten, tickets, uren en wat er verder via
een koppeling meteen wordt uitgevoerd.

> **Status:** één migratie (`20261105030000_directe_uitvoering_als_teamlid`),
> een aanpassing in `supabase/functions/_shared/actions/apply.ts` en een
> nieuwe test (`actionMemberWrite.test.ts`). Alles is eerst droog nagespeeld
> op staging, in transacties die altijd worden teruggedraaid.

## Wat er misging

Een koppeling (API-sleutel of MCP) die een handeling meteen mag uitvoeren,
gebruikt de uitvoerders in `apply.ts`. Buiten Financiën schreven die op de
service-role. Die slaat RLS en de databasebewakers voor "authenticated" over.
Dat gold voor 26 van de 36 handelingen:

| Onderdeel | Handelingen |
|---|---|
| Klanten | klantgegevens, klantvelden (3), eigen velden op een klant, contactpersoon actief, portaaltoegang |
| Postvak | bericht koppelen, bericht negeren |
| Inhoud | map aanmaken, map hernoemen, notitie of document verplaatsen |
| Galerijen | aanmaken, instellingen, publiceren, offline halen, deellink intrekken, categorieën (2) |
| Projecten, uren, weekplanner | facturatie van een project, een urenpost, actiepunten afvinken |
| Tickets | klant koppelen, notitie intern of zichtbaar |
| Rapportages | bijwerken, vastzetten |

Wat dat betekende:

- **De modulerechten.** De handelingen controleren die zelf, in `plan()`. De
  database keek op deze weg niet mee: de restrictive RLS geldt niet voor de
  service-role, en de modulepoort en de controle op de creatieve module
  leunen op `auth.uid()`, en dat is daar leeg. Eén fout in `plan()` en er
  was geen tweede slot.
- **De bewakers.** Op contactpersonen, klanten, galerijen en categorieën doen
  ze alleen mee voor "authenticated": verplichte velden, dubbele adressen,
  deellinks en vaste velden.
- **Het postvak.** Een bericht koppelen of negeren liep langs de controle op
  schrijfrecht in Klanten heen, en legde niet vast wie het deed
  (`handled_by` bleef leeg).

## Nu

- **`action_member_write`** kent alle 22 tabellen waar de uitvoerders in
  schrijven. De schrijfactie wisselt binnen de transactie naar het teamlid,
  net als `api_rest_write` voor de REST-koppeling. Daarna gelden RLS, de
  modulepoort en elke bewaker precies als bij de knop in het scherm.
- **Aanmaken** kan alleen in de zes tabellen waar een uitvoerder ook echt
  aanmaakt: grootboekrekeningen, bankrekeningen, klantvelden, mappen,
  galerijen en categorieën. Een klant aanmaken bijvoorbeeld gaat in de app
  langs `create_client_with_next_code` (klantnummer, dubbelcontrole); een
  kale insert zou daar omheen lopen, en wordt nu geweigerd.
- **`action_member_call`** roept de twee functies van het postvak aan als het
  teamlid. De organisatie komt altijd uit de koppeling, niet uit de
  argumenten.
- **`apply.ts`** schrijft niets meer rechtstreeks op de service-role. Wat er
  nog op de service-role gebeurt, is lezen.
- **`actionMemberWrite.test.ts`** legt beide kanten naast elkaar: elke tabel
  en functie die `apply.ts` gebruikt, staat in de lijst van de database. Er
  mag niet meer aangemaakt worden dan nodig, en er schrijft niets langs de
  service-role.

Wat een gebruiker merkt: wat een teamlid in de app niet mag, lukt nu ook via
de koppeling niet. En wie via een koppeling een bericht uit het postvak
koppelt of negeert, staat als behandelaar vastgelegd.

## Getest

**Droog op staging** (met de migratie, teruggedraaid; ook nadat de migratie
van de tickets, `20261105020000_ticket_resolved_archive`, op staging stond):

- **Twaalf tabellen buiten Financiën** (klanten, contactpersonen, klantvelden,
  mappen, notities, documenten, tickets, ticketnotities, projecten,
  rapportages, galerijen, categorieën), elk met een onschuldige wijziging. De
  eigenaar mag. Een lid zonder de module, een lid met alleen leesrecht en een
  buitenstaander mogen niet. Rapportages vallen onder Statistieken; daar is
  een lid met alleen leesrecht op Statistieken apart getest.
- **Uren:**
  - de eigenaar en een lid met schrijfrecht mogen (zoals in de app);
  - zonder de module Uren of met alleen leesrecht lukt het niet;
  - een urenpost aanmaken gaat niet via deze weg;
  - de organisatie of de maker verzetten lukt niet.
- **Klantveld aanmaken:** als eigenaar is het teamlid de maker. Met alleen
  leesrecht volgt "Geen toegang tot de module clients".
- **Weekplanner:** een actiepunt van een collega lukt niet, met en zonder
  voorwaarde. Een eigen actiepunt lukt.
- **Postvak:**
  - zonder Klanten lukt het niet;
  - als eigenaar lukt het, met de eigenaar als behandelaar;
  - een andere organisatie in de argumenten telt niet ("Bericht niet
    gevonden").
- **Buiten de lijst:** een andere functie of tabel wordt geweigerd. Een
  gewone gebruiker die de functies zelf aanroept, krijgt "permission denied".
- **Financiën** (de test van vanochtend): dezelfde uitkomst als live. Alleen
  een klant aanmaken langs deze weg wordt nu geweigerd.

**Lokaal, op de samengevoegde stand van staging:**

- typecheck ✓;
- `npm test` 976/976, waarvan 7 nieuw (`actionMemberWrite.test.ts`);
- `deno check`: de lijst uit CI (34 functies) is schoon.

De migratie heette eerst `20261105020000_…`. Een andere wijziging zette
intussen een migratie met dat nummer op staging; deze kreeg daarom
`20261105030000`.

## Bewust zo

| Punt | Waarom |
|---|---|
| Weigert de database, dan is de melding algemeen ("Niet bijgewerkt: … of het teamlid mag dit niet wijzigen") | `plan()` controleert de modulerechten eerst en geeft dan een zin die het model begrijpt. De database is het tweede slot. |
| Uren van een collega aanpassen kan, met schrijfrecht op Uren | Zo staat het ook in de app (RLS op `time_entries`). |
