# Een API waarmee je alles kunt koppelen

**3 oktober 2026 · zie [PUBLIC_API_SETUP.md](PUBLIC_API_SETUP.md) (uitrollen) en [docs/API.md](docs/API.md) (voor ontwikkelaars)**

Tot nu toe had ResoFly één deur naar buiten: de MCP-connector, voor de eigen AI
van een klant. Een webshop, een urenapp of een koppelplatform als Zapier, Make of
n8n kon nergens terecht. Nu wel: een gewone REST-API met JSON, en een
API-sleutel die een owner of admin aanmaakt onder **Instellingen → API &
webhooks**.

## Fase 1 — sleutels en handelingen

### Geen nieuwe laag, maar de registry

De API bouwt niets na. Wat hij kan, is precies wat Gerrie en de MCP kunnen: de
handelingenregistry plus Gerrie's kerntools, langs dezelfde `read()`, `plan()`,
`runGerrieTool` en `buildProposal`. Voor een owner zijn dat er nu 104 om te
lezen en 229 om te wijzigen. Een handeling die erbij komt, staat bij de volgende
uitrol vanzelf in de API — en in het OpenAPI-document, want dat wordt uit de
registry gegenereerd (`GET /v1/openapi.json`, met elke handeling als eigen pad
en eigen invoerschema).

| Adres | Wat |
|---|---|
| `GET /v1` | Wat dit is; open. |
| `GET /v1/openapi.json` | OpenAPI 3.1, gegenereerd; open. |
| `GET /v1/me` | Organisatie, sleutel, namens wie, het moduleraster. |
| `GET /v1/actions` | Wat deze sleutel kan, met zoeken in gewone woorden. |
| `POST /v1/actions/{id}` | Lezen (200), uitvoeren (200) of klaarzetten (202). |
| `GET /v1/proposals[/{id}]` | Hoe staat het met wat deze sleutel klaarzette? |

### Wat een sleutel mag

Vier treden, dezelfde als bij de AI-koppeling: alleen lezen, klaarzetten,
rechtstreeks uitvoeren, en ook het onomkeerbare. Plus een modulebeperking (een
webshop hoeft niet in de boekhouding) en een vervaldatum. Bij de AI-koppeling
staat "rechtstreeks uitvoeren" alleen in de eigen instellingen, nooit op het
toestemmingsscherm; een sleutel maakt een owner/admin met opzet aan in dat zelfde
instellingenscherm, dus daar hoort de keuze ook thuis — bij het aanmaken, en
daarna niet meer ruimer.

Rechtstreeks uitvoeren loopt langs exact dezelfde lijst server-uitvoerders als de
MCP (`apply.ts`). Wat daar niet in staat — alles met mail, PDF of bestanden, en
alles wat Gerrie zelf opstelt — wordt ook met de ruimste sleutel een voorstel in
de goedkeurwachtrij, met de reden erbij. Een koppeling ziet dat vooraf aan
`"execution": "direct"` of `"approval"` in de catalogus.

### Wat de grenzen bewaakt

- **De organisatie komt uit de sleutel.** Er is geen invoerveld voor; een id van
  een andere organisatie geeft *"niet gevonden in deze organisatie"*.
- **De rechten komen vers uit de database.** Een sleutel werkt namens zijn maker,
  met diens rol en modules van dít moment. Wordt de maker viewer, dan leest de
  sleutel alleen nog; is hij geen lid meer, dan werkt de sleutel niet meer.
- **Een sleutel kan nooit ruimer zijn dan zijn maker.** De modulebeperking knijpt
  alleen af. In Gerrie's kerntools, waar owners en admins alles mogen, draait
  een beperkte sleutel daarom als gewoon teamlid met precies zijn modules.
- **Sleutels staan niet leesbaar in de database.** `rsfapi.<selector>.<verifier>`,
  zelfde opzet als de MCP-tokens, in een tabel zonder policies.
- **Vanuit de app alleen hernoemen en intrekken.** Een databasetrigger weigert
  verruimen, de teller resetten en een ingetrokken sleutel weer aanzetten.
  Intrekken annuleert wat de sleutel nog in de wachtrij had staan.
