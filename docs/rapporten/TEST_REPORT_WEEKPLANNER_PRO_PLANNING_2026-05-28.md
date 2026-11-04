# Test report - Weekplanner Pro Planning (2026-05-28)

## Uitgevoerde checks

- `npm run typecheck` ✅
- `npm run build` ✅

## Gecontroleerde scenario's in code

- Taken worden gegroepeerd op `planned_date` in plaats van `end_date`.
- Slepen naar dag zet `planned_date` en berekent server-side `planned_order`.
- Slepen naar `Niet ingepland` maakt `planned_date` en `planned_order` leeg.
- Slepen boven een andere taak stuurt `beforeTaskId` naar de RPC.
- RPC controleert schrijfrechten via `can_write_org`.
- RPC voorkomt cross-tenant planning door `organization_id` op bron- en doeltaak te controleren.
- Filters werken op client, project, prioriteit, status en vrije zoektekst.
- Taken buiten de huidige week worden niet meer alleen geteld, maar zichtbaar getoond.
- Taakmodal heeft nu aparte velden voor deadline, plandatum en geschatte duur.

## Build-output

Vite build is succesvol afgerond. Er blijft één bestaande Vite-waarschuwing over grote chunks staan. Dat is geen nieuwe fout door deze wijziging.
