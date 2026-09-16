# Een belletje voor de eigenaar, en zicht voor de owner

**17 september 2026 · MCP, na fase C · volgt op [CHANGELOG_MCP_CATALOGUS_2026-09-17.md](CHANGELOG_MCP_CATALOGUS_2026-09-17.md)**

Twee losse dingen die de connector afmaken als iets dat een organisatie met een gerust hart aanzet.

## De melding

Een klant vraagt zijn AI "stuur Jansen een herinnering". Die zet het keurig klaar in de goedkeurwachtrij en zegt dat erbij. Maar de klant zit op zijn telefoon, in een andere app, en vergeet het. Dan staat er een herinnering te wachten die nooit uitgaat — en de klant dénkt dat hij verstuurd is, want hij heeft er zelf om gevraagd.

Dus: een push naar de eigenaar van de koppeling op het moment dat het voorstel binnenkomt. *"Claude op mijn laptop heeft iets klaargezet — herinnering aan Jansen."* Nieuw push-type `mcp_proposal`, uit te zetten onder Instellingen → Meldingen.

**Alleen de eigenaar, niet het team.** De andere meldingen gaan naar iedereen, maar die gaan over iets wat van buiten komt en waar iemand op moet reageren. Dit gaat over iets wat de gebruiker zelf net in gang zette, in een gesprek dat hij nu voert. Zou het hele team een ping krijgen bij elke vraag die iemand aan zijn AI stelt, dan zet iedereen het na een week uit. De wachtrij op het startscherm is en blijft van het team; dit belletje is persoonlijk.

De melding hangt aan de **rij**, niet aan de code: een trigger op de insert in `ai_action_audit`, exception-wrapped zodat een mislukte push het voorstel nooit tegenhoudt. Eén tag per koppeling, zodat drie voorstellen achter elkaar één melding worden die zichzelf bijwerkt.

## Het toezicht

Een koppeling is persoonlijk — je koppelt jouw AI, met jouw rechten. Goed voor de rechten, maar het maakte het voor de eigenaar van de organisatie onzichtbaar. Een medewerker die ChatGPT aan de bedrijfsadministratie hangt is iets wat een owner hoort te weten, en hoort te kunnen stoppen zonder eerst die medewerker te hoeven vinden. Zeker als die net uit dienst is.

Onder Instellingen → AI ziet een owner of admin nu twee lijsten: *mijn koppelingen* en *koppelingen van het team*, met per rij wie het is, of het meeleest of ook klaarzet, en een knop Stoppen. Welke rijen iemand te zien krijgt beslist RLS (twee nieuwe permissive policies naast de bestaande "eigen rijen"); het scherm splitst alleen op `user_id`.

**Een update-policy laat élke kolom toe, en een scherm is geen slot.** Daarom een trigger die vanuit de app alleen intrekken en hernoemen toestaat — ook voor een admin. Scope, eigenaar, client en organisatie zijn onaantastbaar, en een ingetrokken koppeling komt niet terug: meer rechten geven kan alleen de gebruiker zelf, door opnieuw te koppelen. De service-role (de autorisatieserver, die scope en label bijwerkt bij het koppelen) blijft erlangs kunnen, want die heeft geen `auth.uid()`.

Stoppen werkt meteen en definitief: de bestaande triggers trekken de tokens mee in en annuleren wat er nog klaarstond. Dat gold al voor de eigenaar; nu ook voor een admin.

## Wat de tests bewaken

Vier tests erbij in `mcpCatalog.test.ts`: het push-type staat in beide CHECKs van de migratie, de nieuwe CHECKs laten geen enkel bestaand push-type vallen (een vergeten type zou vanaf dat moment stil élke melding van dat type weigeren), het type staat in `push-api.ts` op beide plekken, en de trigger is security definer én exception-wrapped én slaat voorstellen zonder koppeling over.

## Wat er níét in zit

| Niet gebouwd | Waarom |
|---|---|
| Een melding naar de collega wiens koppeling een admin stopt | Bewust niet: de bevestigingsdialoog zegt dat ook. Wie een koppeling stopt, zegt het zelf tegen de collega — een automatische mail "uw admin heeft uw AI losgekoppeld" is de verkeerde toon voor iets wat een gesprek hoort te zijn. |
| Auditlog van wie welke koppeling stopte | `revoked_at` is er; `revoked_by` niet. Kleine toevoeging als het nodig blijkt. |

Nagemeten: `npm test` 209 tests groen (205 + 4), `npm run typecheck` en `npm run build` groen. Twee migraties erbij (vier in totaal voor de connector); geen wijziging aan de edge functions.