- **Alles staat in een log.** Elke aanroep in `api_request_log` (30 dagen,
  zichtbaar voor owners/admins), elke uitvoering en elk voorstel in
  `ai_action_audit` met `api_key_id`, en aanmaken/hernoemen/intrekken in
  `audit_logs`.
- **Limieten.** 300 aanroepen per minuut per sleutel, afgeboekt in één statement
  met een rijvergrendeling; 50 openstaande voorstellen per sleutel; 1 MB invoer.
- **Veilig herhalen.** Met een `Idempotency-Key` krijgt een herhaald verzoek
  binnen 24 uur het eerste antwoord terug in plaats van een tweede uitvoering.

### Wat de gebruiker ziet

- **Instellingen → API & webhooks** (alleen owners/admins): het adres, het
  OpenAPI-adres, een nieuwe sleutel aanmaken (naam, toegang, modules, vervaldatum)
  — de sleutel is één keer te zien —, de lijst met actieve sleutels met namens
  wie, laatst gebruikt en beperkingen, en de laatste 50 aanroepen.
- **De goedkeurwachtrij** toont voorstellen van een sleutel met een eigen
  merkteken en de naam van de sleutel ("Webshop · API-koppeling").

### Wat de tests bewaken

- `publicApi.test.ts` (27) — de rekensommen: sleutels splitsen en verifiëren, een
  MCP-token is geen API-sleutel, de trap van toegangsniveaus, de modulebeperking
  (ook dat een viewer met een sleutel geen schrijver wordt), routes, statussen,
  idempotentie, en dat het OpenAPI-document elke handeling met zijn schema bevat.
  Plus dat de database precies dezelfde treden en modules kent.
- `publicApiServer.test.ts` (18) — de grenzen in de functies zelf: de organisatie
  nooit uit de invoer, eerst de sleutel controleren en dan pas de limiet
  afboeken, rechten vers uit `organization_members`, rechtstreeks uitvoeren alleen
  met een uitvoerder en het juiste risico, het auditlog met `api_key_id`, en dat
  alleen owners/admins sleutels aanmaken.

Nagemeten: `npm test` 393 groen, `npm run typecheck` en `npm run build` groen,
`deno check` op `api`, `api-admin`, `mcp`, `mcp-oauth` en `gerrie-agent` groen, de
mobiele lay-outtest op instellingen en dashboard groen. De migratie en beide
functies zijn bovendien end-to-end gedraaid tegen een lokale Postgres 16 met het
volledige schema en PostgREST 12: sleutels aanmaken als owner (en geweigerd als
member), lezen, klaarzetten, uitvoeren, de terugval naar de wachtrij, een id van
een andere organisatie, de modulebeperking, idempotentie, de aanroeplimiet,
intrekken en verlopen, en een maker die geen lid meer is.

## Fase 2 — webhooks: ResoFly geeft zelf een seintje

Met fase 1 kan andere software iets **vragen**. Maar een koppeling wil ook horen
**dát** er iets gebeurde — een factuur betaald, een nieuwe klant, een ticket van
het portaal — zonder elke minuut alles opnieuw op te vragen. Daarvoor zijn er nu
webhooks: ResoFly stuurt een ondertekend JSON-bericht naar een adres van de
klant.

### Wat er gebeurt

- **39 gebeurtenissen** over klanten, contactpersonen, projecten, taken, tickets
  (en reacties), uren, offertes, facturen, contracten en afspraken. Naast
  `created`/`updated`/`deleted` de statusovergangen waar een koppeling echt op
  wacht: `invoice.paid`, `quote.accepted`, `contract.signed`, `task.completed`,
  `booking.cancelled` en meer. Inschrijven op een type, op `invoice.*` of op `*`.
- **Een trigger op elf kerntabellen** legt het vast — alleen als er in die
  organisatie een actief eindpunt is dat het wil horen. Een organisatie zonder
  webhooks betaalt er één indexopzoeking voor; een fout in de trigger blokkeert
  het opslaan nooit.
