# Diagnose — Publieke factuurpagina: "Deze link werkt niet meer" — 2026-05-28

## Symptoom
`staging.resofly.com/invoice/<token>` toont "Deze link werkt niet meer" met als
detail "Edge Function returned a non-2xx status code".

## Oorzaak van de onleesbare melding
`supabase.functions.invoke` levert elke non-2xx-respons op als een
`FunctionsHttpError`, en `error.message` is dan ALTIJD de generieke tekst
"Edge Function returned a non-2xx status code". De werkelijke reden zit in de
response-body (`error.context`), die de pagina niet uitlas. Daardoor was nooit
zichtbaar waaróm de link faalde.

## Codefix (in deze build)
`PublicInvoicePage.tsx` en `PublicQuotePage.tsx` lezen nu `error.context` uit en
tonen de echte foutmelding van de edge function. Na deze deploy zie je op de
pagina de concrete reden, bijvoorbeeld een van:

- "Deze frontend-origin is niet toegestaan voor publieke factuurpagina." (403)
- "Deze factuurlink is ongeldig of verlopen." (404)
- "Factuur niet gevonden." / "Deze factuur is geannuleerd." (404/410)
- "PDF-snapshot ... storage-koppeling ontbreekt." (500/502)

## Meest waarschijnlijke werkelijke oorzaak op staging
De edge function `invoice-public` blokkeert elke origin die niet in de allowlist
staat (`assertAllowedOrigin`, 403). De allowlist komt uit deze env-vars (de eerste
die gevuld is telt mee):

- `INVOICE_PUBLIC_ALLOWED_ORIGINS`
- `INVOICE_ALLOWED_ORIGINS`
- `APP_PUBLIC_URL`
- `INVOICE_PUBLIC_BASE_URL`

Als geen daarvan `https://staging.resofly.com` bevat, geeft de functie voor élke
weergave een 403 — exact het patroon "continu een foutmelding".

### Oplossing (Supabase project → Edge Functions → Secrets)
Voeg de staging-origin toe, bijvoorbeeld:

```
INVOICE_PUBLIC_ALLOWED_ORIGINS=https://staging.resofly.com,https://resofly.com,https://app.resofly.com
```

Gebruik de origin (schema + host, zonder pad/slash). Meerdere door komma's
gescheiden. Zet vervolgens dezelfde waarde ook voor de quote-functie als je de
publieke offertepagina op staging gebruikt (`QUOTE_PUBLIC_ALLOWED_ORIGINS` /
`APP_PUBLIC_URL`).

Let er ook op dat `INVOICE_PUBLIC_BASE_URL` (gebruikt om de publieke links te
bouwen) naar dezelfde staging-host wijst, zodat nieuw gegenereerde links kloppen.

## Als de echte melding tóch "ongeldig of verlopen" is
Dan ligt het niet aan de origin maar aan de token zelf:
- De link is verlopen (`INVOICE_TOKEN_TTL_DAYS` / `CHECKOUT_TTL_MINUTES`), of
- de link hoort bij een factuur op een ander Supabase-project dan staging (links
  zijn niet overdraagbaar tussen databases), of
- de migraties voor `invoice_public_links` / `resolve_invoice_public_link` zijn
  nog niet toegepast op de staging-database.

Genereer in dat geval een nieuwe betaallink/verzending vanuit de app en test de
verse link.

## Niet de oorzaak
De eerdere geldprecisie- en Mollie-wijzigingen raken deze functie niet:
`invoice-public` is ongewijzigd en de payment-status-migratie wordt alleen door de
webhook gebruikt, niet door de publieke pagina.
