# Teamchat: de functies en de look & feel van Microsoft Teams — 2026-10-13

De teamchat is opnieuw opgebouwd naar het voorbeeld van Microsoft Teams. Wie Teams
kent, vindt alles op dezelfde plek: links de **app-rail** (Activiteit, Chat, Teams,
Bestanden, Opgeslagen) met je eigen status onderaan, dan de lijst, rechts het
gesprek met een kop met tabbladen en **Vergaderen**. Op de telefoon en in het
zwevende paneel is het één venster tegelijk, met de onderdelen als tabbladen
bovenaan — de opbouw van de Teams-app.

## Wat er nu kan

**Chat (1-op-1 en groepschats)**
- **Groepschats**: een chat met meerdere collega's, met of zonder naam. "Nieuwe
  chat" werkt zoals in Teams: een **Aan:**-veld met chips en zoeken; één collega
  wordt een 1-op-1-chat (bestaat die al, dan komt je bericht daarin), meer
  collega's een groepschat. In een 1-op-1-chat maakt **Personen toevoegen** een
  nieuwe groepschat, ook zoals in Teams.
- Berichten in **Teams-bubbels**: andermans bericht in een witte bubbel met naam
  en tijd, je eigen bericht rechts in Teams-lavendel; opeenvolgende berichten
  onder één kopje; dagscheiding en een rode lijn **Nieuwe berichten** bij waar je
  gebleven was.
- **Zweefbalk** op elk bericht met de zes reacties van Teams (👍 ❤️ 😆 😮 😢 😠),
  meer emoji, en **Meer opties**: beantwoorden (met citaat), bewerken, verwijderen
  (met **Ongedaan maken**), vastmaken, opslaan, doorsturen, tekst kopiëren en
  markeren als ongelezen. Wie reageerde, staat in de tooltip van de reactie.
- **Leesbevestiging** per eigen bericht: verzonden (✓) of gezien (👁), in een
  groep met wie het al gezien heeft.
- **Vastgemaakte berichten** in een balk bovenaan het gesprek.
- **Vergaderen en bellen**: één klik start een Jitsi Meet-vergadering (of alleen
  geluid) en zet een vergaderkaart met **Deelnemen** in het gesprek. Een
  bestaande Teams-, Meet- of Zoom-link plakken kan ook.
- Tabblad **Gedeeld**: alle bestanden en links uit het gesprek.
- Een bericht van alleen emoji staat groot in beeld, zonder bubbel.

**Teams (kanalen met draadjes)**
- Het team is de organisatie, met zijn kanalen eronder. Een kanaal is **openbaar**
  (iedereen kan het vinden via **Kanalen ontdekken** en deelnemen) of **privé**.
  Bestaande kanalen blijven privé.
- Kanalen werken met **posts en draadjes**: een post (met onderwerp) en de
  antwoorden eronder, ingeklapt tot "3 antwoorden van …", met **Beantwoorden**.
- Kanaal bewerken (naam, omschrijving), leden toevoegen en verwijderen,
  verlaten — met systeemregels in het gesprek ("Ann heeft Bob toegevoegd").

**De opsteller**
- **Opmaak** (de pen): vet, cursief, doorhalen, opsommingen, citaat, code en
  links — met Ctrl+B/Ctrl+I. Met de opmaakbalk open is Enter een nieuwe regel en
  Ctrl+Enter versturen, net als in Teams.
- **Emoji-kiezer** met zoeken in het Nederlands en "recent gebruikt".
- **Bijlagen** via de paperclip, **plakken** (schermafbeelding) of **slepen** op
  het gesprek. Afbeeldingen staan als voorbeeld in het bericht, met een lichtbak.
- **@-vermelden** met pijltjestoetsen, en **@iedereen** in groepen en kanalen.
- **Bezorgopties**: Standaard, **Belangrijk** of **Dringend** (rode markering).
- **Concepten** blijven per gesprek bewaard ("Concept:" in rood in de lijst).
- Pijltje omhoog in een leeg veld bewerkt je laatste bericht.

**Lijst, status en meldingen**
- **Vastgemaakt** en **Recent**, met de laatste regel van elk gesprek, filters
  (ongelezen, 1-op-1, groepschats, gedempt) en per gesprek: vastmaken, dempen,
  verbergen, markeren als (on)gelezen, verlaten.
- **Zoeken** in namen én in alle berichten, met de treffer gemarkeerd; een klik
  springt naar het bericht.
- **Status** zoals in Teams: Beschikbaar, Bezet, Niet storen, Zo terug, Afwezig,
  Offline weergeven, of automatisch (na 5 minuten niets doen: Afwezig), plus een
  **statusbericht** dat vanzelf verloopt. De badges van Teams staan op elke avatar.
- **Activiteit**: wie je noemde, wie op je antwoordde en wie op je berichten
  reageerde, met een teller op de rail.
