# Logboek: wie wat wanneer en waar heeft aangepast — 8 november 2026

Vraag: "Net als bij de value backlog wil ik voor Resofly ook een pagina onder
instellingen waar alle logging van een organisatie komt te staan. Wie wanneer
facturen stuurt, documenten wijzigt, etc. Vervang op de dashboard pagina de
huidige activiteit met deze functie."

## Wat er was

Het auditlog (`audit_logs`) bestond al: triggers op ruim zestig tabellen en
losse regels voor wat er met facturen, offertes en betalingen gebeurt, met
leesrechten per module. Je zag er weinig van:

- op het dashboard **Laatste activiteit**: vijf regels als "Bijgewerkt · task",
  zonder wie het deed;
- onder Instellingen → Organisatie & team de kaart **Audit-log basis**: de
  laatste 40 regels als "Bijgewerkt · Factuur · status, due_date".

En in de regels zelf stond te weinig voor een logboek:

- alleen *welke* kolommen veranderden, niet van wat naar wat;
- geen naam bij wie het deed (een vertrokken teamlid werd een leeg vak);
- niet bij welke klant of welk project iets hoorde;
- geen verschil tussen een teamlid, Gerrie of de API namens dat teamlid, en de
  server zelf;
- online bewerken in Office stond er als "systeem" in, met een regel per
  automatische opslag; elke toetsaanslag in een notitie gaf een eigen regel;
- op staging was bijna de helft van alle regels (1.345 van 2.901) "systeem
  wijzigde agendakoppeling": de foutmelding van de synchronisatie die steeds
  wisselde;
- een bestand in de teamchat stond er met zijn naam in, voor iedereen met
  Inhoud, ook uit een privégesprek.

## Wat het nu is

**Instellingen → Logboek** (nieuw tabblad, na Organisatie & team):

- een tijdlijn per dag (Vandaag, Gisteren, dinsdag 3 november …) met per regel
  een zin in gewone taal: *"sanne verstuurde factuur 2026-041 naar de klant"*,
  *"Jij zette taak Homepage op Klaar"*, *"daan bewerkte document Plan.docx
  online"*, *"Factuur 2026-039 is betaald"*, *"De klant accepteerde offerte
  2026-019"*;
- onder de zin: de klant en het project, "4×" bij een reeks wijzigingen kort na
  elkaar, en "via koppeling" als Gerrie, een agent, MCP of de API het deed
  namens dat teamlid;
- uitklappen geeft per veld **van oud naar nieuw** (Status: Te doen → Bezig,
  Vervaldatum, Totaal, Rol, Modulerechten …), de exacte tijd, het e-mailadres
  van wie het deed, hoe het binnenkwam en een knop **Openen** naar de taak, het
  project, de klant of de pagina (alleen als je daar mag kijken);
- zoeken (naam, nummer, e-mailadres) en filters op periode (vandaag, 7, 30 of
  90 dagen, alles), persoon (ook "Systeem"), soort (Financiën, Klanten,
  Projecten en taken, Documenten en bestanden, Tickets, Uren, Agenda,
  Marketing, Rapportages, Team, Beheer), klant en project;
- "Meer laden" per 50 regels; elke halve minuut kijkt de pagina of er nieuwe
  regels zijn en zegt dat bovenaan ("3 nieuwe wijzigingen — tonen");
- een uitklapbare uitleg wat er wel en niet in staat.

**Dashboard**: het blok *Laatste activiteit* is vervangen door **Logboek**: de
laatste zes regels als zin, met de klant en hoe lang geleden. Een regel opent
het ding zelf; *Alles bekijken* opent Instellingen → Logboek.

**Wie ziet wat** is niet veranderd: de database beslist (RLS uit
`20261003060000`). Een teamlid ziet alleen regels over modules die hij mag
lezen; sleutels, koppelingen, uitnodigingen, het abonnement en de e-mailteksten
alleen owners en admins. De boekhouder ziet het tabblad ook, met alleen de
regels over Financiën. Niemand kan een regel aanpassen of wissen.

## Database — `20261108100000_logboek.sql`

1. **Nieuwe kolommen** op `audit_logs`: `actor_label` (het e-mailadres op dat
   moment), `via` (`app`, `koppeling`, `systeem`), `client_id` en `project_id`
   (waar; geen foreign key, de regel blijft als het ding weg is), `event_count`
   en `last_at` (een samengevoegde reeks). Indexen voor de filters.
2. **`audit_row_change` opnieuw**: dezelfde acties en labels als voorheen, plus
   in `metadata.changes` per veld oud → nieuw, volgens een vaste lijst per tabel
   (`audit_field_spec`). Alleen status, datums, bedragen, aantallen en
   verwijzingen gaan er met hun waarde in; van al het andere alleen dat het
   veranderde. Een kolom die niet op de lijst staat, staat dus standaard dicht.
   Verwijzingen staan er als id in: de app zoekt de naam erbij met de rechten
   van wie kijkt, zodat er geen klantnaam in een regel over een taak belandt.
3. **Nooit in het logboek**, ook niet als "gewijzigd": tokens en hashes van
   openbare links, opslagsleutels, de PDF van een getekend contract, de
   gedeelde link van een galerij, synchronisatievelden (agenda, bank), sloten op
   bestanden en hoe vaak iets bekeken is. Een wijziging aan alléén zulke velden
   geeft geen regel meer.
