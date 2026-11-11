# Welk AI-model er draait, zie je nergens meer (2026-11-11)

Bij de Gerrie-agents stond nog steeds welk model er achter zat ("Claude Sonnet 5.5"). De
gebruiker hoort dat niet te zien. Nagelopen waar een modelnaam of de naam van de leverancier
nog bij de gebruiker kon komen, en dat overal weggehaald.

## Wat er nu klopt

- **Agentpagina.** Het blok "Model en kosten: Claude Sonnet 5.5 · grondig" heet nu
  **Nadenken en kosten**, met "Grondig — denkt langer na" of "Snel — korter nadenken,
  zuiniger". Dezelfde woorden als in de keuzelijst van de editor (`thinkingLabel`).
- **Agent-editor.** De zin "Beide standen draaien op Claude Sonnet 5.5" is weg. De uitleg
  wanneer je grondig of snel kiest, blijft.
- **Foutmeldingen.** Mislukte een aanroep naar de AI, dan ging de fout van de API letterlijk
  door, bijvoorbeeld "Claude-fout (404): model: claude-sonnet-5-5". Die kwam in de chat met
  Gerrie, in het logboek van een agent, bij het uitlezen van een factuur en bij de notulen.
  Nu zie je een gewone zin (`aiErrorMessage` in `_shared/claudeModels.ts`):
  - "De AI heeft het even te druk…" bij 429;
  - "De AI is even niet bereikbaar…" bij een storing;
  - anders "De AI-aanroep is mislukt (fout N)…".

  De echte fout staat alleen nog in de serverlog (`aiErrorLog`).
- **Gerrie zelf.** Vraag je Gerrie op welk model hij draait, dan noemde hij het gewoon. De
  gedeelde veiligheidsregels (`securityRules`) hebben een achtste regel: hij zegt dat hij
  dat niet kan vertellen en noemt geen model en geen leverancier. Die regels staan in de chat,
  de agents, de planner, de agent-bouwer en de rapportages.
- **Hulpteksten.**
  - Bij de beslislijst stond "Gerrie-kaarten draaien op het zuinige model"; nu "Gerrie-kaarten
    gaan van het maandtegoed van …".
  - Bij AI-gebruik stond "de tarieven van Claude en ElevenLabs"; nu "de tarieven van onze
    AI-leveranciers".

## Wat bewust blijft

- **De MCP-koppeling** noemt Claude, ChatGPT en Gemini. Dat is de eigen AI-app van de
  gebruiker, niet het model achter Gerrie.
- **In de database** staat per aanroep nog welk model het werk deed (`ai_usage.model`,
  `extraction_meta.model`, `result.models` van een agentrun). Dat is nodig voor de kosten en
  voor het nazoeken van fouten, en de app toont het nergens.

## Getest

- `src/lib/modelnaam.test.ts` (nieuw) leest alle broncode van de app en faalt op een modelnaam
  of model-id (Sonnet, Haiku, Opus N, Fable, `claude-sonnet-…`).
- `claudeModels.test.ts`: geen enkele foutmelding noemt een model of leverancier, en
  `gerrieCore.ts`, `claudeInvoice.ts` en `claudeSummary.ts` sturen de ruwe fout niet meer door.
- `gerrieGuard.test.ts`: de veiligheidsregels bevatten de nieuwe regel.
- `npm run typecheck`, `npm test` (1510 geslaagd) en `npm run test:mobile -- --theme=both`.
- `deno check` kon in de cloudsessie niet draaien: deno.land en esm.sh zijn daar niet
  bereikbaar. De job *edge-functions* in CI doet het bij de push naar staging.