- **Opgeslagen** berichten en **Bestanden** (alles wat in je chats is gedeeld).
- **Meldingen in de app**: een banner rechtsonder bij een nieuw bericht terwijl
  je elders in ResoFly bent. Pushmeldingen openen voortaan het gesprek zelf
  (`/?chat=<id>`). Gedempt en Niet storen houden meldingen tegen, behalve bij een
  vermelding of iets dringends; een antwoord in een kanaaldraadje gaat alleen
  naar wie in dat draadje zit.
- Het zwevende paneel heeft een knop **Openen als volledige pagina**.

## Database — `20261013000000_teamchat_teams.sql`

- `chat_conversations`: soort `group` erbij; kolom `visibility` (`public`/`private`,
  alleen voor kanalen; ligt na het maken vast via de bestaande guard-trigger).
- `chat_conversation_prefs` (nieuw): vastmaken, dempen, verbergen en "ongelezen"
  per gebruiker. Een eigen tabel en geen kolommen op `chat_participants`: die
  rijen leest elke deelnemer, en dat jij een chat gedempt hebt gaat de anderen
  niets aan. Alleen je eigen rij is leesbaar; schrijven via `chat_set_preferences`.
- `chat_messages`: `kind` (`text`/`system`/`meeting`), `reply_to_id`, `parent_id`
  (draadjes, één niveau), `subject`, `importance`, `meta`, `pinned_at/by`. Trigger
  `chat_messages_validate` houdt het eerlijk: systeemregels schrijft alleen de
  database, vastmaken loopt via `chat_pin_message`, wat een bericht is ligt na
  versturen vast, een citaat of draadje blijft binnen het gesprek, een
  vergadering heeft een https-link, en `created_at` komt van de server.
- `chat_saved_messages` en `chat_member_status` (nieuw), beide onder de module
  gate van `chat` (dus ook achter het boekhouder-hek).
- RPC's: `chat_set_preferences`, `chat_pin_message`, `chat_create_group`,
  `chat_create_channel` (nu met omschrijving en zichtbaarheid; de vorm met drie
  argumenten blijft werken), `chat_add_participants` (ook groepen),
  `chat_remove_participant`, `chat_leave`, `chat_public_channels`,
  `chat_join_channel`, `chat_update_conversation`, `chat_last_messages`,
  `chat_activity`; `chat_mark_read` en `chat_unread_counts` bijgewerkt. Elke
  security-definer-functie is dicht voor anon.
- `push_on_chat_message_insert`: dempen, Niet storen, draadjes en de deeplink.
- Realtime: `chat_member_status` en `chat_conversation_prefs` in de publicatie.

Getest tegen een echte Postgres (PGlite) met een Supabase-nabootsing: de migratie
twee keer achter elkaar, en 98 gedragstests (rechten per rol incl. viewer en
boekhouder, RLS, pushontvangers, draadjes, citaten, vastmaken, ongelezen,
voorkeuren, opgeslagen, activiteit, leden, hernoemen, grants).

## Frontend

- `src/components/teamchat/` — de onderdelen (hook, shell, lijsten, gesprek,
  berichten, opsteller, dialogen, emoji); `src/components/TeamChat.tsx` blijft de
  ingang voor `main.tsx`.
- `src/styles/teamchat.css` — de opmaak, als laatste geladen. De chat draagt het
  Teams-paars als eigen huisstijl (zoals Gerrie zijn poollicht); alles hangt aan
  de `--tc-*`-tokens bovenaan. Voor white-label in de accentkleur van de
  organisatie: zet `--tc-brand`, `--tc-brand-rgb` en `--tc-brand-ink` op de
  accent-tokens. Nacht en Dag volgen de app-tokens.
- `src/lib/chatFormat.ts` (+ tests) — de opmaak van berichten. Een bericht blijft
  platte tekst in de database; er komt nooit HTML uit een bericht in de pagina en
  een link is altijd http(s).
- Op de chatpagina staat geen titelbalk meer (zoals bij Berichten) en zweeft de
  knop van Gerrie niet meer over de verstuurknop.
- De oude chatregels in `globals.css` zijn weg; alleen het zwevende paneel en de
  schermvullende opbouw op de telefoon staan er nog.
- Mobiele lay-outtest: het eerste gesprek is nu een `.tmc-row`; de mock kent de
  nieuwe tabellen en RPC's, de filters `in`/`is`/`lt`/`gt` en houdt chatberichten
  in het geheugen bij.

## Uitrol

Bij een push naar `staging` rolt de workflow *Deploy Supabase (staging)* de
migratie uit en Cloudflare Pages de frontend. Tussen die twee (een paar minuten)
kan de chat haperen: de nieuwe frontend rekent op de nieuwe tabellen en RPC's.
Laadfouten van voorkeuren, status, activiteit en de laatste regel vallen terug op
leeg, maar groepschats, de nieuwe berichtsoorten en de live-updates werken pas
als de migratie er staat. Geen nieuwe secrets of cron-taken.

**Bekend:** Jitsi Meet (meet.jit.si) vraagt degene die een vergadering opent om
één keer kort in te loggen (bijvoorbeeld met Google of GitHub); de anderen doen
zonder account mee. Wie liever Teams of Google Meet gebruikt, plakt die link.