- **Een bezorger** (functie `webhooks`, elke minuut via pg_cron) ondertekent en
  verstuurt, met 8 bezorgingen tegelijk en hooguit 4 per eindpunt — zodat één
  eindpunt dat niet antwoordt de webhooks van andere organisaties niet ophoudt.
- **Opnieuw proberen** na 1 min, 5 min, 30 min, 2 uur, 6 uur, 12 uur, 24 uur en
  24 uur: negen pogingen, bijna drie dagen. Een eindpunt dat een dag lang niets
  dan fouten geeft, of `410 Gone` antwoordt, zet zichzelf uit, met de reden.

### Twee soorten eindpunten

| | In de app | Via de API (`POST /v1/webhooks`) |
|---|---|---|
| Voor | Een owner/admin die zelf een adres instelt | Zapier, Make, n8n (het "REST hooks"-patroon) |
| Hoort bij | De organisatie | De sleutel — verdwijnt bij intrekken |
| Krijgt | Alles waarop hij is ingeschreven | Alleen uit modules die de sleutel **nu** mag lezen |

Nieuwe adressen in de API: `GET /v1/events`, `GET|POST /v1/webhooks`,
`GET|PATCH|DELETE /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/test` en
`GET /v1/webhooks/{id}/deliveries`. Ze staan ook in het OpenAPI-document.

### Wat de grenzen bewaakt

- **Alleen naar buiten.** Alleen `https`, niets in een intern netwerk — ook niet
  verpakt in IPv6 (`[::ffff:10.0.0.1]`, dat de URL-parser herschrijft tot
  `::ffff:a00:1`, NAT64, documentatieblokken). Bij elke bezorging opnieuw
  gekeurd, ook waar de naam op dat moment naartoe wijst; een DNS-opzoeking die
  te lang duurt is geen vrijbrief. Doorverwijzingen volgen we niet; na 10
  seconden geven we op.
- **Ondertekend, met de tijd erin.** `ResoFly-Signature: t=…,v1=…`, een
  HMAC-SHA256 over `<t>.<body>`. Het geheim is één keer te zien en staat
  versleuteld (AES-GCM) in een tabel zonder policies.
- **Geen geheimen in een bericht.** Een patroon, geen lijst: alles wat op
  token, hash, secret, password of pin lijkt, plus opslagsleutels en
  base64-bestanden. Een wijziging die alleen zulke kolommen raakt, is ook geen
  gebeurtenis.
- **Wie wat mag.** In de app beheren alleen owners en admins webhooks; aan- en
  uitzetten en verwijderen kan ook rechtstreeks via RLS, zodat "stop hiermee"
  werkt als er verderop iets stuk is. Een koppeling ziet alleen haar eigen
  eindpunten.

### Wat de gebruiker ziet

Onder **Instellingen → API & webhooks**, onder de sleutels: een webhook
aanmaken (adres, omschrijving, gebeurtenissen per module of "Alles"), het
geheim één keer met uitleg over de handtekening, en per eindpunt de stand
(aan, uit, automatisch uit met de reden), **Testen** met het antwoord van het
eindpunt, **Bezorgingen** met elke poging, **Nieuw geheim** en **Verwijderen**.

### Wat de tests bewaken

- `webhooks.test.ts` (19) — de catalogus tegen de triggers en statusovergangen
  in de migratie, de jokers, de handtekening (ook: gewijzigde body, verkeerd
  geheim, te oud), het versleutelen, de adressen (met een volledige
  IPv6-ontleding), het herhaalschema en welke kolommen nooit meegaan.
- `webhooksServer.test.ts` (20) — de grenzen in de functies zelf: niets zonder
  cron-secret, niets claimen zonder versleutelsleutel, het adres keuren vóór het
  versturen, geen doorverwijzingen, ondertekenen wat er verstuurd wordt, de
  rechten van de sleutel vóór elke bezorging, eigen eindpunten per sleutel,
  alleen owners/admins in de app, het geheim alleen versleuteld, en dat een
  ronde klaar is lang voordat een hangende bezorging wordt teruggepakt. Elk van
  deze regels is gecontroleerd door hem in de code stuk te maken.

