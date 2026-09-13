# Gerrie kan een takenlijst klaarzetten, en leest mee in mail en notulen

**13 september 2026 · staging · Fase 0 van [GERRIE_BESLISLIJST_PLAN.md](GERRIE_BESLISLIJST_PLAN.md)**

De PO ging akkoord met alle voorstellen uit het bouwplan voor de beslislijst en gaf groen licht voor Fase 0: de stukken die in de frontend moeten liggen vóórdat de eerste kaart kan verschijnen. Niets hiervan is de beslislijst zelf; het is het fundament waar Fase 1 op bouwt, en het is vandaag al bruikbaar in de chat.

## Wat er bij is gekomen

**Eén afvinklijst voor meerdere taken.** Nieuw voorsteltype `create_tasks` en de tool `propose_create_tasks`: meerdere taken tegelijk in één project, met per taak titel, prioriteit, planning, deadline en geschatte duur. In de chat, in "Nu uitvoeren" en in de goedkeurwachtrij verschijnt dezelfde afvinklijst als bij mailtjes en facturen; elke regel maakt via `onApplyProposal` een echte taak aan, langs precies dezelfde opslagweg als het taakformulier. Komen de taken uit een gesprek, dan draagt het voorstel de herkomst mee (opname, titel, datum) en krijgt een taak zonder eigen omschrijving die herkomst als tekst. Maximaal 25 per lijst; de knop heet *Maak 4 taken* en een afgehandelde regel toont *Aangemaakt* in plaats van *Verstuurd*.

**Twee leeswegen erbij in de handelingenregistry.** `client_email.recent_inbound` geeft de inkomende klantmail van de afgelopen dagen over álle klanten heen, met per mail of iemand in het team hem al opende en de eerste 300 tekens. `meeting_recording.recent` geeft de afgeronde gesprekken mét de gestructureerde notulen (besproken, besluiten, actiepunten, vervolgafspraken). Daarmee werkt "wat vroeg Jansen gisteren?" en "maak taken van de actiepunten uit de kick-off" nu gewoon in de chat. De systeemprompt noemt beide.

**De DST-rekensom is gedeeld.** `localYmd`, `wallToUtc`, `daysInMonth` en `tzOffsetMs` staan nu in `supabase/functions/_shared/schedule.ts`, zonder Deno-afhankelijkheden. De routines-runner importeert ze; de veegronde van de beslislijst (Fase 1) straks ook. Gedragsneutraal: de runner rekent exact hetzelfde als gisteren.

## Twee tests bewaken de naad

- `schedule.test.ts` legt de klokwissels van 2026 vast (29 maart en 25 oktober): 08:00 wandklok is 06:00Z in de zomer en 07:00Z in de winter, ook op de dag van de wissel zelf.
- `actionSearch.test.ts` kreeg twee vragen erbij, geformuleerd zoals iemand ze stelt: *wat hebben klanten deze week gemaild* en *wat is er besproken in het gesprek van gisteren*. Allebei worden gevonden.
- `toolCatalog.test.ts` en `actionRegistry.test.ts` bleven groen zonder aanpassing: de nieuwe tool heeft een label en een module, de nieuwe handelingen zijn leeshandelingen en hebben dus geen browser-uitvoerder nodig.

Nagemeten: 133 tests groen, `npm run typecheck` groen, `deno check` op `gerrie-agent` en `gerrie-agent-runner` groen.

## Bewust niet gedaan

| Niet gebouwd | Waarom |
|---|---|
| `ai_action_audit.signal_id` | Hoort in de Fase-1-migratie; er is nog geen signaaltabel om naar te verwijzen. |
| Een kaart op het dashboard | Dat ís Fase 1. Fase 0 zorgt alleen dat een oude frontend straks niet crasht op een onbekend voorsteltype. |
| Auto-uitvoeren van een takenlijst | Elke regel blijft een vinkje; dat is de invariant van het hele plan. |

## Deploy-volgorde

1. Frontend eerst: push naar `staging`, Cloudflare Pages bouwt. Controleer in de gedeployde bundel op de string `create_tasks`.
2. Daarna de twee edge functions die gerrieCore importeren: `gerrie-agent` en `gerrie-agent-runner`. Boot-health: het cron-pad van de runner zonder secret geeft 401.
3. Andersom is onveilig: een oude frontend die een `create_tasks`-voorstel binnenkrijgt, kent het type niet.
