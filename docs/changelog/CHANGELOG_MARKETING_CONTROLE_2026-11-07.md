# Marketing: controle op veiligheid en werking — 7 november 2026

Vraag: "Controleer of de marketingfunctie veilig is en goed werkt." Het rapport
met alle bevindingen, ook de open punten, staat in
`docs/rapporten/CONTROLE_MARKETING_2026-11-07.md`. Hier: wat er veranderd is.

## Wat er nu klopt

- **Een campagne bereikt de hele doelgroep.** "Nu versturen" zet de campagne
  pas voor de verzendronde klaar als de ontvangerslijst er staat
  (`started_at`). Eerst kon de ronde (elke minuut) een campagne zonder
  ontvangers op "Verzonden" zetten; dan kreeg alleen de eerste batch van
  honderd de mail. Valt de functie om tijdens het klaarzetten, dan maakt de
  verzendronde het na tien minuten zelf af.
- **De ontvangerslijst van een campagne laadt.** Het scherm vroeg een kolom
  op die niet bestaat (`created_by`), en kreeg daardoor niets.
- **Een afmelding blijft staan.** "Weer toestaan" kan alleen nog bij een
  handmatige blokkade of een bounce. Heeft iemand zich zelf afgemeld of je
  mail als spam gemeld, dan staat er een slot met uitleg, weigert de database
  het weghalen, en zet Gerrie het ook niet meer klaar. Afmelden (of een
  spamklacht) na een handmatige blokkade maakt er een echte afmelding of
  klacht van.
- **De afmeldpagina zegt de waarheid.** Lukt het opslaan niet, dan staat er
  "Er ging iets mis" in plaats van "Je bent afgemeld".
- **Pauzeren en annuleren werken meteen**, ook voor de batch die al loopt.
  Na annuleren staan de ontvangers die nooit meer mail krijgen op
  "Overgeslagen" in plaats van "In wachtrij".
- **Klantgegevens alleen voor wie Klanten mag zien.** Zonder Klanten geeft de
  doelgroeptelling alleen aantallen, en vult de testmail voorbeeldwaarden in
  ("[Klantnaam]") in plaats van een echte klant. Gerrie noemt dan geen
  klantnamen op de kaart.
- **De afzender is wie de campagne of stroom maakte.** Een teamlid kon de maker
  via de API op een collega zetten, en dan ging de mail uit met diens
  persoonlijke afzender.
- **De platte tekst volgt de HTML.** Na bewerken in het scherm bleef de platte
  tekst van een campagne of stap die Gerrie opstelde de oude; nu maakt de
  verzending hem uit de HTML. Gerrie ziet bij `flow.get` ook de tekst van
  stappen die alleen HTML hebben.
- **Onderwerp en preheader zijn één regel**, ook als een klantnaam een
  regeleinde bevat.

## Wat er veranderd is

| Bestand | Wat |
| --- | --- |
| `supabase/migrations/20261107140000_marketing_afmelden_en_afzender.sql` | afmelding en klacht niet weg te halen; klacht wint van een handmatige blokkade; trigger voor de maker van campagne en stroom; organisatiefilter in de twee triggers op `client_emails` |
| `supabase/functions/campaigns/index.ts` | volgorde bij versturen, herstel in de verzendronde, status vóór elke mail, annuleren slaat over, klantgegevens alleen met Klanten, onderwerp één regel |
| `supabase/functions/email-unsubscribe/index.ts` | elke stap controleert zijn fout; een handmatige blokkade wordt een afmelding |
| `supabase/functions/_shared/marketingRules.ts` (nieuw) | de regels die functie, Gerrie en scherm delen; spiegel in `src/lib/marketingRules.ts` |
| `supabase/functions/_shared/actions/marketing.ts` | `suppression.remove`, `suppression.add`, `campaign.set_audience`, `flow.get`, `campaign.send_test` |
| `src/lib/repository.ts`, `src/types.ts` | kolommen van de ontvangers; `removeSuppression` meldt als er niets weg is |
| `src/features/Marketing.tsx`, `src/styles/globals.css` | slot bij een vaste afmelding, uitleg op het tabblad, platte tekst leeg bij opslaan |

## Database: `20261107140000_marketing_afmelden_en_afzender.sql`