Nagemeten: `npm test` 432 groen, `npm run typecheck` en `npm run build` groen,
`deno check` op `api`, `api-admin`, `webhooks`, `mcp`, `mcp-oauth` en
`gerrie-agent` groen. De migratie is op een verse database gedraaid en het
geheel end-to-end getest met een lokale ontvanger over https: echte berichten en
`ping`, handtekeningen gecontroleerd zoals een ontvanger dat doet, een eindpunt
dat 500 geeft (opnieuw), `410` (uit), een doorverwijzing (niet gevolgd), een
eindpunt van een beperkte sleutel (financiële gebeurtenissen overgeslagen met de
reden), intrekken van de sleutel (eindpunten weg), en een traag eindpunt naast
een snel: het snelle kreeg zijn 12 berichten binnen 0,1 seconde, het trage
hooguit 4 tegelijk.

## Fase 3 — vaste adressen voor klanten, projecten, taken, tickets en uren

Met `/v1/actions` kon een koppeling al alles wat de app kan. Nu zijn er ook vaste
adressen met een vaste vorm, voor de zeven onderwerpen waar koppelingen het
meest mee doen — wat een webshop of een stap "Create client" in Zapier verwacht:

| Adres | Lezen | Aanmaken | Wijzigen |
|---|---|---|---|
| `/v1/clients`, `/v1/contacts` | ✓ | ✓ | ✓ |
| `/v1/projects`, `/v1/tasks` | ✓ | ✓ | ✓ |
| `/v1/tickets` | ✓ | ✓ | ✓ |
| `/v1/tickets/{ticket_id}/notes` | ✓ | ✓ | — |
| `/v1/time_entries` | ✓ | ✓ | ✓ |

Lijsten met zoeken, filters, sorteren, pagineren en `updated_since` om bij te
houden wat er veranderde. Verwijderen bewust niet: dat gaat in de app.

### De regels van de app, niet een kopie ervan

Het belangrijkste besluit: aanmaken en wijzigen gebeurt **niet met de
service-role**, maar in de database als het teamlid achter de sleutel
(`api_rest_write`, migratie 20261003020000). Daardoor geldt alles wat de app
afdwingt vanzelf ook hier:

- de module-poort (`enforce_module_write_access`) — die doet onder de
  service-role niets, omdat hij op `auth.uid()` leunt;
- de controles op dubbele klanten en contactpersonen, en dat een project, taak,
  ticket of contactpersoon alleen naar rijen in de eigen organisatie verwijst;
- klantnummers uit `create_client_with_next_code`, net als in het scherm;
- `audit_logs` op naam van het teamlid, in plaats van "onbekend".

Wat de app er in de browser zelf bij doet, doet de API ook: nieuwe uren krijgen
— als je ze weglaat — de datum van vandaag (Nederlandse tijd), declarabel zoals
de app kiest (niet bij een vaste prijs of indirecte uren) en het tarief van het
project of anders het standaardtarief. Een reactie krijgt het teamlid als
schrijver, en is standaard intern. Een ticket dat een teamlid aanmaakt, stuurt
geen "nieuw ticket"-melding naar het team. Er gaat geen welkomstmail naar een
nieuwe klant en geen e-mail bij een reactie — net als bij Gerrie.

### Wat mag

Lezen vraagt leesrecht in de module. Aanmaken en wijzigen vraagt toegangsniveau
`execute` én schrijfrecht in de module, voor de sleutel en voor het teamlid
erachter: een vast adres voert uit, het zet niets klaar. Wat de app zelf beheert
(klantnummer, portaaltoegang, de schrijver van een reactie, wiens uren het zijn)
is niet te zetten — dat weigeren zowel de API als de database.

### Wat de tests bewaken

- `apiResources.test.ts` (9) — de motor: invoer controleren en normaliseren,
  onbekende velden en parameters als fout, filters, sorteren, pagineren.
- `apiResourceSpecs.test.ts` (10) — de zeven resources naast de database: de
  toegestane waarden zijn die van de CHECK-constraints, wat alleen-lezen is
  weigert de database ook, dezelfde modules als de webhooks, elk pad vindt de
  goede resource, elke operationId komt één keer voor.
