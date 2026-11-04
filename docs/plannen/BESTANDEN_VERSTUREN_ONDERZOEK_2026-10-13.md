# Onderzoek — Bestanden veilig naar klanten versturen (2026-10-13)

> **Gebouwd op 2026-10-13** (nog niet uitgerold): zie `CHANGELOG_BESTANDEN_VERSTUREN_2026-10-13.md`
> en `BESTANDEN_VERSTUREN_SETUP.md`. Afwijkingen van dit voorstel staan in de changelog onder
> "De regels" en "Bewust niet gebouwd".

Vraag: *waar kan de functionaliteit het beste worden toegevoegd om veilig bestanden naar
klanten te versturen — nieuwe bestanden, bestanden uit de map Inhoud, enzovoort — en hoe
gaan we dat realiseren?*

Kort antwoord: **niet als bijlage aan de mail, en niet door "Delen…" op te rekken, maar als
één nieuw begrip: de _zending_** — een bevroren pakket bestanden, met een bericht, aan één
of meer geregistreerde personen van één klant. Eén venster, **Bestanden versturen**, dat je
opent waar je toch al bent: vanuit een selectie in **Inhoud** (en dus ook het klantdossier →
Bestanden) en vanuit het **mailvenster** op Berichten en in het klantdossier (paperclip). De
ontvanger krijgt geen bijlage maar een persoonlijke link; openen vraagt een code die naar het
eigen e-mailadres gaat. De zending staat daarna in het klantgesprek en in het portaal, en
houdt bij wie wat wanneer heeft geopend en gedownload.

Het meeste ligt er al: de kernregel van Delen (klant server-side afgeleid, bewaakt door een
trigger), het portaal met deeplinks en Berichten, de galerij-motor in de media-worker
(getekende tokens, streamen met Range, zip, multipart tot 30 GB), de mailsjablonen, het
eigen verzenddomein en de suppressielijst. Nieuw zijn drie dingen: **bevriezen** (een kopie
van wat je verstuurt), **toegang met een e-mailcode** zonder volledig portaal, en een
**logboek** als bewijs.

Dit document is onderzoek, geen bouwopdracht: er is nog geen regel code veranderd.

---

## 1 · Wat er al ligt

Onderzocht in de huidige `staging`-stand (`d9c5d28`).

| Bouwsteen | Waar | Wat het nu doet | Waarde voor versturen |
|---|---|---|---|
| **Delen…** (`drive_shares`) | `supabase/migrations/20260823000000_drive_shares.sql`, `supabase/functions/file-share/index.ts`, `src/components/ShareDialog.tsx` | Per map, bestand, notitie of document delen met een contactpersoon (portaal), een collega of via een deellink (alleen als het item bij geen klant hoort). Vervaldatum, downloaden aan/uit, bericht, intrekken, opnieuw sturen | De **kernregel** en hoe die wordt afgedwongen (trigger, niet het scherm) zijn één-op-één over te nemen |
| `drive_item_client()` | `…drive_shares.sql:47` | Leidt klant + project af uit map, bijlage (map/klant/project/notitie/document/taak/ticket), notitie of document; fail-closed | Bepaalt server-side bij welke klant een zending hoort |
| `drive_share_items()` | `…drive_shares.sql:505` | Klapt een map uit tot bladeren met pad; elk blad moet bij dezelfde klant horen | Dezelfde regel, maar dan één keer bij versturen (momentopname) |
| Portaal → Bestanden | `src/features/portal/ClientPortal.tsx:999`, `client-portal` (`getSharedFiles`, `downloadSharedFile`) | Toont de delingen aan de ingelogde contactpersoon | De plek voor ontvangen zendingen; deeplinks (`/portal?dossier=…&ticket=…`) bestaan al |
| Portaal → Berichten | `supabase/functions/_shared/portalMessages.ts` | Een portaalgebruiker ziet de mail die het team aan die persoon stuurde | Een zending die als bericht wordt vastgelegd, verschijnt daar vanzelf |
| `/gedeeld/<token>` | `supabase/functions/file-share-public/index.ts`, `src/features/PublicSharePage.tsx` | Pagina voor een deellink; token alleen als sha256 opgeslagen | Blauwdruk voor de ontvangstpagina |
| Galerij-motor | `workers/media-api/src/index.ts:547` (tokens), `:974` (multipart), `:1361` (bestand serveren), `:1702` (zip) | HMAC-tokens met `dl`-recht en binding aan één key, Range-requests, `nosniff` + `CSP: sandbox`, streaming zip met zip64, uploads tot 30 GB | **De** downloadmotor voor zendingen: geen base64, geen 25 MB-plafond |
| PIN met lockout | `supabase/migrations/20260803010000_gallery_module.sql:528` (`gallery_verify_share_pin`) | 8 foute pogingen → een kwartier dicht, rij-lock tegen parallelle pogingen | Dezelfde vorm voor de e-mailcode |
| Opslagquotum | `workers/media-api/src/index.ts:725` (`assertStorageCapacity`) | GB per abonnement, telt elke upload | Kopieën van zendingen tellen mee |
| Mailsjablonen + afzender | `supabase/functions/_shared/emailTemplates/`, `_shared/sendingDomain.ts` | Per organisatie aanpasbare teksten (o.a. `file.shared`), eigen verzenddomein, persoonlijke afzender | `file.transfer` en `file.transferCode` in hetzelfde register |
| Bounce → suppressielijst | `resend-webhook` (`CHANGELOG_KLANTPORTAAL_MELDINGEN_2026-10-04.md` §5) | Harde bounce of klacht → adres op de lijst van de organisatie | Afleverstatus per ontvanger |
| Ontvanger-controle | `supabase/functions/_shared/approvedRecipient.ts` | Weigert als het adres tussen openen en versturen is veranderd | Tegen de klassieker "net naar de verkeerde persoon" |
| Goedkeurwachtrij | `src/components/ClientEmailBatch.tsx` + `ApprovalChecklist` | Gerrie zet klantmails klaar, een mens keurt ze | Later: een zending via Gerrie of MCP |

