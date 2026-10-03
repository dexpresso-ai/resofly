# Gerrie en een gekoppelde AI praten in gewone taal

**3 oktober 2026 · volgt op [CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md](CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md)**

Gerrie en een gekoppelde AI werken met technische namen. Een tool heet `propose_invoice`, een handeling `inbox.list`, een veld `client_id` en een status `draft`. Die namen zijn nodig om iets aan te roepen, maar ze lekten ook naar de gebruiker:

- **In het antwoord.** Niets hield een model tegen om te zeggen "ik heb propose_invoice gebruikt". Gerrie's systeemprompt en de serverinstructies noemen de tools bij naam, als werkinstructie, en nergens stond dat die namen niet in het antwoord horen.
- **In de standaardvragen van de koppeling.** De opdracht onder elke standaardvraag begon met "Zoek eerst met find_actions … en gebruik daarna run_action met de exacte id's". Die tekst komt als bericht in het gesprek van de gebruiker te staan. De bron "Projectoverzicht" zei in zijn omschrijving "Zoek het project-id eerst op met find_actions".
- **In het logboek van een agent.** Daar stond onder een stap de ruwe invoer, zoals "client_id: 3f2a… · status: overdue · overdue_only: true". Een voorstel met een onbekende status toonde die status rauw ("proposed"). En zonder geladen catalogus werd een tool een halve technische naam: "gallery publish", "send reminders".

## Wat er nu is

**Eén taalregel voor allebei.** `PLAIN_LANGUAGE_RULES` in `_shared/plainLanguage.ts` zegt het volgende:

- noem geen technische namen van tools of handelingen;
- noem geen veldnamen, tabellen of statuscodes, maar vertaal ze ("concept", "te laat");
- laat geen interne id's zien: een factuur heet bij zijn nummer, een klant bij zijn naam;
- vertel bij een fout in gewone woorden wat er misging.

Gerrie's `buildSystemPrompt` neemt de regels letterlijk over. Daarmee gelden ze voor de chat, de geplande agents, het Commandocentrum en de agent-bouwer. De instructies van de MCP-server nemen dezelfde regels over.

**De koppeling.**

- Elke tool heeft een `title` die een AI-app kan tonen in plaats van de naam: "Werkruimte bekijken", "Zoeken wat er kan", "Gegevens ophalen", "Klaarzetten ter goedkeuring" en "Rechtstreeks uitvoeren".
- De omschrijvingen van de tools en de hint bij elke zoekuitslag herhalen de regel kort. Niet elke AI-app geeft de serverinstructies aan het model door.
- De standaardvragen zeggen nu "Zoek alles op in ResoFly en gebruik precies wat je daar vindt", zonder toolnamen.

**Het logboek.** `src/lib/agentLogText.ts` vertaalt de invoer van een stap: "status: te laat · alleen te laat". Id's en velden zonder vertaling vallen weg. Een stap die een handeling uit de app gebruikt, toont het label van die handeling. Statussen van voorstellen staan er in gewone taal ("wacht op akkoord", "goedgekeurd"). Zonder catalogus wordt een tool "Overige handeling", "Iets klaarzetten" of "Gegevens bekijken", en nooit een halve technische naam.

## Wat ResoFly niet in de hand heeft

- **Het venster van de AI-app zelf.** Claude laat een aanroep openklappen, en daarin staan het id en de ruwe gegevens. Dat is de app, niet het antwoord.
- **De regel is een instructie, geen filter.** Een model volgt hem, maar ResoFly herschrijft het antwoord niet achteraf.

## Getest

- **`plainLanguage.test.ts`, zes tests:**
  - de detector vindt technische namen en laat gewone taal met rust;
  - Gerrie's systeemprompt en de MCP-instructies nemen de regels over;
  - de regels noemen namen, velden, statussen, id's en foutmeldingen;
  - elke MCP-tool heeft een titel in gewone taal;
  - geen enkel label van een handeling of kerntool bevat een technische naam.
- **`mcpCatalog.test.ts`:**
  - de eis dat elke standaardvraag `find_actions` noemt, is vervangen door "zoek op en verzin niets";
  - standaardvragen en bronnen tonen geen technische namen.
- **`src/lib/agentLogText.test.ts`, zeven tests:** voor het logboek.

De volledige suite is groen: 627 tests. De typecheck van de app is schoon. `deno check` is schoon op alle 31 functies uit de CI-lijst. De mobiele lay-outtest op de Gerrie-pagina slaagt in licht en donker.

## Uitrollen

- **Edge functions:** `mcp`, `api`, `gerrie-agent`, `gerrie-agent-runner` en `gerrie-signals`. Dat zijn dezelfde vijf als bij het zoeken. Ze gaan mee met de gewone uitrol van staging, zie [SUPABASE_STAGING_LAPTOP.md](SUPABASE_STAGING_LAPTOP.md). Er zijn geen migraties of secrets bij.
- **Frontend:** Cloudflare Pages bouwt die vanzelf na de push naar `staging`.

**Controleren:**

- Vraag Gerrie en de gekoppelde AI om een conceptfactuur voor een klant. Het antwoord hoort te zeggen dat er een conceptfactuur klaarstaat, zonder `propose_invoice`.
- Open in het Commandocentrum een run van een agent. Onder de stappen staan filters in gewone taal, geen veldnamen of id's.
