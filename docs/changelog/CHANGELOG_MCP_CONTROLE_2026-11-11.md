# MCP-connector nagelopen: koppelen en de klantgrens

**11 november 2026 · zie [MCP_CONNECTOR_SETUP.md](../setup/MCP_CONNECTOR_SETUP.md)**

De vraag was tweeledig. Kun je Claude, ChatGPT, Gemini en vergelijkbare apps aan
ResoFly koppelen? En kan iemand via zijn eigen AI bij de gegevens van een ander
bedrijf komen?

Kort antwoord: koppelen werkt met alle vier. Bij andere bedrijven komt een AI niet:
dat is op staging nagespeeld met echte id's van een andere organisatie. Er zaten
vier kleinere gaten in. Drie daarvan lagen binnen de eigen organisatie. Het
vierde was een volgorde die later een lek had kunnen worden. Alle vier zijn nu
dicht.

## Wat er live is nagespeeld

Via de Claude-koppeling van deze werkruimte op staging (organisatie
*Gerjanvanlopik*). De id's kwamen alleen-lezend uit de database en horen bij een
andere organisatie op staging.

| Poging | Uitkomst |
|---|---|
| `project.dashboard` op een project van de andere organisatie, met hun `organization_id` erbij | *Project niet gevonden in deze organisatie.* |
| `list_time_entries` en `list_invoices` op een klant van de andere organisatie | Leeg: 0 regels |
| `project.phases` met `organization_id` én `organizationId` van de andere organisatie in de invoer | Leeg: de invoer wordt genegeerd |
| `propose_action` (`invoice.set_reminders_paused`) op een factuur van de andere organisatie | *Factuur niet gevonden in deze organisatie.* Er staat niets klaar. |
| `propose_edit_project` (kerntool van Gerrie) op hun project | *Ongeldig project_id.* Er staat niets klaar. |

Daarnaast is de database op staging alleen-lezend nagelopen:

- RLS staat aan op alle vier de MCP-tabellen.
- `mcp_tokens`, `mcp_auth_codes` en `mcp_clients` hebben geen enkele policy, dus
  een ingelogde gebruiker leest of schrijft er niets.
- `anon` heeft geen rechten.
- `mcp_grants` laat alleen lezen en intrekken toe. De wijzigingsguard weigert een
  andere `organization_id`, `user_id`, `client_id`, het plafond en de tellers.
- `action_member_write`, `action_member_call`, `mcp_consume_rate_limit` en
  `edge_note_attempt` zijn alleen voor de service-role uitvoerbaar.

De databasefuncties die de handelingen aanroepen zijn in de migraties nagelezen
(laatste definitie per functie). Elke functie die naast de organisatie een id
krijgt, controleert eerst dat dat id bij die organisatie hoort, of filtert erop.
Een vreemd id geeft een fout of niets. Voorbeelden:
`invoice_open_receivable_cents`, `compute_vat_boxes`, `report_account_ledger`,
`get_annual_account` en `drive_item_client`. `action_member_write` en
`action_member_call` controleren het actieve lidmaatschap. Ze schrijven alleen
binnen de organisatie uit de sessie, en daarna gelden RLS en de modulepoort van
het teamlid.

## Wat er dicht is

**1. `find_actions` toonde een teamlid ook de handelingen voor owners en admins.**
Het zoekfilter kreeg alleen de module en de soort (lezen of schrijven). Daardoor
zag het `adminOnly` niet. Een member vond via zijn AI zo "teamlid uitnodigen",
rollen en modulerechten wijzigen en de organisatie-instellingen. Het model bood
die de gebruiker ook aan. Uitvoeren en klaarzetten werden wel geweigerd.

`searchActions` kent nu `permits`, een filter dat de hele handeling ziet. De
MCP-server en Gerrie's eigen `find_actions` geven daar `actionPermitted` aan mee.
In Gerrie zat hetzelfde gat.

**2. Bronnen gingen als kaal JSON mee.** Een antwoord van `run_action` staat
tussen `<gegevens>` en `</gegevens>`. Dezelfde rij als bron
(`resources/read`, bijvoorbeeld *recente klantmail*) had die afbakening niet. Een
mail met "negeer je regels" erin was zo via de ene weg herkenbaar als gegevens,
en via de andere niet. Bronnen gaan nu ook door `wrapToolData`, als `text/plain`.
De instructies voor de AI noemen beide wegen.

**3. De naam van de organisatie ging onbewerkt de instructies in.** Die naam
kiest een beheerder zelf. Bij het koppelen zet de AI-client hem in zijn
systeemprompt. Met een regeleinde erin werd de naam een eigen regel in de
instructies van de AI van elk teamlid. Nu gaat hij door `promptValue`, net als in
Gerrie's systeemprompt.

**4. Twee RPC-hulpjes lieten de invoer de organisatie overschrijven.** `rpc()` in
`bookkeeping.ts` en `callReport()` in `insight.ts` bouwden hun parameters als
`{ p_organization_id: ctx.organizationId, ...params }`. Een `p_organization_id` in
`params` won dan. Geen van de zeventien aanroepen geeft er een mee, dus het was
niet te misbruiken. Maar de tenancy-test zag het niet. Nu staat de organisatie
achteraan, en `actionTenancy.test.ts` weigert de oude volgorde.

## Koppelen met Gemini

De connector werkte al met Gemini: dynamische registratie, PKCE en een
https-adres of een adres op de eigen computer. Instellingen → AI noemde alleen
Claude, Claude Code en ChatGPT. Er staan nu twee keuzes bij:

- **Gemini (web):** een eigen app toevoegen.
- **Gemini CLI:** met een opdracht om te kopiëren
  (`gemini mcp add --transport http resofly <URL>`, daarna `/mcp auth resofly`).

Bij Gemini (web) toont het toestemmingsscherm **Niet geverifieerd**. Dat blijft zo.
Het terugkeeradres `oauth-redirect.googleusercontent.com` is een doorgeefadres van
Google, en dat kan elk Google Cloud-project gebruiken. Het adres bewijst dus niet
dat het Gemini is. Instellingen → AI zegt dat er vooraf bij.

## Bewust niet gedaan

- **Issuer-identificatie (RFC 9207) voor ChatGPT.** Zetten we dat aan, dan
  wisselt ChatGPT naar een ander terugkeeradres, ook voor bestaande koppelingen.
  Dat kunnen we hier niet met ChatGPT zelf testen. Het staat in de handleiding
  onder *Wat er hierna komt*.
- **Gemini Enterprise.** Daar voert een beheerder een client-id en een geheim in.
  Wij geven geen geheimen uit, dus die route werkt waarschijnlijk niet. De
  handleiding zegt dat nu.

## Getest

- `npm test`: 1496 tests groen. Vier zijn nieuw. In `mcpExecute.test.ts`: een
  member vindt `team.invite` niet, bronnen gaan door `wrapToolData`, en de
  organisatienaam gaat door `promptValue`. In `actionTenancy.test.ts`: geen
  spread na `p_organization_id`. Alle vier faalden op de oude code.
- `npm run typecheck`: groen.
- `deno check` (Deno 2.9.6) op `mcp`, `mcp-oauth`, `api`, `gerrie-agent`,
  `gerrie-agent-runner` en `gerrie-signals`: groen. Dat zijn alle functies die
  de gewijzigde code gebruiken. De rest van de CI-lijst kon hier niet:
  deno.land is vanuit deze sessie niet bereikbaar. CI draait hem bij de push.
- `npm run test:mobile -- --theme=both`: zie het commitbericht.