**Wat er níét is:** geen begrip "zending", geen e-mailcode, geen downloadlogboek, geen
bijlagen in het mailvenster, en geen manier om bestanden bij een ticket aan de klant te tonen.

---

## 2 · Waarom "Delen…" dit niet al oplost

Delen bestaat sinds 23 augustus en is goed bewaakt, maar het is gebouwd voor **toegang
geven**, niet voor **iets versturen**. In de praktijk loop je hier tegenaan:

1. **Het hoofdadres van de klant kan niets ontvangen.** Het deelvenster toont alleen
   `client_contacts` (`src/components/ShareDialog.tsx:42`); `clients.email` is geen
   contactpersoon. Terwijl juist dát adres portaaltoegang heeft
   (`supabase/migrations/20260707000000_client_contacts.sql:180`). De meest voor de hand
   liggende ontvanger ontbreekt dus — tenzij iemand hem dubbel als contactpersoon invoert.
2. **Per item een aparte deling en een aparte mail.** Zes bestanden sturen is zes keer het
   venster, zes mails en zes kaarten in het portaal. De selectiebalk in Inhoud kent
   Verplaatsen, Downloaden en Verwijderen, maar geen Delen
   (`src/features/ContentLibrary.tsx:1211`).
3. **Een contactpersoon kan pas iets ontvangen met volledige portaaltoegang**
   (`…drive_shares.sql:338`) — en daarmee ook facturen, offertes en tickets. Het venster
   waarschuwt daar zelf voor (`ShareDialog.tsx:275`). Te grof om even een drukproef naar de
   vormgever van de klant te sturen.
4. **25 MB, zowel erin als eruit.** Uploads zijn begrensd op 25 MB (`src/lib/r2.ts:6`,
   `workers/media-api/src/index.ts:51`), en downloaden loopt als base64 in JSON door een edge
   function (`file-share-public/index.ts:40` en `:221`, `client-portal/index.ts:735`). Dat kost
   geheugen, een derde extra bytes, en een afgebroken download begint opnieuw. Voor
   ontwerpbestanden, video of een zip is het te krap.
5. **Wat je deelt, verandert mee.** Office-bestanden worden in de editor op dezelfde
   opslagsleutel overschreven (`workers/media-api/src/index.ts:2671`), en een gedeelde map is
   live (`drive_share_items`; Gerrie waarschuwt er al voor bij verplaatsen,
   `supabase/functions/_shared/actions/clients.ts:22`). Prima om samen te werken, maar je kunt
   achteraf niet aantonen *wát* de klant op een bepaalde dag kreeg — en een vertrouwelijk
   bestand dat later in een gedeelde map belandt, gaat ongemerkt mee.
