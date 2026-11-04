# Agenda — genodigden op elke agenda + contact-zoeker

**Datum:** 2026-07-01
**Status:** Gebouwd, typecheck + build groen. **Nog niet gedeployed** naar staging.
**Let op:** voegt OAuth-scopes toe → gebruikers moeten hun Google/Microsoft-agenda éénmalig
opnieuw koppelen voordat contactzoeken werkt (agenda + uitnodigen zelf blijven werken).

## Wat is er toegevoegd
1. **Genodigden op álle agenda's.** Uitnodigen werkte alleen op de eigen ResoFly-agenda
   (iMIP-mail). Nu ook op **Google** (attendees in de event-body + `sendUpdates=all` →
   Google mailt de uitnodiging/afzegging) en **Microsoft** (attendees in de body → Graph
   mailt automatisch). Genodigden worden teruggelezen uit het event (incl. RSVP-status) en
   getoond in het detailpaneel; bij bewerken/verplaatsen blijven ze behouden.
2. **Contact-zoeker in één picker (`AttendeePicker`).**
   - **App-eigen contacten** (klanten incl. contactpersoon + leveranciers) — lokaal
     doorzoekbaar op élke agenda, geen herverbinding nodig.
   - **Google-contacten** (People API: `searchContacts` + `otherContacts:search`) bij een
     Google-agenda; **Outlook/Teams-contacten** (Graph `/me/people`) bij een Microsoft-agenda.
   - **Handmatig e-mailadres** typen + Enter/Toevoegen — parallel beschikbaar.
   - Suggesties tonen naam + e-mail + bron-badge (Klant/Leverancier/Google/Outlook), dedupe
     op e-mail, al toegevoegde contacten uitgefilterd. Mist de contacten-scope → melding
     "koppel je agenda opnieuw".

## OAuth-scopes (nieuw)
- Google: `contacts.readonly` + `contacts.other.readonly`.
- Microsoft: `Contacts.Read` + `People.Read`.
Bestaande koppelingen houden hun oude scopes → contactzoeken geeft dan `needsReconnect`
(agenda blijft werken). Na opnieuw koppelen werkt het.

## Bestanden
- `supabase/functions/calendar-integrations/index.ts` — scopes uitgebreid; nieuwe actie
  `searchContacts` + `googleSearchContacts`/`microsoftSearchContacts`/`dedupeContacts`;
  attendees in `buildGoogle/MicrosoftEventBody` + `googleWriteQuery` (sendUpdates) +
  `mapGoogle/MicrosoftAttendees` + `mapAttendeeStatus`; attendees teruglezen in create/
  update/list; privé-maskering; Google-delete met `sendUpdates=all`.
- `src/types.ts` — `EventAttendeeLite` + `CalendarExternalEvent.attendees`.
- `src/lib/calendar-api.ts` — `searchCalendarContacts` + `ProviderContact`.
- `src/features/CalendarPage.tsx` — `AttendeePicker` (+ `searchAppContacts`), in beide
  formulieren; submit/edit/reschedule sturen & behouden genodigden voor alle providers;
  detailpaneel toont genodigden ook voor Google/Microsoft.
- `src/styles/globals.css` — picker-, chip- en RSVP-statusstijlen.

## Aandachtspunten / bekende beperkingen
- Deploy: alléén `supabase functions deploy calendar-integrations` (geen migratie nodig).
  Daarna losse `tsc`/boot-health-check (Deno lokaal niet beschikbaar).
- Google People `searchContacts` heeft een "warm-up": de állereerste zoekopdracht na
  koppelen kan leeg zijn en vult zich daarna. App-contacten werken altijd meteen.
- Een Google-afspraak verplaatsen (slepen/tijd bewerken) mailt de genodigden een update —
  standaard/correct agenda-gedrag, maar wel per verplaatsing.
- Microsoft-afspraak verwijderen stuurt (nog) geen expliciete afzegmail (Graph DELETE);
  Google doet dat wel via `sendUpdates=all`.
