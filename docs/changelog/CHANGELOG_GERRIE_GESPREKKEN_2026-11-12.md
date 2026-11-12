# Gerrie: je gesprekken terugvinden (2026-11-12)

De vraag was: de gesprekken tussen Gerrie en de gebruiker moeten als chat terug te
vinden zijn in de app, het liefst onder Gerrie in het menu. Gebruiksvriendelijk, en
veilig.

Elk gesprek met Gerrie stond al in de database (`ai_conversations` en `ai_messages`),
maar de app liet ze nergens zien. Wie de chat sloot, de pagina ververste of van
organisatie wisselde, was het gesprek kwijt. Een nieuw gesprek beginnen kon alleen
door de pagina te verversen.

## Wat er nu kan

### Gerrie → Gesprekken

Een nieuw tabblad in het Gerrie-scherm, naast Agents.

- **De lijst.** Je eigen gesprekken, nieuwste eerst, in blokken: Vandaag,
  Gisteren, Afgelopen 7 dagen, Afgelopen 30 dagen, daarna per maand. De titel is
  het begin van je eerste vraag. Na veertig gesprekken laad je er met een knop
  meer bij.
- **Zoeken.** In de titels én in de tekst van de berichten, van jou en van Gerrie.
  Onder elke treffer staat het stukje tekst waarin het woord staat. Het woord is
  gemarkeerd in de lijst en in het gesprek, en het gesprek opent bij de eerste
  treffer.
- **Teruglezen.** Het gesprek staat er als chat, met dezelfde bellen als in de
  chat rechtsonder, per dag gescheiden en met het tijdstip bij elk bericht.
- **Wat Gerrie voorstelde.** Een voorstel (factuur versturen, offerte omzetten,
  afspraak maken) staat onder het bericht, met wat ermee gebeurde: *Uitgevoerd*,
  *Goedgekeurd*, *Afgewezen*, *Mislukt* of *Niet beslist*. Uitvoeren kan hier niet
  meer. Een voorstel van vorige week rekent met de gegevens van toen; wie het nog
  wil, vraagt het Gerrie opnieuw.
- **Verder praten.** De knop onderaan zet het gesprek in de chat rechtsonder, en
  daar praat je verder waar je gebleven was. Gerrie kent de eerdere berichten.
- **Verwijderen.** Met een bevestiging. De berichten zijn daarna weg. Wat Gerrie
  voorstelde en wat het kostte, blijft in het auditspoor staan.
- **Nieuw gesprek.** Bovenaan de pagina en in de chat zelf.

Op een breed scherm staan de lijst en het gesprek naast elkaar, en het nieuwste
gesprek staat meteen open. Op telefoon en tablet zie je eerst de lijst, dan het
gesprek, met een terugknop.

### In de chat rechtsonder

De kop van de chat heeft twee knoppen erbij:

- **Nieuw gesprek**: een schone lei. Het vorige gesprek blijft bewaard onder
  Gesprekken.
- **Alle gesprekken**: naar Gerrie → Gesprekken, met het gesprek van dat moment
  open.

Een opdracht via *Nu uitvoeren* is ook een gesprek met Gerrie en staat daarna in de
lijst.

Zolang Gerrie nog antwoordt, wisselt de chat niet van gesprek; je krijgt een korte
melding. De chat houdt bij welk gesprek er in beeld is. Kwam een antwoord binnen
nadat het gesprek was gewisseld, dan landde het eerst in het verkeerde gesprek, en
ging je volgende vraag daar ook heen. Nu landt het alleen in zijn eigen gesprek
(waar het ook bewaard is). Het "denkt na"-teken gaat al uit bij de eerste woorden,
dus daar alleen op letten was niet genoeg.

## Veiligheid

- **Een chat is van jou alleen.** Tot nu toe konden owners en admins via de database
  ook de chats van collega's lezen (20260623000005). In de app was dat nergens te
  zien, maar nu gesprekken terug te vinden zijn, zou dat een stille meelezer zijn.
  De RLS laat een chat nu alleen lezen door wie hem voerde.
- **Het toezicht op agents blijft.** Verslagen van agent-runs, proefruns, de
  agent-bouwer en missieplannen zijn voor owners en admins leesbaar zoals voorheen.
  Het auditspoor (`ai_action_audit`) verandert niet.
- **De soort van een gesprek staat vast.** Nieuw veld `ai_conversations.kind`:
  `chat`, `agent_run`, `agent_preview`, `agent_builder` of `mission`. Elke plek in de
  edge functions die een gesprek maakt, moet de soort meegeven. Een gesprek dat aan
  een agent of run hangt, wordt door een trigger altijd `agent_run`. De runner
  koppelt pas na het aanmaken; zonder trigger bleef zo'n verslag een chat.