6. **Het mailvenster heeft geen bijlagen.** Nieuw bericht en antwoord, op Berichten en in het
   klantdossier: alleen onderwerp en tekst (`src/features/Communication.tsx:1151`,
   `supabase/functions/mail/index.ts:682`). Daar zoekt een gebruiker als eerste.
7. **Een nieuw bestand moet eerst ergens wonen.** Wie iets van de eigen computer wil sturen,
   uploadt het eerst in een klantmap en deelt het daarna.
8. **Weinig bewijs.** Per deling alleen `view_count` en `last_viewed_at`; geen regel per
   bestand. De pagina `/gedeeld` telt een "bekeken" zodra hij laadt, ook als dat een
   linkscanner van een mailfilter is die de pagina rendert.
9. **Bijlagen bij een ticket zijn voor de klant onzichtbaar.** `client-portal` geeft bij een
   ticket alleen de notities terug.

---

## 3 · Drie manieren, en waarom het de derde wordt

**A — Echte bijlagen aan de mail.** Het snelst te bouwen en het voelt vertrouwd, maar het is
het tegendeel van veilig: het bestand staat daarna voor altijd in mailboxen, is niet in te
trekken, verloopt niet, je ziet niet of het is aangekomen, en Resend stopt rond de 40 MB per
mail (veel ontvangende servers weigeren al boven 10–25 MB). Voor gegenereerde PDF's —
offertes, facturen, contracten — is het prima, en zo blijft het. Voor bestanden: **nee**.

**B — Delen oprekken** (meer items tegelijk, hoofdadres erbij, grotere bestanden). Lost punt
1, 2 en 4 op, maar niet 3, 5, 7 en 8: Delen blijft per item en blijft live. Twee onderdelen
zijn wél de moeite waard als losse verbetering (fase 0, §10). Delen blijft bestaan voor waar
het goed in is.

**C — Een nieuw begrip: de zending.** Een pakket dat je verstuurt en dat daarna niet meer
verandert. Het is dezelfde splitsing die Dropbox maakt tussen *Delen* (toegang tot een map)
en *Transfer* (een momentopname versturen, met vervaldatum en downloadteller). Twee woorden,
twee bedoelingen:

| | Delen | Versturen (zending) |
|---|---|---|
| Wat | toegang tot een map of bestand | een vaste set bestanden |
| Verandert mee | ja, live | nee, bevroren bij versturen |
| Bedoeld voor | samenwerken, een projectmap bij de klant | opleveren, nasturen, "hierbij de stukken" |
| Bewijs | laatst bekeken | per persoon en per bestand: afgeleverd, geopend, gedownload |
| Vervaldatum | mag ontbreken | altijd |
| Ontvanger zonder portaaltoegang | kan niet (klantbestanden) | kan, met een e-mailcode |

---

## 4 · Waar het in de app komt

Eén venster, **Bestanden versturen**, met één serverpad. Het opent vanuit de plek waar je al
bent, met de context al ingevuld.

| Instappunt | Wat er gebeurt | Fase |
|---|---|---|
| **Inhoud** én **klantdossier → Bestanden** (dezelfde verkenner): selectiebalk → *Versturen…* | Geselecteerde bestanden, notities, documenten en mappen gaan als één pakket mee; de klant volgt uit de selectie | 1 |
| ⋮-menu per item → *Versturen…* (boven *Delen…*) | Hetzelfde, met één item | 1 |
| *+ Nieuw → Bestanden versturen…* | Begint leeg, met uploaden van je computer | 1 |
| **Klantdossier**, kop van de klantkaart: knop *Bestanden versturen* | Klant al gekozen; kiezen uit diens Inhoud of uploaden | 1 |
| **Mailvenster** op Berichten en in het klantdossier (nieuw bericht én antwoord): paperclip *Bestanden toevoegen* (van je computer / uit Inhoud) | De mail gaat als gewoon bericht; de bestanden zitten erin als beveiligd blok, niet als bijlage | 2 |
| **Ticket-tijdlijn**: bestanden bij een zichtbaar antwoord | De klant ziet en downloadt ze in het portaal bij het ticket | 3 |
| **Gerrie / MCP**: handeling `files.send` | Zet een zending klaar in de goedkeurwachtrij; een mens verstuurt | 3 |

Waarom deze twee als eerste: **Inhoud is waar de bestanden wonen, Berichten is waar het
gesprek woont.** De meeste mensen beginnen bij het een of het ander. Allebei komen ze uit op
hetzelfde: een zending die in het klantgesprek staat.

