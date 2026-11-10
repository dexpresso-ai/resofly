# AI-rechten: rechtstreeks uitvoeren alleen voor beheerders, en kaarten volgen alle modules (2026-11-10)

Vervolg op [CHANGELOG_GERRIE_BEVEILIGING_2026-11-10.md](CHANGELOG_GERRIE_BEVEILIGING_2026-11-10.md).
Daar stonden twee punten nog open als besluit. Beide zijn nu doorgevoerd.

## 1. Een gekoppelde AI laat alleen een owner of admin rechtstreeks uitvoeren

Een AI-koppeling (MCP) kon tot nu toe voor elk teamlid met Gerrie zelf wijzigingen doorvoeren,
als dat teamlid "Mag rechtstreeks uitvoeren" aanzette. Er klikt dan geen mens op Uitvoeren. Die AI
leest ook klantmail, tickets en notulen, dus tekst die iemand daarin zet, kan hem sturen. Dat besluit
hoort bij wie de organisatie beheert.

- **Instellingen → AI.** Alleen een owner of admin ziet bij zijn eigen koppeling de schakelaars
  "Mag rechtstreeks uitvoeren" en "Ook onomkeerbare handelingen". Een teamlid leest dat dit
  voorbehouden is aan een owner of admin. Zijn AI zet wijzigingen klaar in de goedkeurwachtrij. Ook
  het toestemmingsscherm bij het koppelen zegt het zo.
- **De database** (migratie `20261110110000_mcp_uitvoeren_alleen_beheer`):
  - De trigger op `mcp_grants` weigert `execute` en `execute_high` als wie de scope wijzigt geen
    owner of admin is.
  - Bestaande koppelingen van wie nu geen owner of admin is, verliezen die twee rechten en vallen
    terug op klaarzetten.
- **De MCP-functie** kijkt bij elke aanroep naar de rol van dat moment (`roleMayExecute` in
  `_shared/mcpAuth.ts`). Wordt een admin teamlid, dan krijgt zijn AI vanaf de volgende aanroep geen
  `execute_action` meer aangeboden, ook als de koppeling het recht nog draagt. Wordt hij later weer
  admin, dan geldt zijn eerdere keuze weer. Hij kan de schakelaar dan zelf uitzetten.
- **Bij het koppelen** kan niemand uitvoeren aanzetten. Het toestemmingsscherm geeft alleen
  meelezen en klaarzetten (`CONSENT_SCOPES`). Dat was al zo.

De openbare API (API-sleutels) is niet veranderd. Een sleutel maakt alleen een owner of admin aan.

## 2. Een kaart van de beslislijst volgt de rechten van álle modules die hij toont

Een kaart hing aan één module: die van het voorstel. Dat ging in twee gevallen mis:

- Een kaart over een klantmail (module Klanten) noemde ook de open offertes en facturen van die
  klant, en Gerrie schreef de bedragen soms in zijn samenvatting. Een teamlid zonder Financiën zag zo
  toch financiële gegevens.
- Een kaart met actiepunten uit notulen (module Projecten) liet de opname zien, en die hoort bij de
  Agenda.

Nu (migratie `20261110110100_beslislijst_modulerechten`):

- **`ai_decisions.required_modules`**: de modules boven de eigen module waarvan de kaart gegevens
  toont. Bestaande kaarten krijgen ze in de migratie. Nieuwe kaarten krijgen ze van gerrie-signals
  (`requiredModules` in `_shared/signalRules.ts`):
  - een klantmail met open offertes of facturen: Financiën;
  - een voorstel dat een bestaand project noemt (een taak), of een kaart waarbij Gerrie projecten
    opzocht: Projecten;
  - actiepunten uit notulen: Agenda.
- **Alles wat met een kaart kan, vraagt leesrecht op elk van die modules:**
  - zien (RLS);
  - afhandelen (`ai_decision_resolve`);
  - dempen (`ai_decision_mute`);
  - beslissen over het voorstel erachter (`ai_action_decide`).

  Owners en admins mogen alles en merken niets.

## Getest

- `npm run typecheck`: schoon.
- `npm test`: alle 1488 tests slagen, met nieuwe tests in `mcpAuth.test.ts` en
  `signalRules.test.ts`. De migratietest eist dat de nieuwe functies voor `anon` dicht staan.
- `deno check`: de hele lijst uit CI is schoon. Zoals vannacht met een import map, want
  deno.land en esm.sh zijn in de sandbox niet bereikbaar.
- `supabase start` op een lege database:
  - alle 266 migraties zijn toegepast;
  - beide nieuwe migraties draaien foutloos een tweede keer;
  - de opschoning en de aanvulling doen in SQL wat ze moeten. De koppeling van een teamlid verliest
    haar uitvoerrechten, die van een admin niet. Oude kaarten krijgen Financiën, Projecten of
    Agenda waar dat hoort, en niets waar dat niet hoort.
- `npm run test:stromen`:

  | Scenario | Stappen | Wat erin zit |
  | --- | --- | --- |
  | ai-rechten (nieuw) | 10 | een teamlid kan uitvoeren niet aanzetten, een admin wel; een koppeling die het recht nog draagt, voert voor een teamlid niets uit; een admin die teamlid wordt, verliest het meteen; een kaart met open facturen is voor een teamlid zonder Financiën onzichtbaar, niet af te handelen en niet goed te keuren; met alle rechten kan het wel |
  | beveiliging | 160 | |
  | videovergadering | 51 | met MCP |
  | automatisering | 10 | |
  | rook | 7 | |

  Alle stappen slagen.
- `npm run test:mobile -- --theme=both`: loopt nog bij deze commit; de uitslag komt hier.
