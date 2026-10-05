# Changelog — Klantmeldingen over tickets: eigen teksten — 2026-10-05

De e-mailmeldingen die klanten krijgen over hun tickets (zie
`CHANGELOG_KLANTPORTAAL_MELDINGEN_2026-10-04.md`) zijn nu per organisatie aan te passen, net
als de offerte-, factuur-, contract- en boekingsmails.

## Waar

**Instellingen → E-mail → E-mailteksten aanpassen.** In de keuzelijst staan vier nieuwe mails
(typ "ticket" in het zoekveld):

| Mail | Wanneer |
|---|---|
| Ticketmelding · ontvangen (bevestiging) | iemand dient in het portaal een ticket in |
| Ticketmelding · nieuw ticket | het team (of een collega bij de klant) maakt een ticket aan |
| Ticketmelding · nieuw antwoord | er staat een antwoord dat de klant mag zien |
| Ticketmelding · statuswijziging | de status van een ticket verandert |

Per mail: **onderwerp**, **aanhef & bericht**, **afsluiting** en **knoptekst**, met een
voorbeeld en de plaatshouders erbij. Alleen owners en admins kunnen aanpassen; "Herstel
standaardtekst" zet een mail terug. Op de kaart **Meldingen aan klanten** (iets hoger) brengt
de knop **Teksten aanpassen** je meteen naar deze mails.

## Plaatshouders

Bij alle vier: `{{recipient_name}}`, `{{company_name}}`, `{{client_name}}`, `{{ticket_title}}`,
`{{ticket_status}}`. Daarnaast:

- nieuw ticket: `{{created_by}}` (jouw bedrijf of de collega van de klant die het indiende);
- nieuw antwoord: `{{reply_author}}` (wie het laatst reageerde), `{{new_replies}}` ("Nieuw
  antwoord" of "2 nieuwe antwoorden"), `{{reply_count}}`;
- statuswijziging: `{{previous_status}}`, `{{status_sentence}}` ("in behandeling genomen").

## Wat vast blijft

Het ticket met de status, de antwoorden zelf, de knop naar het ticket (alleen de tekst erop is
aan te passen) en onderaan altijd de regel "Meldingen beheren" — die hoort er voor de klant te
staan. Gebeurt er vlak na elkaar meer (een antwoord én een statuswijziging), dan komt dat in één
mail met de tekst van de belangrijkste melding: ontvangen > nieuw ticket > antwoord > status; de
statuswijziging staat er dan als regel bij.

## Standaardtekst

Wie niets aanpast, krijgt vrijwel de tekst van gisteren. Drie kleine verschillen, omdat de tekst
nu uit één sjabloon per soort komt: de aanhef is "Beste {naam}," (zonder naam: "Beste
relatie,", zoals bij de andere mails), er staat "het ticket" waar soms "je ticket" stond, en bij
een nieuw ticket "… heeft het ticket ‘…’ aangemaakt".

## Onder de motorkap

- **Migratie `20261005000000_portal_ticket_email_templates.sql`:** de `template_key`-CHECK van
  `email_templates` kent `portal.ticket.received`, `.created`, `.reply` en `.status`. Zonder deze
  migratie zegt de editor bij opslaan dat de databasemigratie nog moet draaien (in plaats van de
  kale Postgres-melding), en gaan de mails met de standaardtekst.
- **`_shared/emailTemplates/portalTicketUpdate.ts`:** standaardteksten en plaatshouders per soort
  (`PORTAL_TICKET_DEFAULTS`, `PORTAL_TICKET_PLACEHOLDERS`); eigen tekst gaat door dezelfde
  veilige route als de andere mails (`content.ts`: escapen, plaatshouders ge-escaped,
  onbekende plaatshouders weg, onderwerp op één regel). Een leeg of onbruikbaar veld valt terug
  op de standaardtekst.
- **`portal-notify`** leest de teksten één keer per organisatie per ronde; een fout daarbij is
  niet fataal (dan de standaardtekst).
- **Frontend:** catalogus in `lib/emailTemplateContent.ts` (groep `tickets`), voorbeeld en
  verwijsknop in `SimplePages.tsx`. Gerrie (`actions/admin.ts`) kent de nieuwe mails ook.
- **Telefoon:** een lange optie in de keuzelijsten onder Instellingen (bv. "Herinnering · niveau
  1 (vriendelijk) • aangepast") maakte de pagina zijwaarts scrollbaar; de kolom krimpt nu mee en
  de optie wordt met … afgekort.
- **Tests:** `_shared/portalNotify.test.ts` (eigen tekst per soort, escaping, terugvallen,
  gebundelde mail) en het nieuwe `lib/emailTemplateContent.test.ts`: editor en mailtemplate
  hebben dezelfde standaardtekst en plaatshouders, Gerrie kent dezelfde mails, en elke mail uit
  de editor mag in de database.

## Uitrol

Migratie `20261005000000_portal_ticket_email_templates.sql` en de functie `portal-notify`, plus
de functies die de handelingen van Gerrie delen (`gerrie-agent`, `mcp`, `api`) voor de nieuwe
mails in `email_template.list`/`.save`/`.reset` — alles gaat mee met *Deploy Supabase (staging)*.