```
Inhoud (selectie) ──┐
Klantdossier ───────┼──► Bestanden versturen ──► file-transfer ──► zending bevroren (kopieën in R2)
Mailvenster ────────┘                                           ├──► mail zonder bijlage (Resend)
                                                                └──► bericht in het klantgesprek

Ontvanger:  mail ──► /ontvang/<token> ──► e-mailcode ──► lijst ──► download via de media-worker
            of:      klantportaal → Bestanden → Ontvangen
```

**Bewust niet:**
- **Galerij** houdt zijn eigen oplevering (kijken, favorieten, kwaliteit, Stream). Een zending
  zou daar een stap terug zijn.
- **Offertes, facturen, creditnota's en contracten** hebben eigen verzendstromen met status en
  boeking (in het factuurstelsel is versturen = boeken). Een factuur-PDF als losse zending
  omzeilt die stroom. De opslagsegmenten `invoice-pdfs`, `quote-pdfs`, `contract-pdfs` en
  `annual-account-pdfs` (`workers/media-api/src/index.ts:2826`) worden daarom geweigerd, met een
  verwijzing naar *Factuur versturen*.

---

## 5 · Hoe het werkt

### 5.1 Het venster

Vier blokken op één scherm (op de telefoon onder elkaar):

1. **Aan** — de klant (vast als die uit de selectie volgt) en de ontvangers: het
   **hoofdadres** en de actieve **contactpersonen** van die klant, plus een regel
   *+ Nieuwe contactpersoon* (naam en e-mail; géén portaaltoegang nodig). Bij bestanden die
   bij geen enkele klant horen: een los e-mailadres.
2. **Bestanden** — wat er al in zit (uit de selectie), plus *Van je computer* (slepen of
   kiezen) en *Uit Inhoud* (een kiezer over de mappen van díe klant, hergebruik van de
   mappenlijst uit `MoveDialog`). Per regel naam en grootte, bij een map "12 bestanden in 3
   mappen". Het totaal staat onderaan.
3. **Bericht** — onderwerp en tekst (dezelfde editor als de mail), vervaldatum (7, 30 of 90
   dagen; standaard 30; altijd een einde), *downloaden toestaan*, en bij nieuwe uploads
   *ook bewaren in het klantdossier*.
4. **Controleren** — één zin die alles zegt: *"3 bestanden (12,4 MB) naar Joost de Vries en
   het hoofdadres van Bakker BV, beschikbaar tot 12 november."* Pas dan *Versturen*.

### 5.2 Wat de ontvanger krijgt

- **Een mail zonder bijlage**, vanaf het eigen verzenddomein en in de huisstijl: wie het
  stuurt, het bericht, hoeveel bestanden, tot wanneer, en één knop. Geen bestandsnamen in de
  mail — die kunnen zelf al gevoelig zijn ("Ontslag J. de Vries.pdf").
- **De knop opent `/ontvang/<token>`.** Vóór verificatie toont de pagina alleen de afzender en
  "3 bestanden". Dan: *"We sturen een code naar j•••@bakker.nl"* → zes cijfers, tien minuten
  geldig, vijf pogingen, daarna een kwartier dicht.
- **Na de code:** het bericht, de lijst met voorbeeld (PDF en afbeelding in beeld, de rest als
  download) en *Alles als zip*. De sessie duurt een uur en geldt alleen voor deze zending en
  deze ontvanger.
- **In het portaal**, voor wie portaaltoegang heeft: de zending staat onder Bestanden →
  *Ontvangen* en in Berichten. Wie al is ingelogd, hoeft geen code (fase 2).

Waarom een code en niet "de link is genoeg":
- een doorgestuurde mail of een geplakte link werkt niet voor een ander — *"deel hem niet
  door"* wordt afgedwongen in plaats van gevraagd;
- het vervangt de eis van volledige portaaltoegang (punt 3 in §2), zonder dat er een account
  bij komt;
- een linkscanner komt niet langs de code, dus *geopend* betekent ook echt geopend.

Waarom geen inlogcode van Supabase Auth: die maakt voor elke ontvanger een auth-account aan,
en dan raak je het open beveiligingspunt dat portaalklanten bij inloggen in de werkruimte een
eigen owner-organisatie krijgen (`CHANGELOG_BEVEILIGING_2026-09-26.md:114`). Een eigen code in
de ontvangerrij — gehasht, met teller en lockout zoals de galerij-PIN — blijft binnen de
zending.

### 5.3 Bevriezen

