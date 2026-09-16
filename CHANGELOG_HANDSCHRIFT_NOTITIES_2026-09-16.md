# Changelog — Handgeschreven notities met pen, en notities rechtstreeks vanuit een afspraak — 2026-09-16

> Bouw onder de notities een mega gave optie dat je middels een tablet met pen
> zelf aantekeningen kunt maken. Alsof je op een reMarkable werkt — notities die
> je kunt toevoegen bij een vergadering. Daarnaast wil ik rechtstreeks vanuit een
> agenda-item notities toe kunnen voegen aan dat agenda-item.

## 1 · Schrijven met een pen, onder de notitie

Elke notitie heeft nu onder de getypte inhoud een sectie **Handschrift**. Eén tik
op *Schrijven met pen* en er ligt een vel papier klaar: gelinieerd, met stippen,
ruitjes of blanco. Wat je erop schrijft wordt niet als plaatje bewaard maar als
vectorlijnen — scherp op elk scherm, later nog te gummen, en klein genoeg om bij
de notitie in de database te zitten (tabel `note_handwriting`, één rij per notitie).

Wat het vel kan:

- **Pen met druk.** Een pen met drukgevoeligheid (Apple Pencil, S Pen, Surface
  Pen) geeft dunne en dikke lijnen in één streek; de dikte volgt de druk, uitgemiddeld
  over de buren zodat een haperende pen niet zichtbaar wordt. Drie pendiktes,
  zes inktkleuren.
- **Marker** (doorzichtig, ónder de pen getekend zodat tekst leesbaar blijft)
  en **gum** die hele lijnen weghaalt die het gumpad raken — ook tussen twee
  samples in, zodat een snelle veeg geen gaten laat. De gumkant of -knop van de
  pen gumt vanzelf.
- **Palmafwijzing.** De pen tekent, een vinger scrolt; zolang de pen actief is of
  net boven het scherm hing, wordt een aanraking helemaal genegeerd — de hand die
  op het vel rust, schuift de pagina niet weg. Wie liever met de vinger tekent zet
  dat aan met de handknop.
- **Ongedaan maken / opnieuw** (ook Ctrl+Z / Ctrl+Shift+Z), **meerdere pagina's**,
  papiersoort per pagina, **download als PNG**.
- **Tabletmodus**: schermvullend schrijven, waar de browser het toelaat ook echt
  fullscreen; Esc of *Klaar* brengt je terug in de notitie met alles wat je schreef.
- **Autosave.** Bij een bestaande notitie slaat het handschrift kort na de laatste
  streek vanzelf op (de knop Opslaan van het formulier neemt de laatste stand ook
  mee); bij een nieuwe notitie reist het mee en wordt het na het aanmaken in één
  keer weggeschreven. De badge "Handschrift · 2 pagina's" verschijnt zonder dat de
  hele werkruimte opnieuw laadt.
- **Thema.** Donker papier met lichte inkt op het donkere thema, warm-wit papier
  met donkere inkt op het lichte. Kleuren zijn sleutels ("inkt", "blauw"), geen
  hex — één handschrift blijft leesbaar in beide thema's. De PNG-export gebruikt
  altijd licht papier.

Kaartjes met handschrift tonen een miniatuur van de eerste beschreven pagina:
in de notitielijst, bij klant- en projectnotities, en op de afspraak in de agenda.
In Inhoud staat bij zo'n notitie "Notitie · handschrift".

### Tekenen zonder kralenketting

Losse lijnstukjes met wisselende `lineWidth` geven een kralenketting; een
doorlopende omtrek links en rechts van het pad kruist zichzelf bij scherpe hoeken
en knijpt daar dicht. Daarom wordt een streek getekend als één pad van cirkels
(één per punt: ronde verbindingen en ronde uiteinden) plus trapezia per segment,
allemaal in dezelfde draairichting, in één `fill()`. De nonzero-vulling voegt de
overlappende delen samen zonder gaten of pieken, en een doorzichtige marker blijft
egaal. Schaarse muispunten worden vooraf verdicht langs een centripetale
Catmull-Rom-spline (die variant maakt geen lussen bij ongelijke afstanden);
dichte peninvoer blijft ongemoeid.