- `apiResourceServer.test.ts` (11) — de grenzen in de functies: elke leesquery
  filtert op de organisatie, de store schrijft nooit zelf, `api_rest_write`
  controleert vóór het wisselt en is `security invoker`, en `execute` plus
  schrijfrecht worden getoetst vóór er iets gebeurt. Ook deze regels zijn
  gecontroleerd door ze in de code stuk te maken.

Nagemeten: `npm test` 462 groen, `npm run typecheck` en `npm run build` groen,
`deno check` groen. End-to-end tegen een verse database met de echte functie:
55 van 55 — van een klant met klantnummer en auditlog op naam van het teamlid,
via dubbele klanten (409), een sleutel die alleen mag klaarzetten (403), rijen
van een andere organisatie (404), een sleutel waarvan de maker viewer werd en
een sleutel zonder de module uren (403), tot de afgeleide waarden bij uren en een
reactie die standaard intern is.

## Veiligheidstest — twee rondes bevindingen

Na fase 3 is de hele laag aangevallen: een aanvalsronde tegen de lokale stack
(sleutels, routes, invoer, filters, idempotentie, gelijktijdigheid,
webhook-adressen) en drie losse code-reviews (sleutels en rechten, webhooks,
vaste adressen). Geen kritieke bevindingen; wel deze, allemaal dichtgezet.

### Eerste ronde (aanvalsronde)

- Een punt aan het eind van een webhooknaam (`localhost.`) glipte langs de
  adrescontrole; een naam die naar binnen wijst (`127.0.0.1.nip.io`) werd alleen
  bij de bezorging gevangen. Nu bij aanmaken, wijzigen en elke bezorging, met
  DNS-over-HTTPS als de runtime zelf geen DNS kan opvragen.
- Een NUL-teken in de invoer gaf een 500; nu 400. Uren met een eindtijd vóór de
  begintijd worden geweigerd. Ingebouwde namen (`constructor`) zijn onbekende
  velden. Keuzelijst-filters met meer waarden (`?status=new,review`).

### Tweede ronde (reviews)

**Het klantportaal is "naar buiten".** Met alleen `execute` kon een sleutel
zonder Financiën het e-mailadres van een klant of van een contactpersoon met
portaaltoegang op zijn eigen adres zetten — en zo via het portaal facturen
inzien. Wat het portaal raakt, vraagt nu `execute_high`: in de database
(`api_rest_write`, `p_allow_outward`, fout `RS403` → 403 `insufficient_scope`)
voor de vaste adressen, en als risico `high` voor `ticket.set_client` en
`client_contact.set_active` bij de handelingen.

**Rechten per veld.** Een uurtarief of klantwaarde hoort bij Financiën. Zonder
leesrecht daar komt het veld als `null` terug (ook in het dashboard van een
project en in webhookberichten); zetten vraagt schrijfrecht in Financiën. Een
verwijzing naar een module die de sleutel niet mag lezen (uren op een project
zonder leesrecht in projecten) is een 403, vóór er iets wordt opgezocht.

**Sleutels.** Een ingetrokken of verlopen sleutel kan geen voorstel meer
neerzetten, ook niet in de race met het intrekken (trigger met `FOR SHARE`).
Wie de organisatie verlaat, verliest zijn sleutels. Een sleutel die nog gebruikt
wordt terwijl hij ingetrokken is, staat in het verzoeklog van de organisatie
(met dezelfde aanroeplimiet, zodat dat log niet vol te schrijven is). Alleen een
sleutel van de vorm die wij uitgeven wordt opgezocht.

**Invoer en antwoorden.** Een body zonder `Content-Length` wordt ook begrensd
(1 MB, gestreamd), JSON hooguit 32 niveaus diep, getallen alleen in gewone
notatie, een lijst met teksten bevat teksten. Bladeren gaat tot offset 10.000,
met een fout in plaats van stil afkappen. E-mailfilters negeren hoofdletters.
Antwoorden krijgen `Cache-Control: no-store`. Postgres-meldingen met tabel- en
constraintnamen gaan niet meer letterlijk naar buiten, ook niet uit een
handeling. In `ai_action_audit` staan bij een wijziging via een vast adres de
veldnamen, niet de waarden (die staan al in `audit_logs`).