Bij *Versturen* legt de server vast wat er precies de deur uitgaat:
- **bestanden** worden server-side gekopieerd naar `{org}/transfer/{zending}/…` (in de
  worker, van R2 naar R2; de browser doet niets), met naam, grootte en sha256;
- **mappen** worden op dat moment uitgeklapt, met dezelfde regel als `drive_share_items` (elk
  blad hoort bij dezelfde klant); wat er later in de map komt, gaat niet mee;
- **notities en tekstdocumenten** worden als PDF vastgelegd, zodat de ontvanger ze ook kan
  bewaren;
- **nieuwe uploads** gaan direct naar de zending; met *ook bewaren* krijgt het klantdossier
  een eigen kopie (in de open map, anders in een map *Verzonden*).

Na de vervaldatum plus een bewaartermijn (voorstel: 30 dagen) worden de kopieën opgeruimd.
Wat er over de zending bekend is — aan wie, welke bestanden, naam, grootte, sha256 en het
logboek — blijft staan. Dat is het bewijs.

### 5.4 Opslaan en downloaden

- **Downloaden** via de media-worker met een kort geldig, getekend token per bestand (soort
  `xfer`: organisatie, zending, ontvanger, key, downloadrecht, verloop) — precies het
  galerijpatroon, met binding aan één key, Range (hervatten werkt),
  `Content-Disposition: attachment`, `nosniff` en `CSP: sandbox`. De edge function controleert
  de toegang, schrijft het logboek en vraagt het token aan; de bytes gaan niet meer door een
  edge function.
- **Zip** via de bestaande zip-schrijver (`handleGalleryZip`), veralgemeend naar "een lijst
  keys".
- **Grote uploads** via de multipart-routes van de galerij, veralgemeend (parts van 64 MiB).
  Voorstel: tot 5 GB per bestand, binnen het opslagquotum.

### 5.5 Bijhouden

Per ontvanger: *Verstuurd → Afgeleverd* (Resend-webhook) *→ Geopend* (code goed, of geopend in
het portaal) *→ Gedownload* (per bestand en "alles"). Een bounce of klacht geeft een
waarschuwing en zet het adres op de suppressielijst. Zichtbaar in het klantgesprek, in een
overzicht *Gedeeld & verzonden* (de huidige knop *Gedeeld* in Inhoud) en, als je dat wilt, als
pushmelding: *"Joost heeft de bestanden gedownload."* Intrekken werkt meteen; verlengen en
opnieuw sturen kan.

---

## 6 · Beveiligingsmodel

**Eén regel, in de database** — dezelfde gedachte als bij Delen, iets anders afgebakend:

> Een zending hoort bij hoogstens één klant, en die klant volgt uit de bestanden — nooit uit
> de browser. Hoort hij bij een klant, dan gaat hij alleen naar het hoofdadres of een actieve
> contactpersoon van díe klant. Een los e-mailadres kan alleen bij bestanden die bij geen
> enkele klant horen.

Afgedwongen door een trigger (`enforce_file_transfer_rules`), met de lessen uit Delen erin:
een rij kan niet al ingetrokken worden aangemaakt, toegang wordt bij elke aanvraag opnieuw
afgeleid, en na versturen zijn de bestanden van een zending niet meer te wijzigen.

| Risico | Maatregel |
|---|---|
| Verkeerde klant | Klant server-side afgeleid; een selectie over twee klanten heen wordt geweigerd |
| Verkeerde persoon | Alleen geregistreerde personen van die klant; de controlezin vóór versturen; `approvedRecipientChanged` als het adres intussen is veranderd |
| Doorgestuurde of gelekte link | E-mailcode naar het adres van de ontvanger; token van 32 bytes, alleen sha256 opgeslagen |
| Code raden | Zes cijfers, tien minuten, vijf pogingen, kwartier lockout, rij-lock (zoals `gallery_verify_share_pin`); hooguit een paar codes per uur per ontvanger |
| Opslagsleutel misbruiken | Token gebonden aan één key onder `{org}/transfer/{zending}/`; de worker controleert dat |
| Gevaarlijke inhoud serveren | Altijd als download; alleen beeld en PDF in beeld; `nosniff` + `CSP: sandbox` |
| Malware via een overgenomen teamaccount | Verzendquotum per organisatie en per persoon (dat geeft meteen invulling aan het open punt "vrije mail" uit de beveiligingsronde); waarschuwen of weigeren bij uitvoerbare bestanden (`.exe`, `.js`, `.vbs`, `.scr`, `.bat`, `.ps1`, `.msi`, `.lnk`) |
| Vergeten in te trekken | Altijd een vervaldatum; opruimen na de bewaartermijn |
| Rechten | Versturen vraagt schrijfrecht op Inhoud én Klanten (het is klantcommunicatie; de mailfunctie controleert `clients` ook). Viewers en de boekhouder-gast kunnen het niet |
| AVG | Logboek zonder volledig IP-adres; kopieën opgeruimd; verwijder je een klant, dan gaan diens zendingen mee |

