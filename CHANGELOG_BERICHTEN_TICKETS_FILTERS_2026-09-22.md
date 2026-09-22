# Changelog — Berichten met kanaalicoon, tickets als échte tabel, filters op normale lettermaat — 2026-09-22

Drie wensen van de telefoon, alle drie over hetzelfde: in één oogopslag zien wat er staat, zonder
dat de opmaak ervoor in de weg zit.

## 1 · Berichten: aan een icoontje zien of het mail, een ticket of een telefoongesprek was

Op de hoek van het klantrondje staat nu een klein rond icoon:

| kanaal | icoon | kleur |
|---|---|---|
| E-mail | envelop | blauw |
| Ticket | ticket | paars |
| Telefoon | hoorn — met een pijl naar binnen (inkomend) of naar buiten (uitgaand), of een kruisje als er niet gesproken is (gemist, voicemail, in gesprek, niet opgenomen) | groen |

Eerder stond er bij een ticket een woordje *TICKET* naast de klantnaam, bij een gesprek *TELEFOON*,
en bij mail niets. Je moest dus lezen om te zien wat wat was, en op de telefoon kapte de klantnaam
daardoor eerder af (*Bakkerij De Kore…*). Die woordjes zijn weg; de klantnaam heeft zijn ruimte terug.

- **De kleur zegt het kanaal, de vorm het detail.** Zo scan je de lijst op kanaal zonder te lezen.
- Rand en tekening van het icoon hebben de kleur van de lijst zelf, zodat het zich op elk
  klantrondje losmaakt — welke klantkleur dat ook is, licht én donker thema.
- Op de telefoon is het icoon 20px, op een groot scherm 18px.
- Een gesprek zonder klant krijgt een gestippeld rondje met een poppetje, en gewoon hetzelfde
  kanaalicoon op de hoek.
- Een schermlezer hoort het kanaal als eerste woord van de regel: *"Telefoon, inkomend, gemist —
  Geen klant …"*.
- Met één klant gekozen (de vensters E-mail / Tickets / Telefoon naast elkaar) staat het kanaal al
  boven elk venster; daar blijven de regels zoals ze waren.

## 2 · Tickets: op de telefoon een échte tabel

De tabelweergave klapte op de telefoon om naar losse kaarten: de titel in een smalle kolom over
drie, vier regels, klant en datum eronder, en twee grote knoppen onderaan. Zo'n 165px per ticket —
nog geen drie tickets per scherm, en het leek niet meer op de tabel die je had gekozen.

Nu:

```
TICKET · KLANT · DATUM ↓            STATUS · PRIO
● Website laadt traag op mobiel     [NIEUW]         ⋮
  Fysio Centrum Zuid · 23 aug       [HOOG]
──────────────────────────────────────────────────
  Nieuwe flyer voor herfstactie     [REVIEW]        ⋮
  Bakkerij De Korenaar · 23 aug     [NORMAAL]
```

| telefoon, 390px breed | vóór | nu |
|---|---|---|
| hoogte per ticket | ±165px | **53px** |
| tickets per scherm | ±2,5 | ±10 |

- **Kolomkoppen die sorteren**, net als op een groot scherm — op alle vijf: ticket, klant, datum,
  status en prioriteit. Nog een keer tikken draait de richting om.
- **Twee regels per ticket**: de titel, met klant en datum eronder; status en prioriteit als twee
  pillen onder elkaar. Een lange titel kapt af in plaats van de rij hoger te maken.
- De datum is kort, zoals in Berichten: *11:12* vandaag, *gisteren*, *za*, *23 aug*. De volledige
  datum staat in de tooltip.
- Nieuw sinds je laatste bezoek: een stip vóór de titel, een vettere titel en een gouden streep
  links. Geen woordje *Nieuw* meer — dat las als de status Nieuw.
