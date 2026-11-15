# Met of zonder AI: de keuze bij het inrichten (2026-11-15)

De vraag was: laat bij het inrichten van een nieuwe organisatie meteen kiezen of je AI wilt
gebruiken. Kies je "nee", dan staat Gerrie overal uit en is hij voor jou niet te bereiken. In de
instellingen kun je hem altijd weer aanzetten.

Tot nu toe (CHANGELOG_GERRIE_AANZETTEN_2026-11-12) stond Gerrie uit tot je hem zelf aanzette,
maar hij bleef in het menu staan, met het scherm "Zet Gerrie aan". Nee zeggen kon niet: de
database legde alleen iets vast als Gerrie eerder aan had gestaan.

## Wat er nu kan

### Een nieuwe stap bij het inrichten: AI

Na Mollie, vóór Klaar: **Wil je AI gebruiken?** Er staat niets vooraf gekozen.

- **Ja, met Gerrie.** Daaronder de drie punten van de pagina Gerrie, elk met een vinkje
  (Gerrie leest je gegevens, kan zich vergissen, beslist niets zelf). Pas met alle drie kun je
  verder. Gerrie staat daarna aan, net als na "Gerrie aanzetten".
- **Nee, zonder AI.** Gerrie staat voor jou overal uit. Ook het uitlezen van inkoopfacturen met AI
  gaat uit voor de organisatie: dat is een instelling van de organisatie, en wie "nee" zegt
  tegen AI, verwacht niet dat de PDF's van zijn leveranciers wel langs een AI-model gaan.
  E-facturen (UBL) lezen gewoon in, zonder AI. Aanzetten kan onder Instellingen → E-mail.

De keuze geldt voor wie inricht. Teamleden kiezen later zelf; dat staat ook in de stap.

Verder:

- Welkom heeft een vierde groep, **Met of zonder AI**. De vier kaarten staan nu twee bij twee.
- Klaar toont een regel **AI**: *Met Gerrie*, *Zonder AI* of *Nog niet gekozen*. Zonder keuze
  kun je niet afronden ("Kies nog of je AI wilt gebruiken", met Aanpassen).
- Wie al verder was dan Mollie, komt bij de stap AI uit in plaats van bij Klaar.

### Nee is overal nee

Wie koos voor geen AI (bij het inrichten, met de nieuwe knop **Liever geen AI** op de pagina
Gerrie, of met **Gerrie uitzetten** in de instellingen) ziet Gerrie nergens meer:

- niet in het menu: zijbalk, Zenit, de duimbalk op de telefoon en het zoeken kijken naar de
  rechten, en die sluiten nu ook de pagina Gerrie;
- geen chat, geen "Vraag Gerrie", geen beslislijst, geen rapportages met Gerrie (dat was al zo);
- in Stroom geen grijze regel "Afspraak laten plannen door Gerrie" meer bij het eiland. Die stond
  er voor iedereen zonder Gerrie, uitgeschakeld, met het orbje erbij.

Een onthouden tabblad op Gerrie zegt **Gerrie staat uit**: je koos ervoor geen AI te gebruiken,
met de knoppen **Naar Instellingen → AI** en **Verder zonder Gerrie**. Eerst stond daar dat
"een owner of admin deze module voor jou heeft dichtgezet". Dat klopte niet.

Nog niet gekozen blijft zoals het was: Gerrie staat in het menu, en de pagina vraagt het. Daar
staat nu naast **Gerrie aanzetten** ook **Liever geen AI**.

### Instellingen → AI

- Koos je voor geen AI, dan staat er boven de drie punten: *Je koos ervoor geen AI te
  gebruiken. Gerrie is daarom nergens in de app te zien.* Daaronder zet je hem aan, zoals altijd.
- Nog niet gekozen: naast **Gerrie aanzetten** ook **Liever geen AI**.
- "Gerrie uitzetten" zegt nu dat Gerrie ook uit het menu verdwijnt.
- **In je team** (owners en admins) onderscheidt *Nog niet gekozen* en *Koos voor geen AI*.
  Eerst stond bij beide "Gerrie uit".

### Het logboek

"anne koos voor geen AI; Gerrie (AI) staat uit" als Gerrie nooit aan stond, en zoals voorheen
"anne zette Gerrie (AI) uit" als hij wel aan stond. Nog een keer "nee" geeft geen tweede regel.

### De weigering van Gerrie

De edge functions zeggen nu "Zet hem aan onder Instellingen → AI". "Onder Gerrie" verwees bij
"geen AI" naar een pagina die niet meer in het menu staat.

## Database

Migratie `20261115120000_geen_ai_kiezen.sql` vervangt `set_ai_consent`:

- Uitzetten legt de keuze altijd vast. Bestaat er nog geen rij, dan komt er een met
  `enabled = false`, de huidige versie van de tekst, geen vinkjes en `accepted_at` leeg. Altijd
  voor de ingelogde gebruiker zelf (`auth.uid()`), nooit uit een parameter.
- Stond het al uit, dan verandert er niets.
- De eigen actieve agents gaan op pauze, ook als Gerrie nooit aan stond: een agent van vóór het
  akkoord van 12 november kan nog actief staan.
- In het logboek staat `was_aan` in de metadata.

Aanzetten verandert niet. De deuren naar de AI ook niet (`_shared/aiConsent.ts`): die laten
alleen `enabled = true` onder de huidige tekst door, en een rij met `enabled = false` was daar
al "nee". Geen nieuwe tabellen of kolommen; `EXPORT_SCHEMA_VERSION` gaat mee.