**Bewust niet:** end-to-end-versleuteling met de sleutel in de URL (zoals Firefox Send deed).
Dat maakt voorvertoning, zip, het portaal en een latere virusscan onmogelijk, en R2 versleutelt
al op schijf. Wel het overwegen waard: de R2-bucket heeft in `workers/media-api/wrangler.toml:37`
geen EU-jurisdictie. Voor Nederlandse klanten is *staat het in de EU?* vaak de eerste vraag
bij "veilig" — dat is een aparte beslissing, want een bestaande bucket verhuist niet vanzelf.

---

## 7 · Datamodel (schets)

In het spoor van `drive_shares`, zodat RLS, org-integriteit, audit en de module-poort op
dezelfde manier werken:

```
file_transfers                      -- de zending
  id, organization_id, created_by
  client_id, project_id             -- server-side afgeleid uit de bestanden (trigger)
  subject, message
  can_download                      -- standaard aan
  expires_at                        -- verplicht
  status                            -- 'draft' | 'sent' | 'revoked' | 'expired'
  sent_at, revoked_at, revoked_by
  origin                            -- 'content' | 'message' | 'ticket' | 'gerrie' | 'api'
  client_email_id, ticket_id        -- het bericht/ticket waar hij bij hoort (fase 2/3)
  item_count, total_bytes
  purge_after                       -- vanaf wanneer de kopieën weg mogen

file_transfer_items                 -- onveranderbaar na versturen
  id, transfer_id, organization_id
  source_type                       -- 'attachment' | 'note' | 'document' | 'upload'
  source_id                         -- nullable (upload)
  name, mime_type, size_bytes, sha256
  storage_key                       -- eigen kopie onder {org}/transfer/{transfer_id}/
  path                              -- pad binnen een meegestuurde map
  position, purged_at

file_transfer_recipients
  id, transfer_id, organization_id
  kind                              -- 'client' (hoofdadres) | 'contact' | 'email' (alleen zonder klant)
  client_contact_id, email, name    -- e-mail server-side ingevuld bij 'client'/'contact'
  token_hash                        -- uniek; de platte token staat alleen in de mail
  code_hash, code_expires_at, code_attempts, locked_until
  notified_at, delivery_status
  first_opened_at, last_opened_at, open_count, first_download_at

file_transfer_events                -- append-only: het bewijs
  id, transfer_id, recipient_id, item_id
  kind                              -- 'sent' | 'delivered' | 'bounced' | 'code_sent' | 'code_failed'
                                    -- | 'opened' | 'downloaded' | 'zip' | 'revoked' | 'extended'
  created_at, meta jsonb            -- user-agent in het kort, geen volledig IP
```

Daarbij, net als bij Delen alleen voor de service-role: `resolve_file_transfer_link(token_hash)`,
`verify_file_transfer_code(recipient_id, code_hash)` (met rij-lock), en
`portal_file_transfers_for_email(email)`. Allemaal `revoke … from public, anon, authenticated`
— `supabase/functions/_shared/migrationGrants.test.ts` faalt als dat er niet staat.

---

## 8 · Waar het in de code komt