- **Op de planning** en **Project maken** zitten achter **⋮**. Twee knoppen per rij kostten een
  kwart van de breedte, en die ging af van de titel en de klantnaam. ⋮ opent onderin een paneel
  met de twee acties voluit, en wat ze doen. Bij een ticket dat niet meer om te zetten is, staat er
  geen ⋮.
- Tik op de rij en het ticket opent, zoals altijd.

De tabel op de telefoon is een eigen onderdeel (`TicketCompactTable` in `Tickets.tsx`); welke er
staat, beslist `useNarrowViewport` — dezelfde grens van 760px als de mobiele CSS. De oude
kaartregels voor `.ticket-table` op de telefoon zijn weg. De **lijstweergave** (kaarten) is niet
veranderd.

**Ook opgelost, op een groot scherm:** in de brede tabel schoven de knoppen *Op de planning* en
*Project maken* over de datum heen. De knoppenkolom stond vast op 156px, terwijl de twee knoppen
samen ±270px breed zijn, en de cel was een rechts uitgelijnde flexbox — dus liep de inhoud naar
links over de datumkolom. De kolom is nu zo breed als zijn knoppen. Op een smal laptopscherm schuift
de tabel daardoor opzij (zoals de offerte- en factuurtabel al deden) in plaats van dat er iets
onder iets anders verdwijnt.

**En:** de statuspillen *Nieuw* en *Omgezet* hadden een vaste lichte kleur, en waren in het lichte
thema bijna onleesbaar (lichtblauw op wit). Die kleur volgt nu het thema.

## 3 · Filters: normale lettergrootte

In het filterblok van de weekplanner stonden de keuzelijsten op de telefoon op 16px, en ook nog
vet: *Alle prioriteiten* werd breder dan zijn kolom en het filterblok had de grootste letter van
het hele scherm. Hetzelfde gold voor het filterblok van tickets, klanten, projecten, offertes,
facturen en campagnes — dat is één en hetzelfde onderdeel.

**Oorzaak:** een algemene regel zet op de telefoon élk veld op 16px, omdat iOS inzoomt op een
invoerveld met een kleinere letter. Maar deze keuzelijsten zijn knoppen (onze eigen `Select`), en
op een knop zoomt niets. Ze staan nu op **13px**. Het zoekveld blijft 16px — dat ís een invoerveld —
alleen de voorbeeldtekst erin is niet meer vet.

**Tegelijk opgelost:** het pijltje van elke keuzelijst in dat blok stond op de telefoon *naast*
het vak in plaats van erin, en het vak was 41px te smal. De binnenruimte stond per ongeluk ook op
de omhulling van de keuzelijst (`.select-control`), en daar hangt het pijltje aan.

Dezelfde lettermaat voor de filterstrook bij **Uren** (klant, project, declarabel, bron, soort) en
de sorteerkeuze bij **Projecten**. De hoogte van de velden (44px, duimmaat) is niet veranderd.

## Test

- `npm run typecheck` — schoon
- `npm test` — 332/332
- `npm run build` — schoon
- Nieuw in de mobiele lay-outtest (`tests/mobile/run.mjs`): de pagina `tickets-table` (de
  tabelweergave), met als eerste item de eerste tabelrij. Gemeten op 310px (de kolomkop van 34px
  zit erboven); de grens is 372px, 20% erboven.
- In de browser nagelopen (licht en donker, telefoon, tablet, laptop en groot scherm): het
  kanaalicoon per soort gesprek, sorteren op klant in de smalle tickettabel, het ⋮-paneel, de brede
  tickettabel zonder overlap, en de filterblokken van weekplanner, projecten en facturen.

## Wat níét verandert

Geen migratie en geen nieuwe gegevens — alleen de weergave. Mail, tickets en gesprekken werken
precies zoals ze werkten; *Op de planning* en *Project maken* doen hetzelfde als eerst (met de
bevestiging bij het omzetten). De lijstweergave van tickets, het ticketvenster en de brede tabel
(op de knoppenkolom na) zijn onaangeroerd.
