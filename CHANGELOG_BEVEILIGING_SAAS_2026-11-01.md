# Beveiligingsronde SaaS: de app doorgelicht voor gebruik door meerdere klanten

**1 november 2026 · database, edge functions, workers, frontend en Supabase-instellingen**

Doel: de app veilig kunnen aanbieden als SaaS, met veel organisaties naast elkaar.
Dit is de tweede ronde na `CHANGELOG_BEVEILIGING_2026-09-26.md`. Sindsdien kwamen
de openbare API, webhooks, het boekhouder-gastaccount, bestanden versturen,
teamchat-teams, klantmeldingen, e-facturatie en Jitsi erbij.

> **Status: in uitvoering.** Onderaan staat wat nog openligt. Een volgende sessie
> begint bij **Verder in de volgende sessie**.

## Werkwijze

- **Live op staging, alleen lezen.** Via de Supabase Management API zijn de echte
  functies, RLS-policies, grants en Auth-instellingen van staging opgehaald, en
  niet afgeleid uit 205 migraties.
- **Per onderdeel een review:**
  - security-definer-functies;
  - RLS-policies;
  - publieke edge functions en webhooks;
  - ingelogde edge functions en de handelingen van Gerrie, MCP en API;
  - de Cloudflare-workers;
  - de frontend en de repo-configuratie.
- **Elke bevinding zelf nagetrokken** voordat er een fix kwam.

## Live controles op staging (1 november)

| Controle | Uitslag |
| --- | --- |
| Tabellen zonder RLS | 0 |
| Security-definer-functies zonder vaste `search_path` | 0 |
| Views zonder `security_invoker` | 0 |
| Policies met `using (true)` of `with check (true)` | 0 |
| Security-definer-functies die `anon` kan aanroepen | 47, allemaal triggerfuncties (niet rechtstreeks aan te roepen) |
| Security-definer-functies die elke ingelogde gebruiker kan aanroepen | 131, nagelopen in deze ronde |
| Opslag-buckets in Supabase Storage | 0 (bestanden staan in R2) |

## Bevindingen en fixes

_(wordt per onderdeel aangevuld)_

## Verder in de volgende sessie

1. Lees deze file en `git log --oneline staging -20`.
2. Ga verder met het eerste onderdeel hieronder dat nog niet af is.

| Onderdeel | Stand |
| --- | --- |
| Live controles staging | klaar |
| Security-definer-functies | bezig |
| RLS-policies | bezig |
| Publieke edge functions en webhooks | bezig |
| Ingelogde edge functions en handelingen | bezig |
| Cloudflare-workers | bezig |
| Frontend en repo-configuratie | bezig |
| Supabase Auth-instellingen | bezig |