4. **Samenvoegen**: dezelfde persoon die hetzelfde ding binnen 10 minuten weer
   wijzigt, geeft één regel met een teller en het verschil van begin tot eind
   (hooguit een uur per regel). Niet bij Financiën, de agenda, het team en het
   beheer: daar telt elke stap.
5. **Online bewerken in Office**: de server schrijft namens wie er bewerkt
   (`last_edited_by`); die persoon staat er nu in, niet "systeem".
6. **`via`**: Gerrie, agents, MCP en de API schrijven als het teamlid via
   `action_member_write`, `action_member_call` en `api_rest_write`, met
   zelfgemaakte claims zonder vervaltijd; zo herkent de database ze.
7. **`audit_logs_fill`** (vóór het wegschrijven) vult bij elke regel aan wat er
   niet bij stond: de naam, `via` en de klant/het project (opgezocht bij het
   ding). Zo hebben ook "factuur verstuurd", "betaald" en "offerte
   geaccepteerd" hun klant.
8. **Leesbare labels** waar het oude label een id of status was: projectleden
   en toewijzingen (de naam van het project of de taak), handgeschreven
   notities, btw-aangiftes ("K3 2026"), boekjaren, vpb-aangiftes, jaarrekeningen.
9. **Een bijlage in de teamchat** heet "Bijlage in de teamchat", zonder velden
   en zonder klant; bestaande regels zijn net zo opgeschoond.
10. **Ook gelogd**: galerijen, e-mailcampagnes en -stromen, de teksten van de
    klantmails en de eigen klantvelden. `audit_entity_module` kent ze
    (Projecten, Marketing, Beheer, Klanten).
11. **Wat er al stond**: `via = 'systeem'` waar geen gebruiker bij stond, de naam
    erbij, en de klant/het project zolang het ding er nog is.
12. Een fout in het logboek houdt de wijziging zelf nooit tegen (beide triggers
    vangen alles af en schrijven een waarschuwing in de databaselog).

Veilig opnieuw te draaien.

## Code

- `src/lib/auditLog.ts`: van regel naar zin, de wijzigingen per veld, waarden
  (statussen, bedragen, rechten, datums), de soorten, de filters en de dagen.
  Zonder React of Supabase, zodat `npm test` het naloopt.
- `src/features/AuditLog.tsx`: `AuditLogPanel` (het tabblad) en `AuditFeed` (het
  dashboard). De filterbalk is `SearchFilterPanel`, zoals op de andere pagina's.
- `src/lib/repository.ts`: `loadAuditLogPage` (filters in de query, 50 per
  keer, met het totaal) en `countAuditLogSince`.
- `src/features/SimplePages.tsx`: het tabblad `logboek`; de kaart "Audit-log
  basis" is weg.
- `src/features/Dashboard.tsx`: `AuditFeed` in plaats van "Laatste activiteit",
  in elke look.
- `src/main.tsx`: `openAuditTarget` voor Openen, en "Alles bekijken" naar het
  tabblad.
- `supabase/functions/_shared/actions/admin.ts`: `AUDIT_ENTITY_MODULE` kent de
  nieuwe soorten; Gerrie's `audit.list` geeft de nieuwe kolommen terug en kan
  filteren op klant en project.

## Getest

- `npm run typecheck`, `npm test` (1.270 tests), waaronder
  `src/lib/auditLog.test.ts`: de zinnen, waarden, filters, de indeling (gelijk
  aan die van de server en dus van de database), en op de migratie zelf: geen
  token, hash, sleutel, adres of tekst met zijn waarde, en nooit samenvoegen bij
  Financiën, de agenda, het team of het beheer.
- `npm run test:mobile -- --pages=dashboard,settings,settings-logboek
  --theme=both`: telefoon, tablet en liggend, licht en donker; het nieuwe
  meetpunt `settings-logboek` met tien regels uit de nagebootste backend.
- `npm run test:loading`.
- `supabase db reset`: de hele keten vanaf nul, en de migratie nog een keer
  erachteraan. Daarna een scenario in de database: drie taakwijzigingen kort na
  elkaar gaven één regel (Te doen → Klaar, 3×) met de omschrijving alleen als
  "gewijzigd"; alleen de volgorde in de planner verschuiven gaf geen regel;
  claims zonder vervaltijd gaven "koppeling"; een opslag uit Office op de
  service-role stond op naam van wie bewerkte; "factuur verstuurd" zonder
  context kreeg klant en project; een lid zonder Financiën las geen
  factuurregels; een project verwijderen (met zijn taken) gaf drie regels die
  hun klant en project houden; de tekst uit de omschrijving stond nergens in
  `audit_logs`.
- `deno check` van de edge functions kon in de cloudsessie niet (deno.land en
  esm.sh zijn daar niet bereikbaar); in CI slaagde het na de push, zie hieronder.

## Uitrol op staging (8 november, 08:43)

- *Deploy Supabase (staging)*: migraties, edge functions en rooktest geslaagd.
- *Frontend checks*: de migraties vanaf nul, `deno check` van alle edge
  functions (ook factuur-inbox en documentopmaak), typecheck, CSP-hash en de
  unittests geslaagd.
- Nacontrole op de staging-database (alleen lezen): `20261108100000` staat in
  `schema_migrations`; van de 2.901 bestaande regels staan er 2.221 op
  "systeem" en 680 op "app", geen regel met een gebruiker zonder naam, 800
  regels kregen een klant of project, één chatbijlage kreeg een neutrale naam;
  de zes nieuwe triggers en de nieuwe indeling (galerij, campagnes, mailteksten,
  klantvelden) staan erop.
