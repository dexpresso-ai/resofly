# Zoeken op gewone woorden: uitrollen vanaf je laptop

**3 oktober 2026 · branch `ccr-ba300c3b-i0343s`** · hoort bij
[CHANGELOG_MCP_TREFWOORDEN_2026-10-03.md](CHANGELOG_MCP_TREFWOORDEN_2026-10-03.md) en
[CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md](CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md)

Na deze stappen vindt een gekoppelde AI, zoals Claude, de kerntools met gewone woorden: "factuur maken", "offerte opstellen". Vulwoorden als "een" en "van" tellen bij het zoeken niet meer mee. Tot de functies opnieuw zijn uitgerold, draait overal nog de oude zoekfunctie.

## Wat er wel en niet hoeft

Alleen **vijf edge functions** moeten opnieuw uitgerold worden. Het zijn de enige waarvan de modulegraaf een van de gewijzigde bestanden bevat (`_shared/gerrieCore.ts`, `_shared/actions/registry.ts` en `_shared/actions/finance.ts`):

| Functie | Waarom |
|---|---|
| `mcp` | `find_actions` van de gekoppelde AI |
| `api` | `GET /v1/actions?q=` van de openbare API |
| `gerrie-agent` | Gerrie in de app zoekt met dezelfde functie |
| `gerrie-agent-runner` | Geplande agents |
| `gerrie-signals` | Neemt dezelfde code mee |

Alle vijf staan in `supabase/config.toml` op `verify_jwt = false`. Daarom staat er hieronder overal `--no-verify-jwt`.

Wat **niet** hoeft:

- Er zijn geen migraties, dus `db push` is niet nodig.
- Er zijn geen nieuwe secrets.
- `config.toml` is niet gewijzigd.
- De frontend is niet gewijzigd, dus Cloudflare hoeft niet.
- De koppeling in Claude hoef je niet opnieuw te maken. Tokens en rechten blijven staan.

## Eenmalig: de laptop klaarzetten

Alle commando's zijn voor PowerShell en draaien vanuit de **root van de repo**: de map met `package.json` en `supabase\`.

1. **Node 22.18 of nieuwer.** CI gebruikt Node 22. De tests zijn TypeScript en draaien pas zonder extra vlag vanaf 22.18.
2. **De code ophalen en installeren:**

   ```powershell
   git fetch origin
   git switch ccr-ba300c3b-i0343s
   npm ci
   ```

   `npm ci` installeert ook de Supabase CLI. Die staat in `devDependencies`, dus `npx supabase` werkt daarna zonder losse installatie.
3. **Inloggen bij Supabase.** Dit opent de browser:

   ```powershell
   npx supabase login
   ```

   Liever met een token? Maak er een op https://supabase.com/dashboard/account/tokens en zet hem voor deze sessie:

   ```powershell
   $env:SUPABASE_ACCESS_TOKEN = "sbp_…"
   ```

4. **Docker heb je niet nodig.** Met `--use-api` bundelt Supabase de functies op de server. Zonder die vlag gebruikt de CLI Docker.
5. **Optioneel, de tests lokaal:**

   ```powershell
   npm test
   ```

   Je hoort 467 tests te zien, allemaal geslaagd.

## Stap 1: staging

Staging is project `enzghpduqwaojcxgwarr`. Er zijn twee routes.

### Route A, aanbevolen: via GitHub

1. Open een pull request van `ccr-ba300c3b-i0343s` naar `staging`.
2. Wacht tot **Frontend checks** groen is. Die draait de typecheck, de unit tests en `deno check` op o.a. `mcp`, `api` en `gerrie-agent`.
3. Merge de pull request.

De workflow **Deploy Supabase (staging)** draait dan vanzelf. Je vindt hem onder Actions in GitHub. Hij doet `supabase db push` (hier niets te doen) en rolt alle functies uit, dus ook deze vijf. Je laptop heb je voor staging dan niet nodig.

### Route B: met de hand vanaf de laptop

Wil je staging bijwerken zonder eerst te mergen, dan doe je dit:

```powershell
$REF = "enzghpduqwaojcxgwarr"   # staging
npx supabase functions deploy mcp                 --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy api                 --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy gerrie-agent        --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy gerrie-agent-runner --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy gerrie-signals      --project-ref $REF --no-verify-jwt --use-api
```

Mislukt er één, dan kun je precies die regel opnieuw draaien.

Let op: merge je daarna alsnog, dan rolt de workflow alles nog een keer uit. Dat is dezelfde code, dus geen probleem.

## Stap 2: controleren

**Zijn ze uitgerold?**

```powershell
npx supabase functions list --project-ref $REF
```

Bij de vijf functies hoort een hoger versienummer te staan, met vandaag als datum.

**Vindt de AI de factuur?** Vraag het Claude, met de ResoFly-connector aan:

> Zoek in ResoFly met find_actions op "factuur maken" en noem de eerste drie id's. Zet niets klaar.

Hoe het hoort te zijn:

