# Zoeken op gewone woorden: uitrollen

**3 oktober 2026 · branch `ccr-ba300c3b-i0343s`** · hoort bij
[CHANGELOG_MCP_TREFWOORDEN_2026-10-03.md](CHANGELOG_MCP_TREFWOORDEN_2026-10-03.md) en
[CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md](CHANGELOG_ZOEKEN_STOPWOORDEN_2026-10-03.md)

Na het uitrollen vindt een gekoppelde AI, zoals Claude, de kerntools met gewone woorden: "factuur maken", "offerte opstellen". Vulwoorden als "een" en "van" tellen bij het zoeken niet meer mee. Tot de functies opnieuw zijn uitgerold, draait overal nog de oude zoekfunctie.

Het **hoe** van het uitrollen staat in [SUPABASE_STAGING_LAPTOP.md](SUPABASE_STAGING_LAPTOP.md): de CLI, inloggen, de database en de functies. Dit document zegt wat deze wijziging daarvan nodig heeft, en hoe je ziet dat het werkt.

## Wat deze wijziging vraagt

De wijziging zit in vijf edge functions. Het zijn de enige waarvan de modulegraaf een van de gewijzigde bestanden bevat (`_shared/gerrieCore.ts`, `_shared/actions/registry.ts` en `_shared/actions/finance.ts`):

| Functie | Waarom |
|---|---|
| `mcp` | `find_actions` van de gekoppelde AI |
| `api` | `GET /v1/actions?q=` van de openbare API |
| `gerrie-agent` | Gerrie in de app zoekt met dezelfde functie |
| `gerrie-agent-runner` | Geplande agents |
| `gerrie-signals` | Neemt dezelfde code mee |

Wat er niet bij hoort:

- geen migraties;
- geen secrets en geen cron-taken;
- geen wijziging in `config.toml`;
- niets aan de frontend of de workers.

De koppeling in Claude hoef je niet opnieuw te maken.

## Uitrollen

1. Merge de pull request naar `staging`.
2. Volg [SUPABASE_STAGING_LAPTOP.md](SUPABASE_STAGING_LAPTOP.md). Kort:

   ```bash
   git checkout staging && git pull
   supabase db push --linked
   supabase functions deploy --project-ref enzghpduqwaojcxgwarr --use-api
   ```

**Waarom niet alleen de vijf functies?** Op `staging` staat ook de release van de openbare API, met zeven migraties. Uitgerold vanaf `staging` bevatten `mcp` en `api` die code ook, en die rekent op de nieuwe tabellen. Eerst `db push`, dan alle functies, zoals de handleiding doet, is dus de veilige volgorde.

**Staat de rest van staging al?** Dan zie je bij `supabase migration list --linked` geen lege Remote-kolom. In dat geval zijn alleen de vijf functies nodig:

```bash
supabase functions deploy mcp                 --project-ref enzghpduqwaojcxgwarr --use-api
supabase functions deploy api                 --project-ref enzghpduqwaojcxgwarr --use-api
supabase functions deploy gerrie-agent        --project-ref enzghpduqwaojcxgwarr --use-api
supabase functions deploy gerrie-agent-runner --project-ref enzghpduqwaojcxgwarr --use-api
supabase functions deploy gerrie-signals      --project-ref enzghpduqwaojcxgwarr --use-api
```

`verify_jwt = false` komt uit `config.toml` mee. Op Windows zonder geïnstalleerde CLI gebruik je `npx supabase@latest` in plaats van `supabase`.

Staat het secret `SUPABASE_DB_PASSWORD` in GitHub (stap 9 van de handleiding), dan doet de workflow dit voortaan vanzelf bij elke push naar `staging`.

## Controleren

**Zijn ze uitgerold?**

```bash
supabase functions list --project-ref enzghpduqwaojcxgwarr
```

Bij de vijf functies hoort een hoger versienummer te staan, met vandaag als datum.

**Vindt de AI de factuur?** Vraag het Claude, met de ResoFly-connector aan:

> Zoek in ResoFly met find_actions op "factuur maken" en noem de eerste drie id's. Zet niets klaar.

Hoe het hoort te zijn:

- Vóór het uitrollen staat `vat_supplement.create` bovenaan ("Btw-suppletie definitief maken").
- Erna staat `propose_invoice` bovenaan ("Conceptfactuur klaarzetten").
- Hetzelfde geldt voor "kun je voor mij een factuur maken". De vulwoorden veranderen de uitslag niet meer.
- "offerte opstellen" geeft `propose_quote` bovenaan.

Zie je nog de oude uitslag, controleer dan **welke omgeving je connector gebruikt**. In Claude, onder Customize → Connectors, staat een URL als `https://<ref>.supabase.co/functions/v1/mcp`. De ref daarin moet het project zijn dat je net hebt uitgerold.

**Of via de openbare API.** Maak onder **Instellingen → API & webhooks** een sleutel met toegang **Lezen en klaarzetten**. Een sleutel die alleen mag lezen, ziet de klaarzet-handelingen niet en vindt `propose_invoice` dus nooit.

macOS / Linux:

```bash
curl -s "https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/api/v1/actions?q=factuur%20maken" \
  -H "Authorization: Bearer rsfapi.…" | jq -r '.data[:3][] | .id'
```

Windows PowerShell:

```powershell
$uri = "https://enzghpduqwaojcxgwarr.supabase.co/functions/v1/api/v1/actions?q=factuur%20maken"
(Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer rsfapi.…" }).data | Select-Object -First 3 id, label
```

Ook hier hoort `propose_invoice` bovenaan te staan.

**Gerrie.** Stap 8 van de handleiding laat Gerrie iets klaarzetten en goedkeuren. Lukt dat, dan werkt het zoeken daar ook.

## Productie

Dit gaat mee met de productie-uitrol van staging, zoals de handleiding die beschrijft onder "Productie (later)". Deze wijziging vraagt daar niets extra's.

Rol niet alleen deze vijf functies vanaf `staging` uit naar productie, tenzij productie de rest van staging al heeft, migraties inbegrepen. Om dezelfde reden als hierboven: `mcp` en `api` rekenen op de tabellen van de API-release.

## Terugdraaien

Draai de merge van deze pull request terug op `staging`. In GitHub kan dat met de knop **Revert** op de pull request, of met:

```bash
git revert -m 1 <merge-commit>
```

Rol daarna de vijf functies opnieuw uit, met de commando's hierboven. Er is geen migratie om terug te draaien.

## Als het niet werkt

- **Claude geeft nog de oude volgorde.** Je connector wijst naar een ander project dan je hebt uitgerold (zie "Controleren"). Of Claude zocht met andere woorden. Vraag dan letterlijk om `find_actions` met "factuur maken".
- **De API geeft 401.** De sleutel klopt niet, of is ingetrokken.
- **De API geeft wel antwoord, maar zonder `propose_invoice`.** De sleutel mag alleen lezen, of het teamlid erachter heeft geen schrijfrecht op Financiën.
- **Een foutmelding van de CLI.** Zie "Problemen oplossen" in [SUPABASE_STAGING_LAPTOP.md](SUPABASE_STAGING_LAPTOP.md).