Eén valkuil kwam in de browsertest boven: verschijnt er tijdens een streek tekst
in de knoppenbalk ("Pen herkend", "Opgeslagen 15:40"), dan kan de balk omslaan en
schuift het vel een paar tientallen pixels onder de pen weg — de rest van de
streek verspringt. Daarom wordt de positie van het vel bij het neerzetten van de
pen vastgezet voor de duur van het gebaar, en heeft de statusstrook een vaste
breedte.

## 2 · Rechtstreeks vanuit een afspraak

Het detailpaneel van een agenda-item had al *+ Notitie*, maar dat sloot het
paneel en opende het volledige formulier. Nu staat er in het blok
*Notities & documenten* een **snelle notitie**: typ, *Toevoegen* (of Ctrl+Enter)
en de notitie hangt aan de afspraak — type *Meeting*, tag *agenda*, klant en
project van de koppeling — zonder dat het paneel dichtgaat. De titel is de eerste
regel als die kort is, anders "Notitie: ‹afspraak›".

Ernaast **Met pen schrijven**: een schermvullend vel, meteen. *Opslaan bij
afspraak* maakt de notitie mét koppeling aan en bewaart het handschrift; het
paneel toont hem daarna met miniatuur. Annuleren met inhoud vraagt eerst om
bevestiging, en Escape sluit alleen het vel — niet ook het paneel eronder (de
agenda luistert zelf op Escape; het vel vangt de toets in de capture-fase).

Dezelfde regels als voor gekoppelde notities: alleen bij afspraken die met de
organisatie gedeeld zijn en niet afgeschermd, en alleen met schrijfrechten.

## Database

Nieuwe migratie: `supabase/migrations/20260916000000_note_handwriting.sql`.

- Tabel `note_handwriting`: `note_id` (uniek, `on delete cascade`), `pages`
  (jsonb, inktdocument versie 1), `page_count`, `stroke_count`, `paper`.
- Validatietrigger: notitie bestaat en hoort bij dezelfde organisatie, `pages`
  heeft de juiste vorm, maximaal 6 MB per notitie (de app stopt eerder, bij 4 MB
  JSON); `updated_at` wordt automatisch bijgehouden.
- RLS: lezen bij leesrecht op de organisatie, schrijven bij schrijfrecht;
  modulegate *Inhoud* (`apply_module_gate('note_handwriting', 'content')`).
- Audit alleen bij aanmaken en verwijderen — de autosave zou anders elke
  pennenpauze als "bijgewerkt" in de tijdlijn zetten.

Zonder de migratie blijft de app werken: de sectie meldt bij het opslaan dat de
migratie ontbreekt, lijsten tonen geen badges.

## Bestanden

- `src/lib/ink.ts` — het inktmodel: document/pagina/lijn, defensief lezen,
  compacte opslag, gum (afstand tot lijnstuk), tekenen (papier, omtrek, thema),
  miniaturen en PNG-export. Puur rekenwerk, zonder DOM.
- `src/lib/ink.test.ts` — 13 tests (`npm test`): rondreis door JSON, kapotte
  opslag, gum raakt alleen wat hij raakt, tekenvolgorde, omtrek, verdichting,
  opslaggrens.
- `src/components/InkCanvas.tsx` — de editor: twee canvaslagen, Pointer Events
  (pen/muis/vinger, coalesced events, druk), gereedschap, geschiedenis, pagina's,
  tabletmodus, sneltoetsen.
- `src/components/NoteHandwriting.tsx` — laden/autosave in het notitieformulier
  (`NoteInkSection`), miniaturen (`InkThumbnail`), de schrijfoverlay vanuit de
  agenda (`InkComposer`) en een kleine inktcache.
- `src/main.tsx` — sectie in het notitieformulier; `_ink` reist mee in het
  formulier en wordt bij opslaan weggeschreven (`saveNoteHandwriting` /
  `deleteNoteHandwriting`); badges bijwerken zonder volledige herlaadslag.
- `src/features/CalendarPage.tsx` — snelle notitie, pen-overlay en miniaturen in
  het afspraakpaneel.