**Idempotentie.** De zoekparameters tellen mee (`?mode=queue` is een ander
verzoek), een herhaling krijgt de `Location`-header terug, en een poging die
nooit afkwam houdt de sleutel hooguit 5 minuten vast in plaats van een dag.

**Webhooks.**
- *DNS-rebinding*: de bezorger zoekt de naam één keer op, keurt de adressen en
  verbindt met precies zo'n adres (`webhookTransport.ts`: `Deno.connect` +
  `Deno.startTls`, certificaat gecontroleerd tegen de naam). Een naam die
  tussendoor omslaat naar 127.0.0.1, komt niet meer binnen. Heeft een naam geen
  adres, dan wordt er niet verstuurd maar later opnieuw geprobeerd.
- Van een antwoord wordt hooguit 4 kB gelezen (was: alles, daarna afgekapt — een
  antwoord van een gigabyte kon de bezorger laten omvallen).
- Het webhook-adres (vaak zelf een geheim, zoals bij Zapier) stond als label in
  `audit_logs`, dat elk teamlid leest. Nu de omschrijving; bestaande regels zijn
  opgeschoond.
- Claimen is eerlijk per eindpunt: één eindpunt met een grote achterstand vulde
  de kandidatenlijst, en dan kwamen andere organisaties niet aan de beurt. Rondes
  claimen één voor één (`pg_advisory_xact_lock`).
- Een bericht bevat per onderwerp een vaste lijst velden — die van de API —
  in plaats van "alles behalve geheimen". Interne velden (reacties onder een
  taak, interne goedkeuring, de contracttekst) gaan niet meer mee, en een
  wijziging aan een veld buiten de lijst is geen gebeurtenis.
- Testen kan één keer per 10 seconden per eindpunt; het testbericht noemt niet
  meer het e-mailadres van wie er klikte. Webhooks uit de app en van sleutels
  hebben aparte ruimte (50, en 20 per sleutel / 100 samen). Aan- of uitzetten in
  de app kan de foutteller en de reden van uitzetten niet meer invullen. IPv6:
  ook 6to4, Teredo, site-local en lokale NAT64 tellen als intern.
- De app ziet het als intrekken, hernoemen, aan/uitzetten of verwijderen niets
  raakte (RLS), in plaats van "gelukt" te melden.

### Wat de tests bewaken

- `webhookTransport.test.ts` (13) — het verzoek (geen header-injectie) en het
  lezen van een antwoord: chunked, zonder lengte, 1xx, en nooit meer dan het
  plafond — ook niet bij een opgegeven lengte van een gigabyte.
- `webhookPinning.test.ts` (10) — de echte `deliver()` met een nagespeelde DNS
  en verbinding: er wordt verbonden met het gekeurde adres en niet opnieuw
  opgezocht, een intern adres zet het eindpunt uit, geen adres is later opnieuw,
  een time-out krijgt geen tweede bericht via een ander adres, en tarieven gaan
  als `null` naar een sleutel zonder Financiën.
- `apiResourceStore.test.ts` (6) — databasefouten als zin, zonder interne namen.
- Uitbreidingen in `apiResources`, `publicApi`, `publicApiServer`,
  `apiResourceServer`, `webhookDns` en `webhooksServer` — onder meer dat de
  velden in een webhookbericht precies die van de API zijn, en dat de
  invarianttests de LAATSTE definitie van een SQL-functie lezen. De nieuwe regels
  zijn gecontroleerd door ze in de code stuk te maken (13 mutaties, alle
  gevangen).

Nagemeten: `npm test` 534 groen, `npm run typecheck` en `npm run build` groen,
`deno check` groen voor api, api-admin, webhooks, mcp, mcp-oauth en
gerrie-agent. End-to-end tegen een verse database: kern 33/33, vaste adressen
77/77, aanvalsronde 52/52, webhooks 27/27 — de webhooks via de vastgepinde
verbinding naar een echte TLS-ontvanger.