- Vóór het uitrollen staat `vat_supplement.create` bovenaan ("Btw-suppletie definitief maken").
- Erna staat `propose_invoice` bovenaan ("Conceptfactuur klaarzetten").
- Hetzelfde geldt voor "kun je voor mij een factuur maken". De vulwoorden veranderen de uitslag niet meer.
- "offerte opstellen" geeft `propose_quote` bovenaan.

Zie je nog de oude uitslag, controleer dan **welke omgeving je connector gebruikt**. Dat zie je aan de URL in Claude, onder Customize → Connectors. Die URL ziet eruit als `https://<ref>.supabase.co/functions/v1/mcp`. De ref daarin moet het project zijn dat je net hebt uitgerold.

**Of via de openbare API.** Maak onder **Instellingen → API & webhooks** een sleutel met toegang **Lezen en klaarzetten**. Een sleutel die alleen mag lezen, ziet de klaarzet-handelingen niet en vindt `propose_invoice` dus nooit.

```powershell
$KEY = "rsfapi.…"
$uri = "https://$REF.supabase.co/functions/v1/api/v1/actions?q=" + [uri]::EscapeDataString("factuur maken")
(Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $KEY" }).data | Select-Object -First 3 id, label
```

Ook hier hoort `propose_invoice` bovenaan te staan.

**Gerrie.** Stel Gerrie in de app een gewone vraag, bijvoorbeeld "welke facturen staan open?". Hij hoort gewoon te antwoorden.

## Stap 3: productie

Doe dit pas als staging goed is. Rol uit vanaf `staging`, zodat productie draait wat er gemerged is.

1. **Zoek de ref van het productieproject op.** Die staat niet in de repo. Je vindt hem in het Supabase-dashboard: open het productieproject, ga naar Project Settings → General en kijk bij Project ID (in oudere schermen "Reference ID"). Het is ook het stuk vóór `.supabase.co` in de URL van dat project.
2. **Haal staging op en rol uit:**

   ```powershell
   git switch staging
   git pull
   $REF = "<PRODUCTIE_REF>"   # vul hier de ref van productie in
   npx supabase functions deploy mcp                 --project-ref $REF --no-verify-jwt --use-api
   npx supabase functions deploy api                 --project-ref $REF --no-verify-jwt --use-api
   npx supabase functions deploy gerrie-agent        --project-ref $REF --no-verify-jwt --use-api
   npx supabase functions deploy gerrie-agent-runner --project-ref $REF --no-verify-jwt --use-api
   npx supabase functions deploy gerrie-signals      --project-ref $REF --no-verify-jwt --use-api
   ```

3. **Controleer zoals in stap 2**, met dezelfde `$REF`.

Gebruik steeds `--project-ref` en niet `supabase link`. De repo is al gekoppeld aan staging: dat staat in `supabase/.temp/project-ref`, en dat bestand staat in git. Een commando zonder ref gaat dus naar staging. Een `supabase link` naar productie overschrijft dat bestand. Daarna gaat elk commando zonder ref stil naar productie, en die wijziging kan zo mee in een commit.

De CLI schrijft bij elk commando ook zijn versiecheck weg in `supabase/.temp/cli-latest`, dat ook in git staat. Zie je dat bestand als gewijzigd, commit het dan niet. Zet het terug met `git checkout -- supabase/.temp/cli-latest`.

## Terugdraaien

Rol dezelfde vijf functies uit vanaf de commit vóór deze wijziging, `0af4311`, en ga daarna terug naar je branch:

```powershell
git switch --detach 0af4311
npx supabase functions deploy mcp                 --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy api                 --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy gerrie-agent        --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy gerrie-agent-runner --project-ref $REF --no-verify-jwt --use-api
npx supabase functions deploy gerrie-signals      --project-ref $REF --no-verify-jwt --use-api
git switch -
```

Is `staging` inmiddels verder dan deze wijziging, met ander werk in dezelfde functies? Dan zet dit dat werk ook terug. Draai in dat geval liever de twee commits terug met `git revert` en rol daarna opnieuw uit.

## Als het niet werkt

- **"Access token not provided"**: je bent niet ingelogd. Draai `npx supabase login`, of zet `$env:SUPABASE_ACCESS_TOKEN`.
- **Een foutmelding over Docker**: `--use-api` ontbreekt in het commando.
- **`npx supabase` wordt niet herkend, of vraagt om iets te installeren**: je staat niet in de root van de repo, of `npm ci` is nog niet gedraaid.
- **De API geeft 401**: de sleutel klopt niet of is ingetrokken.
- **De API geeft wel antwoord, maar zonder `propose_invoice`**: de sleutel mag alleen lezen, of het teamlid erachter heeft geen schrijfrecht op Financiën.
- **Claude geeft nog de oude volgorde**: je connector wijst naar een ander project dan je hebt uitgerold (zie stap 2). Of Claude zocht met andere woorden. Vraag dan letterlijk om `find_actions` met "factuur maken".