- `src/features/Notes.tsx`, `src/features/ContentLibrary.tsx` — badges en miniaturen.
- `src/lib/repository.ts`, `src/types.ts` — `note_handwriting` (samenvattingen in
  `AppData.noteHandwriting`, laden, opslaan, verwijderen).
- `src/styles/globals.css` — blok "HANDSCHRIFT · pen op tablet".

## Verificatie

- `npm run typecheck` ✓, `npm test` ✓ (157 tests), `npm run build` ✓.
- `npm run test:mobile -- --theme=both` ✓ (156 pagina's, 0 problemen).
- Browsertest in Chromium tegen de nagebootste backend, desktop (donker en
  licht), tablet 820×1180 met aanraking en telefoon 390×844: pen met druk via
  CDP (`pointerType: 'pen'`, `force`), marker, gum, undo/redo, muis, pagina's,
  papier, tabletmodus en Esc, snelle notitie in het paneel, pen-overlay openen,
  opslaan aan/uit, annuleren met bevestiging; vinger scrolt en tekent niet,
  vinger tekent na de schakelaar, palm vlak na de pen genegeerd; geen
  horizontale overloop op de telefoon.

### Wordt het echt opgeslagen?

De nabootsing hierboven beantwoordt elk schrijfverzoek met een leeg antwoord —
die test bewijst de bediening, niet de opslag. Daarom nog twee rondes:

**Rondreis in de browser**, tegen een nabootsing die schrijfacties wél onthoudt
en teruggeeft (36 controles):

- Schrijven op een bestaande notitie zet binnen twee seconden een rij in
  `note_handwriting`, met de juiste notitie, tellers en lijnen erin.
- Het venster sluiten met **Annuleren** (dus zónder het formulier op te slaan)
  en de notitie opnieuw openen: de lijnen komen terug van de server.
- Alles weggummen verwijdert de rij weer, zodat de badge ook verdwijnt.
- Een nieuwe notitie schrijft niets weg vóór Opslaan, en daarna precies één
  notitie plus één handschrift — de notitie verschijnt in de lijst als
  "Notitie · handschrift".
- De snelle notitie bij een afspraak wordt opgeslagen met de eerste regel als
  titel, type Meeting, tag agenda, rich text en een koppeling aan het
  agenda-item; het paneel blijft open en het invoerveld wordt leeggemaakt.
- De pen-overlay maakt notitie, koppeling én handschrift aan, en het paneel
  toont hem daarna met miniatuur.

**De migratie op een echte Postgres 16**, met de bestaande hulpfuncties
(`can_read_org`, `apply_module_gate`, `audit_row_change`,
`prevent_organization_id_change`) als steiger. De migratie draait, en een tweede
keer draaien verandert niets. Daarna 15 gedragscontroles:

- Een teamlid met schrijfrecht kan opslaan; `updated_at` loopt vanzelf mee
  tussen twee opslagacties.
- Geweigerd: inkt zonder pagina-lijst, inkt die geen object is, een notitie van
  een andere organisatie, een tweede vel voor dezelfde notitie, en een
  handschrift boven de 6 MB.
- Een lezer ziet het handschrift maar kan het niet wijzigen; iemand van een
  andere organisatie ziet niets; een teamlid zonder recht op Inhoud ook niet.
- Aanmaken staat één keer in de audit, de autosave vult hem niet met
  wijzigingen, en het handschrift verdwijnt mee met de notitie.

Die ronde bracht één echte fout aan het licht, nu gerepareerd: de controle op de
vorm van `pages` gebruikte `<>` in plaats van `is distinct from`. Ontbreekt de
sleutel `pages`, dan geeft `->` NULL en levert de vergelijking NULL op — de
controle keurde dan stilzwijgend niets.

## Nog open

- Handschrift omzetten naar tekst (Claude leest de PNG van een pagina): de
  infrastructuur staat er (Claude-koppeling, `ai_usage`-budget), nog niet gebouwd.
- Handschrift als bijlage (PNG) bij de notitie opslaan in R2; nu alleen downloaden.
- Zoeken in handgeschreven notities.