Wat buiten deze ronde bleef, is in de derde ronde opgepakt.

## Derde ronde — goedkeuren, herkomst, gokken en opruimen

Migratie `20261003040000_approvals_auth_limits.sql`.

**Goedkeuren beslist de database.** De browser voert een voorstel uit (onder de
sessie van het teamlid, met RLS) en meldde daarna via `gerrie-agent` de
uitkomst — en die melding zette met de service-role elke auditregel van de
organisatie op elke status. Een teamlid kon zo over voorstellen uit de
goedkeurwachtrij beslissen, een rechtstreekse uitvoering van een API-sleutel
achteraf op "afgewezen" zetten, of een ingetrokken voorstel op "uitgevoerd".
Wie besliste, werd niet bewaard. Nu:
- `ai_action_decide()` beslist: alleen wat nog open staat (voorgesteld, of een
  uitvoering die mislukte), een teamlid alleen over zijn eigen chatvoorstel,
  owners/admins over de wachtrij — met naam en tijd van wie besliste;
- de app zet een voorstel eerst VAST (10 minuten), voert het dan uit en meldt
  daarna de uitkomst; klikken twee beheerders tegelijk op Akkoord, dan voert
  maar één het uit en krijgt de ander "Iemand anders voert dit voorstel op dit
  moment uit" (goedkeurwachtrij, commandocentrum, chat en de afvinkborden);
- een trigger houdt een afgehandelde auditregel en het voorstel zelf (`params`)
  vast, ook voor de service-role;
- afwijzen laat zien als het niet kan, in plaats van de regel stil te laten
  verdwijnen.

**Geen verzoeken zonder herkomst.** `Origin: null` (sandbox-iframe, data:- of
file:-pagina) wordt in alle functies geweigerd, ook lokaal, en
`Access-Control-Allow-Origin: null` gaat nergens meer mee — zonder toegestane
origin geen header. De regels staan in `_shared/origins.ts` (gebruikt door
`makeCors`); de functies met een eigen kopie volgen dezelfde twee regels.
Toegestane origins uit de instellingen tellen alleen als echt http(s)-adres.

**Gokken naar sleutels.** Een sleutel die niet bestaat of niet klopt, telt per
afzender (gehasht adres, `cf-connecting-ip` voor `x-forwarded-for`). Na 60
binnen 10 minuten: 15 minuten 429 met `Retry-After` voor mislukte pogingen,
zonder verder te tellen. Een geldige sleutel werkt vanaf dat adres gewoon door
— Zapier en Make delen adressen. De sleutel en de stand van de afzender komen in
één ronde uit de database (`api_key_lookup`).

**Opruimen.** De migratie plant `api_purge_expired()` en
`webhook_purge_expired()` dagelijks in (`resofly-api-purge`, 03:17 UTC) als
pg_cron aan staat; anders een melding en geen fout. Opnieuw draaien vervangt de
taak. Ook oude tellingen van mislukte sleutels gaan weg.

### Wat de tests bewaken

- `approvals.test.ts` (8) — de regels van `ai_action_decide` en de trigger, dat
  `gerrie-agent` niet zelf in `ai_action_audit` schrijft (en geen functie
  auditregels bijwerkt), dat de app overal vastzet vóór het uitvoeren, en de
  opruimtaak.
- `origins.test.ts` (5) — de origin-regels, en dat geen enkele functie `null`
  terugstuurt of `Origin: null` binnenlaat.
- Uitbreidingen in `publicApiServer.test.ts` (de afzenderlimiet raakt alleen
  mislukte pogingen) en `publicApi.test.ts` (de zin voor "afgewezen" is overal
  dezelfde). Gecontroleerd met 9 mutaties, alle gevangen.

End-to-end: beslissen via de echte `gerrie-agent` (25/25: eigen chatvoorstel,
wachtrij alleen voor owners/admins, vastzetten tegen een collega, mislukt →
afgewezen → definitief, een rechtstreekse uitvoering blijft staan, origin
null, de afzenderlimiet), de goedkeurwachtrij in de app zelf (11/11), en de
eerdere suites opnieuw op een verse database.
