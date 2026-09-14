# Gerrie wacht niet meer tot je iets vraagt: de beslislijst

**14 september 2026 · staging · Fase 1 van [GERRIE_BESLISLIJST_PLAN.md](GERRIE_BESLISLIJST_PLAN.md)**

Het dashboard telde dingen ("3 offertes open bij klanten") en stuurde je naar een lijst. Vanaf nu staat er bovenaan een blok **Te beslissen** met kaarten die Gerrie zelf klaarzette uit wat er in de app gebeurde: het voorstel, de feiten waarom, en de knoppen *Akkoord · Openen · Later · Niet meer*. Gerrie stelt voor, jij beslist; er wordt niets verstuurd of aangemaakt zonder een klik.

## Twee trappen

**Trap 1, signalen.** Zeven databasetriggers en een dagelijkse veegronde schrijven feiten in `ai_signals`: offerte-mail voor het eerst geopend, klant opende de offertepagina, contract ter ondertekening verstuurd, inkomende klantmail (alleen echte post van mensen), mail in de opvangbak mét een voorgestelde klant, notulen klaar mét actiepunten, favoriet gekozen in een galerij. De veegronde vult aan wat geen trigger kan zien: offertes die binnen drie dagen verlopen, notulen die na een etmaal nog niet gemaild zijn, en een backfill van offertes en contracten van vóór het aanzetten. Elk signaal heeft een rijpingsmoment (offerte na drie dagen, contract na zeven, klantmail na vier uur, favorieten na zes uur) en een sleutel die dubbelen tegenhoudt. `ai_signal_enqueue()` is de enige ingang en kent de mutes.

**Trap 2, beslissingen.** De edge function `gerrie-signals` claimt rijpe signalen (lease, `for update skip locked`), controleert of het signaal nog geldt (offerte nog open? mail nog ongelezen? al beantwoord?) en maakt één kaart. Vijf soorten zijn **regelkaarten** zonder model: verlopende offerte, mail koppelen, actiepunten als taken, notulen mailen, favorieten als nabewerkingstaak. Drie soorten zijn **Gerrie-kaarten** op het zuinige model met een strikte tool-allowlist: opvolgmail voor een geopende offerte, herinnering voor een ongetekend contract, en een vervolg op klantmail die na vier uur nog niemand opende (antwoord, ticket, taak, of "geen actie"). De mailtekst gaat als afgebakend datablok mee met de zin dat het geen opdracht is.

Elke kaart is een voorstel in `ai_action_audit` (status `proposed`) plus een rij in `ai_decisions` met een kopie van het voorstel, de feiten (`evidence`, nooit door het model geschreven), de module van het voorstel, en bij Gerrie-kaarten het logboek en de kosten. Akkoord loopt via `executeProposal`, dezelfde weg als de chat en de goedkeurwachtrij; daarna zet de RPC `ai_decision_resolve` kaart én auditrij dicht. *Later* brengt de kaart terug (vanmiddag, morgen, volgende week); *Niet meer* dempt de kaart, alles van die klant of dit soort kaarten, en sluit meteen wat er al open stond.

## Wat de gebruiker ziet

- **Dashboard:** het blok Te beslissen boven de goedkeurwachtrij; verdwijnt als er niets wacht. Een Gerrie-kaart heeft een licht goudvlak, een regelkaart niet. Naar buiten gerichte voorstellen dragen het label *naar buiten* en de knop heet *Definitief uitvoeren*.
- **Commandocentrum:** een vierde tab **Beslissingen** met dezelfde lijst, de kaarten op Later, en voor owner/admin de instellingen: hoofdschakelaar, per soort aan/uit (met het label regel of Gerrie), tijdstip van de veegronde, de twee wachttijden, de dagcap op Gerrie-kaarten, de status van de motor, *Nu rondkijken*, de lijst Gedempt met *Opheffen*, en *Wacht op rijping* met *Nu beoordelen*.
- **Menu en meldingen:** een badge op de menuregel Gerrie, een toast zodra een kaart binnenkomt (realtime op `ai_decisions`), en één push per dag na de veegronde als er kaarten wachten (nieuw push-type `decision_digest`, uitzetbaar in Instellingen → Meldingen).

## Twee dingen die anders zijn dan het plan

- **De verlopende offerte** wordt geen wijziging van de geldigheid: een verstuurde offerte mag niet meer aangepast worden, ook de datum niet (`buildEditFinanceProposal` weigert alles behalve concepten, en terecht). De kaart zet nu een actiepunt voor vandaag op de weekplanner ("bellen of een nieuwe versie sturen") en opent de offerte met één klik.
- **Actiepunten uit een gesprek zonder project** krijgen geen kaart; een takenlijst heeft een project nodig. Het signaal wordt overgeslagen met die reden, zichtbaar in *Wacht op rijping*.

## Wat er níét gebeurt

| Niet gebouwd | Waarom |
|---|---|
| Automatisch uitvoeren, ook van regelkaarten | De invariant: niets zonder klik. Fase 3, met gate. |
| Bankkaart | Matchen draait alleen op knopdruk; de kaart zou gaan over iets wat je net zelf deed. Fase 2. |
| Push per losse kaart | Alleen de dagelijkse samenvatting; per kaart is Fase 2. |
| Persoonlijke kaarten | Kolom `assignee_user_id` bestaat, blijft null. Fase 2. |

## Wat de tests bewaken

- `signalKinds.test.ts` leest migratie, regels en frontend als tekst: de acht soorten staan overal gelijk, elke soort heeft een module en een herkomst, elke Gerrie-soort een allowlist van bestaande tools, het push-type staat op alle vier de plekken, en elke triggerfunctie is `security definer` én exception-wrapped.
- `signalRules.test.ts` test de regelbouwers als pure functies: hoogstens 25 taken met getrimde titels, de telling op de favorietenkaart, de verlopende offerte als actiepunt voor vandaag, de koppel-handeling met de juiste id's, en de klantmail-opdracht die de mail afbakent als data en "Geen actie" toelaat, met "waarom"-regels die nooit uit de mail komen.

Nagemeten: 144 tests groen, `npm run typecheck` en `npm run build` groen, `deno check` op de drie Gerrie-functies groen.

## Deploy-volgorde

1. Frontend: push naar `staging`, Cloudflare Pages bouwt.
2. Migratie `20260914000000_gerrie_beslislijst.sql` via `npx supabase db push --linked`.
3. Edge functions: `gerrie-signals` (nieuw), en `gerrie-agent` + `gerrie-agent-runner` opnieuw (gerrieCore exporteert nu `buildProposal` en `lineTotal`).
4. Secret `SIGNALS_CRON_SECRET` en de pg_cron-job `gerrie-signals-tick`, zie [GERRIE_BESLISLIJST_SETUP.md](GERRIE_BESLISLIJST_SETUP.md).
5. In de app aanzetten: Gerrie → Beslissingen → Aan. De feature staat standaard uit.