- Policy "email suppressions delete": alleen `reason in ('manual', 'bounced')`.
  Er blijft bewust geen update-policy, anders kon de reden eerst op
  'manual' en daarna weg.
- `mirror_client_email_to_campaign()`: filtert op organisatie, en een klacht
  maakt van een handmatige blokkade of bounce een klacht.
- `mark_campaign_reply_from_inbound()`: filtert op organisatie.
- `stamp_marketing_creator()` met triggers op `email_campaigns` en
  `email_flows`: de ingelogde gebruiker is de maker en blijft het. De
  service-role houdt wat hij meegaf.
- Veilig om opnieuw te draaien. De twee vervangen functies staan op staging
  precies zoals in 20260709000000 (md5 van de functietekst vergeleken); de
  nieuwe versies verschillen alleen in de genoemde regels. Staging stond op
  20261107110000.

## Uitrollen

Na het samenvoegen met `staging` zet de workflow *Deploy Supabase (staging)*
de migratie en de functies `campaigns` en `email-unsubscribe`. Er zijn geen
nieuwe secrets. Daarna één controle met de hand: stuur een testmail van een
campagne naar jezelf en klik op "Afmelden voor deze mails" (open punt O1 in
het rapport).

## Getest

- **Stroomtest** `tests/stromen/marketing.mjs` (nieuw, 28 stappen) tegen een
  lokale database met alle migraties, echte gebruikers en rechten, en de
  echte functies `campaigns`, `email-unsubscribe` en `resend-webhook`, met
  nep-Resend. Een verzendronde die midden in het klaarzetten valt; de
  ontvangerslijst met de kolommen uit `repository.ts`; tracking (geopend,
  spamklacht) via een ondertekende webhook; pauzeren na de tweede mail van een
  batch en hervatten; annuleren; herstel na een omgevallen verzending;
  afmelden via de link, met één klik, met een vervalste handtekening, en
  terwijl het opslaan faalt; wat lid en eigenaar van de afmeldlijst mogen
  halen; telling en testmail met en zonder Klanten; kijker, boekhouder, lid
  zonder Marketing en een andere werkruimte; de maker van campagne en stroom;
  een stroom activeren en afmelden via een stroommail.
  Op de code van vóór deze wijziging: 27 stappen, 16 fout. Daarna: 28 van 28.
- **De hele stroomtest** (alle scenario's, ook `beveiliging`): 682 stappen,
  0 fout, op Postgres 17.6.1.178. Op 17.6.1.111 crashte de database midden in
  het offertescenario, met de segfault waar `tests/stromen/README.md` voor
  waarschuwt; dat staat los van deze wijziging.
- `npm test`: 1222 tests, 0 fout, waaronder nieuw `src/lib/marketingColumns.test.ts`
  (de kolomlijsten van scherm en functie naast de migraties; faalt op de oude
  `repository.ts`), `src/lib/marketingRules.test.ts` (scherm, server en de
  policy in de migratie zijn het eens), `supabase/functions/_shared/
  marketingRules.test.ts` en `marketingActions.test.ts` (Gerrie: vier van de
  vijf faalden op de oude handelingen).
- `npm run typecheck` en `deno check` op de 34 functies uit de CI plus
  `documentLayout.ts` en `documentPdf.ts` (met een import map naar npm, omdat
  esm.sh en deno.land vanuit de sessie niet bereikbaar waren).
- **Migratieketen** vanaf nul met `supabase db start`, op Postgres 17.6.1.111
  (als staging) en 17.6.1.178: 253 van 253 bestanden toegepast. De migratie
  daarna nog eens los gedraaid: veilig opnieuw.
- `npm run test:mobile -- --theme=both`: 344 pagina's, 0 met problemen. Het
  tabblad Afmeldingen zelf (dat opent de test niet) apart bekeken met de
  nagebootste backend: slot bij afgemeld en klacht, knop bij bounce en
  handmatig, op telefoon en desktop, licht en donker, zonder zijwaartse
  overloop of JavaScript-fout.

In deze cloudsessie weigerde Docker Hub de images voor de volledige lokale
stack (429). De stroomtest draaide daarom tegen de database van
`supabase db start` (image via `mirror.gcr.io`), PostgREST 14.5 (het
programma van GitHub) en GoTrue 2.189.0, met een kleine doorgeefserver in
plaats van Kong: dezelfde versies als `supabase start`, alleen de gateway is
anders.