- **De app schrijft niet in de ai-tabellen.** Verwijderen loopt via de edge function
  `gerrie-agent` (action `delete_conversation`). Die zet de drie voorwaarden in de
  delete zelf: het is een chat, hij is van jou, en hij hoort bij deze organisatie.
- **Verder praten alleen in een eigen chat.** `gerrie-agent` controleerde al dat
  een meegegeven gesprek van jou was. Nu ook dat het een chat is: een id komt sinds
  vandaag uit de browser terug, en een agentverslag hoort niet via de chat verder te
  lopen. Een id dat geen uuid is, wordt geweigerd voordat de database het ziet.
- **Ook de app filtert.** Elke query in `gerrieConversations-api.ts` filtert zelf op
  organisatie, gebruiker en soort, bovenop de RLS. Zo staan de agentverslagen van
  collega's niet tussen de chats van een beheerder.
- **De module Gerrie geldt overal.** Het tabblad staat in het Gerrie-scherm, en de
  restrictive RLS op de ai-tabellen geeft niets terug als de module dicht staat.

## Database

Migratie `20261112120000_gerrie_gesprekken.sql`:

1. `ai_conversations.kind` (not null, standaard `chat`, met check). Bestaande rijen
   krijgen hun soort uit de koppeling met een agent en uit de vaste titels die de edge
   functions altijd gaven ("Agent: … — datum", "Proefrun: …", "Agent bouwen: …",
   "Agent aanpassen: …", "Missie: …"). De rest is een chat.
2. Trigger `ai_conversations_kind_from_agent`.
3. Nieuwe leesregels voor `ai_conversations` en `ai_messages`.
4. Twee indexen: de lijst per gebruiker en soort, en zoeken in je eigen berichten.

Valkuil: de backfill raakt elke rij, en de trigger die `updated_at` bijhoudt, zette
dan elk gesprek op het moment van de migratie. De lijst begon dan met alle gesprekken
op "vandaag". Die trigger staat tijdens de backfill even uit.

## Bestanden

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261112120000_gerrie_gesprekken.sql` | soort, trigger, leesregels, indexen |
| `supabase/functions/gerrie-agent/index.ts` | `delete_conversation`; verder praten alleen in een eigen chat |
| `supabase/functions/_shared/gerrieCore.ts`, `gerrie-agent-runner/index.ts` | `createConversation` met verplichte soort |
| `src/lib/gerrieConversations.ts` | lijst, datums, zoeken, voorstellen; zonder database, met tests |
| `src/lib/gerrieConversations-api.ts` | lezen uit de database |
| `src/components/GerrieConversations.tsx` | het tabblad Gesprekken |
| `src/components/GerrieChat.tsx` | Nieuw gesprek, Alle gesprekken, een gesprek terugzetten |
| `src/features/GerrieCommandCenter.tsx`, `src/main.tsx` | het tabblad en de sprong vanuit de chat |
| `src/styles/gesprekken.css` | de opmaak (`gsp-*`, `gerrie-past-*`) |

## Getest

- `npm run typecheck` en `npm test`. Nieuw is `src/lib/gerrieConversations.test.ts`:
  titels, datums, blokken, zoeken (ook `%`, `_` en `*` letterlijk), voorstelstatus.
  De test legt ook de migratie, de edge function en de app naast elkaar. Haalt
  iemand er een grens uit (eigenaar, organisatie, soort), dan faalt hij.
- `npm run test:mobile -- --theme=both`, met twee nieuwe pagina's:
  `gerrie-gesprekken` (de lijst, met een grens voor het eerste gesprek) en
  `gerrie-gesprek` (één gesprek open). De vijf tabbladen van Gerrie staan op de
  telefoon in vijf vakken.
- Met de hand in Chromium op desktop (licht en donker): zoeken, een gesprek openen,
  verder praten in de chat, nieuw gesprek, verwijderen, en "Alle gesprekken" vanuit
  de chat.
- `supabase db start`: de keten vanaf nul. Daarna in die database met twee
  organisaties, een eigenaar en een teamlid:
  - het teamlid ziet zijn eigen chat en zijn eigen agentverslag;
  - de eigenaar ziet zijn eigen chat en dat agentverslag, maar niet de chat van het
    teamlid;
  - een andere organisatie ziet niets;
  - een gebruiker kan zelf niets wissen of wijzigen;
  - verwijderen via de service-role neemt de berichten mee en laat de auditregel
    staan, met het gesprek leeg;
  - de backfill geeft de goede soort en laat `updated_at` staan;
  - de migratie nog eens draaien gaat goed.
- `deno check` op `gerrie-agent` en `gerrie-agent-runner`. In de cloudsessie waren
  deno.land en esm.sh niet bereikbaar; supabase-js liep daarom via npm. De volledige
  lijst draait in CI.