| Laag | Nieuw | Aangepast |
|---|---|---|
| Database | migratie `file_transfers` (4 tabellen, trigger, RPC's, module-poort `content`, audit, opruimen bij verwijderen van een klant) | `email_templates`-check (`file.transfer`, `file.transferCode`); `client_emails.transfer_id` (fase 2) |
| Edge functions | `file-transfer` (ingelogd: aanmaken, versturen, intrekken, verlengen, opnieuw sturen), `file-transfer-public` (`verify_jwt = false`: ophalen, code aanvragen, code controleren, downloadtoken) | `client-portal` (`getTransfers`, `getTransferDownload`, deeplink `?zending=`), `resend-webhook` (afleverstatus), `_shared/emailTemplates` |
| Gedeelde helpers | `_shared/transferRules.ts` (pure regels, met tests) | `randomToken`, `sha256Hex`, `prettyNameFromEmail` en het laden van bedrijfsgegevens staan nu drie keer los in `file-share`, `file-share-public` en `client-portal` → naar `_shared/` |
| Media-worker | `/internal/transfer/copy`, `/internal/transfer/tokens`, `/transfer/file/<key>`, `/transfer/zip/<id>` | multipart en zip-schrijver uit de galerij losgetrokken zodat beide ze gebruiken; `assertStorageCapacity` telt zendingen mee |
| Frontend | `components/SendFilesDialog.tsx`, `lib/transfers.ts` (+ tests), `features/PublicTransferPage.tsx` (`/ontvang/<token>`) | `ContentLibrary.tsx` (selectiebalk, ⋮, *+ Nieuw*), `Clients.tsx` (knop), `SharedOverview.tsx` → *Gedeeld & verzonden*, portaal Bestanden → *Ontvangen*, `types.ts`, `repository.ts`, `public/_headers` (`/ontvang/*` noindex) |
| Fase 2 | — | `Communication.tsx` (`ComposePane` + antwoord), het mailvenster in `Clients.tsx`, `ClientEmailMessage.tsx`, `lib/communication.ts`, portaal Berichten |
| Cron | opruimtaak voor verlopen kopieën | `scripts/supabase-setup-webhooks.sh` (taak + secret, zoals `portal-notify-drain`) |
| Tests | `transferRules.test.ts`, `transfers.test.ts`; mobiele lay-outtest met een seed-zending (venster, ontvangstpagina, portaal) | `tests/mobile/mock` |

Waarom een eigen edge function en niet `file-share` uitbreiden: die functie gaat over
delingen per item en is daar overzichtelijk in. De gedeelde stukken verhuizen naar `_shared/`;
de twee functies blijven elk over één ding gaan.

---

## 9 · Valkuilen die ik nu al zie

### 9.1 Financiële stukken
Zie §4: factuur-, offerte-, contract- en jaarrekening-PDF's horen niet in een zending. De
weigering moet in de database en de worker zitten, niet alleen in het venster.

### 9.2 De frontend loopt vóór op de migratie
Cloudflare Pages rolt uit vóór de Supabase-migratie. Het venster en de knop moeten in dat
gaatje netjes "nog niet beschikbaar" zeggen (`isMissingRelation` / `NotMigratedError` uit
`lib/postgrestErrors.ts`), en het portaal mag er niet op omvallen — zoals bij Berichten en de
portaalmeldingen.

### 9.3 Kopiëren kost opslag
Een zending van 2 GB telt 2 GB extra tot hij is opgeruimd; met *ook bewaren in het
klantdossier* staat een upload er tijdelijk twee keer. Dat is de prijs van bevriezen. De
opslagmeter moet het laten zien, en de opruimtaak moet echt draaien (anders groeit het stil).

### 9.4 Gemengde selectie
In de verkenner kan dit niet ontstaan: je kijkt altijd in één klant (of in "Geen klant"), en
klant- en projectmappen zijn niet aan te vinken (`ContentLibrary.tsx:676`). Via Gerrie, de
API of een latere "zoek overal" kan het wél. Daarom weigert de database een zending met
bestanden van twee klanten, met uitleg ("Een zending hoort bij één klant — dit zijn er twee"),
in plaats van er stilletjes twee zendingen van te maken.

### 9.5 Mail aan een contactpersoon in het portaal
Het portaal laat elke persoon alleen het eigen gesprek zien (`_shared/portalMessages.ts`). Een
zending aan een contactpersoon wordt dus een uitgaand bericht aan díe persoon — dat past in
die regels. Maar het mailvenster zelf stuurt nu altijd naar het hoofdadres
(`mail/index.ts:710`); met de paperclip (fase 2) komt de vraag of je in dat venster ook een
contactpersoon als ontvanger kunt kiezen. Voorstel: ja, dezelfde ontvangerkeuze als in het
verstuurvenster.

### 9.6 Linkscanners
Mailfilters openen links soms vooraf. Alles wat telt of verandert, gebeurt daarom pas na de
code en via POST — nooit bij het laden van de pagina.

### 9.7 Twee open beveiligingspunten worden belangrijker
- **Portaalklanten krijgen een eigen owner-organisatie** bij inloggen in de werkruimte. Met
  zendingen komen er meer klanten in het portaal; dit punt eerst dichtzetten.
- **Geen verzendquotum voor vrije mail.** Een zending is ook uitgaande post vanaf jullie domein;
  het quotum voor zendingen en voor vrije mail kan in één keer.

---

## 10 · Fasering en omvang

Geen urenschatting — wel eerlijk welke bestanden eraan moeten.

**Fase 0 — twee losse verbeteringen aan Delen** (klein, direct merkbaar, en het downloadpad
is precies wat fase 1 nodig heeft):
- *Hoofdadres als ontvanger*: een ontvangersoort `client` in `drive_shares`, de trigger en
  `portal_drive_shares_for_email` bijwerken, één regel in `ShareDialog`.
- *Downloaden via de worker*: `client-portal` en `file-share-public` geven een getekende
  download-URL terug in plaats van base64. Het 25 MB-plafond op downloaden verdwijnt.

**Fase 1 — de zending vanuit Inhoud en het klantdossier** (de kern): migratie, twee edge
functions, de worker-routes, twee mailsjablonen, het venster, de ontvangstpagina, het portaal
(*Ontvangen*), het overzicht *Gedeeld & verzonden*, de opruimtaak en de tests. Uploads in deze
fase tot 25 MB per bestand (de bestaande route).

**Fase 2 — in het gesprek, en groot**: de paperclip in het mailvenster (nieuw en antwoord),
de zending als blok in het bericht (team én portaal), multipart-uploads tot 5 GB, geen code
voor wie al in het portaal is ingelogd, pushmelding bij download.

**Fase 3 — uitbreidingen**: bestanden bij een ticketantwoord, `files.send` voor Gerrie/MCP via
de goedkeurwachtrij en de openbare API, een signaal in de beslislijst (*"zending na 3 dagen nog
niet geopend"*), een virusscan, en eventueel de omgekeerde richting — *bestanden opvragen*,
waarbij de klant uploadt. Dat laatste is een eigen afweging: dan komt er onbekende inhoud
binnen.

Ter vergelijking: fase 1 heeft dezelfde onderdelen als Bestanden delen (augustus) —
migratie, twee edge functions, venster, overzicht, publieke pagina, portaaltab — plus de
e-mailcode, vier worker-routes en de opruimtaak. Reken dus op ruim meer dan dat blok. Fase 0
is een fractie ervan.

---

## 11 · Beslispunten (met mijn voorstel)

| Vraag | Voorstel | Waarom |
|---|---|---|
| Mag een zending met klantbestanden naar een adres dat nog geen contactpersoon is? | **Nee**, maar *+ Nieuwe contactpersoon* staat in het venster zelf | De regel van augustus blijft staan; het wordt een bewuste handeling met spoor, zonder omweg |
| Hoe groot mogen bestanden worden? | 25 MB in fase 1, **5 GB** vanaf fase 2 | Haal multipart naar fase 1 als grote bestanden de belangrijkste reden zijn (video, ontwerpbestanden) |
| Nieuwe uploads ook in het klantdossier bewaren? | **Ja**, standaard aan, uitschakelbaar | Het dossier is het archief; de zending is de bezorging |
| Hoe lang blijven de kopieën na de vervaldatum staan? | **30 dagen**, daarna alleen de gegevens en het logboek | Ruimte voor "ik was te laat", zonder dat opslag stil groeit |
| Altijd een code? | **Ja**, behalve voor wie al in het portaal is ingelogd (fase 2) | Eén eenvoudig verhaal: openen = code naar je eigen adres |
| Melding aan de afzender bij downloaden? | **Ja**, als push, per persoon uit te zetten | Het "is het aangekomen?"-belletje wordt overbodig |
| R2 in de EU? | Apart beslissen | Raakt alle opslag, niet alleen zendingen |

---

## 12 · Advies

Begin met **fase 0**: het hoofdadres in Delen is eigenlijk een gat, en downloaden via de
worker haalt het base64-pad weg dat bij elke grotere download zou knellen. Beide zijn klein en
komen in fase 1 meteen weer van pas.

Bouw daarna **fase 1** als kern, met de zending als eigen begrip naast Delen. Het is
verleidelijk om Delen uit te breiden, maar dan blijft het live en per item, en precies die
twee eigenschappen maken het ongeschikt om iets te *versturen*.

**Fase 2** maakt het vanzelfsprekend: de paperclip in het mailvenster is waar mensen zoeken.
Zet vóór de uitrol van fase 1 de twee beveiligingspunten uit §9.7 dicht.