**In de app** betekent een rij met `enabled = false` voortaan: zelf gekozen voor geen AI. Dat
geldt ook voor wie op staging Gerrie al eens uitzette. Die ziet hem na de uitrol niet meer in het
menu en zet hem aan onder Instellingen → AI. Geen rij betekent: nog niet gekozen.

Staat de app eerder live dan de migratie, dan gaat "nee" bij het inrichten gewoon door (de stap
onthoudt de keuze zelf). Gerrie staat dan alleen nog in het menu tot de migratie er is.

## Bestanden

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261115120000_geen_ai_kiezen.sql` | `set_ai_consent` legt "nee" vast |
| `src/lib/aiConsent.ts` | `consentIsDeclined`, `aiChoiceOf`, de stand *Koos voor geen AI* |
| `src/lib/permissions.ts` | `aiDeclined`: ook de pagina Gerrie dicht; `gerrieDeclined`, `gerrieModuleOpen` |
| `src/lib/onboarding.ts` | de stap `ai`, en afronden pas na een keuze |
| `src/features/OrganizationSetup.tsx` | de stap AI, de regel in het overzicht, de groep bij Welkom |
| `src/components/GerrieAanzetten.tsx` | `GerrieConsentPoints` (gedeeld met de stap), **Liever geen AI**, de uitleg in de instellingen |
| `src/main.tsx` | de rechten met de keuze, het scherm "Gerrie staat uit" |
| `src/components/StroomIsland.tsx` | geen regel die naar Gerrie verwijst zonder Gerrie |
| `src/lib/auditLog.ts` | de zin "koos voor geen AI" |
| `supabase/functions/_shared/aiConsent.ts` | de weigering wijst naar Instellingen → AI |
| `src/styles/onboarding.css`, `src/styles/gerrie-aanzetten.css` | de stap, de kaarten twee bij twee, het scherm "Gerrie staat uit" |

## Getest

- `npm run typecheck` en `npm test` (1906 tests). Nieuw of uitgebreid:
  - `src/lib/aiConsent.test.ts`: nog niet gekozen of gekozen voor geen AI, de keuze in de stap,
    de rechten per rol (pagina dicht, module open voor de instellingen, eerste open pagina is
    nooit Gerrie), "geen AI" verruimt niets, het scherm "Gerrie staat uit" komt vóór "geen
    toegang", en de stap gebruikt `set_ai_consent` met de drie vinkjes.
  - `supabase/functions/_shared/aiConsent.test.ts`: de nieuwste `set_ai_consent` legt "nee" vast
    voor `v_user`, een tweede "nee" geeft geen tweede regel, `was_aan` in het logboek, de rechten.
  - `src/lib/onboarding.test.ts`: AI vlak vóór Klaar en niet optioneel, afronden pas na een
    keuze, en wie al verder was, gaat bij AI verder.
  - `src/lib/auditLog.test.ts`: de nieuwe zin.
- `npm run test:inrichten` (157 controles), in Chromium tegen de mock. De hele weg op desktop
  met "nee" en op de telefoon met "ja" (pas verder met drie vinkjes). Wat er wordt opgeslagen,
  het overzicht, en daarna de werkruimte: met "nee" geen chat en nergens het woord Gerrie, met
  "ja" wel. Verder: halverwege van vóór de stap, afronden zonder keuze, een eerdere keuze die
  terugkomt zonder opnieuw te schrijven. En later kiezen: **Liever geen AI** op de pagina Gerrie
  haalt Gerrie uit het menu, en via **Naar Instellingen → AI** zet je hem weer aan.
- `npm run test:mobile -- --theme=both`, met vijf nieuwe pagina's: `inrichten-ai`,
  `inrichten-ai-ja`, `inrichten-ai-nee`, `gerrie-uit` en `settings-ai-geen`. `inrichten-welkom`
  meet nu de vier kaarten. Van de 650 metingen gaven er twee (dashboard en W&V, donker op de
  telefoon) "app-shell niet gerenderd". Die liepen terwijl tegelijk de stromen-tests en
  `deno check` draaiden. Los opnieuw gedraaid, op telefoon, tablet en liggend in beide thema's,
  waren ze groen.
- `npm run test:loading`: groen.
- `supabase db start`: de keuze vanaf nul, met daarna in die database als verschillende
  gebruikers: "nee" zonder rij geeft een rij met Gerrie uit en één regel in het logboek
  (`was_aan: false`); nog eens "nee" geen tweede; een teamlid dat "nee" zegt, pauzeert zijn
  actieve agent; aanzetten en weer uit geeft `was_aan: true`; iemand van buiten, zelf schrijven
  en anon worden geweigerd; `accountant_fence_gaps()` is leeg; de migratie nog eens draaien gaat
  goed.
- `tests/stromen`, tegen de lokale stack: `inrichten` heeft vijf nieuwe stappen (de eigenaar
  kiest voor geen AI, `gerrie-agent` weigert met de zin over Instellingen → AI, het uitlezen van
  inkoopfacturen gaat uit en alleen beheer mag dat, een teamlid heeft nog niet gekozen, later
  weer aanzetten). Gedraaid: `inrichten` (26 stappen), `agents` (9) en `beveiliging` (161).
  Alles groen.
- `deno check` op `gerrie-agent`, `gerrie-agent-runner`, `gerrie-signals`, `mcp`, `mcp-oauth` en
  `_shared/aiConsent.ts`, met supabase-js via npm (esm.sh is in de cloudsessie niet bereikbaar).
