# Changelog — Sorteren in Inhoud, en campagnes als kaart — 2026-09-16

> De sorteringsopties binnen documenten/inhoud werkt niet op mobiel.
> Op mobiel zorgen grote kaarten binnen marketing voor minder overzicht. Maak
> hier een goede tabel van, met de offerte- en factuur-look.

## 1 · De uitklapmenu's in Inhoud werkten niet op een telefoon

Je tikte op **Sorteren**, de knop klapte open — en er gebeurde niets zichtbaars.
Hetzelfde gold voor **Weergeven** en **+ Nieuw**.

De oorzaak zat niet in die menu's maar in de balk eromheen. Een eerdere mobiele
ingreep maakte de commandobalk van de verkenner een veegbare regel
(`overflow-x:auto`) om verticale ruimte te winnen. Die balk is 47 px hoog, en de
drie menu's hangen er als `position:absolute` ín. Een scroller knipt alles wat
absoluut in hem staat: van een menu van 188 px bleven negen pixels over. Gemeten
op 390×844 stond het menu op 177–365 px terwijl de balk op 186 px eindigt, en
een tik op die plek kwam uit op de tabelkop eronder.

**Nu** worden de drie menu's op een telefoon een bodemvenster: volle breedte
boven de onderbalk, regels van 44 px. `position:fixed` ontsnapt aan de scroller
(er zit geen transform tussen die een nieuw containing block maakt — nagemeten).
Tikken naast het venster sluit het nog steeds; die afhandeling kijkt naar
`.drive-pop` en dat blijft kloppen. Gerrie en de agenda-"+" zijn verborgen
zolang het venster openstaat — die zweefden precies over de onderste regel.

Vanaf 761 px blijft het menu gewoon onder de knop hangen.

## 2 · Campagnes krijgen de kaart van offertes en facturen

De campagnetabel draait op dezelfde generieke kaartstapel als offertes en
facturen dat deden: elke kolom een eigen regel met het kolomlabel ervoor —
CAMPAGNE, STATUS, VERZONDEN, RESULTAAT — plus twee losse knopregels. Eén
campagne vulde zo een half scherm.

```
Winteractie Van Dijk ................... [VERZONDEN]
Klaar voor de winter? Plan je onderhoudsbeurt
verzonden 120/120 .............. [kopie] [prullenbak]
[42 geopend] [11 klik] [3 antw.] [1 afm.]
```

- De naam is de kop, het onderwerp staat eronder, de statuspil rechtsboven —
  precies als bij een offerte of factuur.
- "verzonden 120/120" staat op één regel met de twee acties ernaast; het
  kolomlabel komt terug als klein woord ervóór.
- De **resultaatchips** krijgen een eigen regel, want het kunnen er vier zijn.
  Bij een concept valt die regel helemaal weg in plaats van een "—" te tonen.
- Alleen de campagnetabel. `mk-table` dragen de tabellen van Stromen en
  Afmeldingen ook, en die hebben andere kolommen.

## Code

- `src/styles/globals.css` — blok **27** (uitklapmenu's als bodemvenster) en
  **28** (campagnekaart). Allebei achteraan het bestand: de generieke
  `.quote-table`-mobielregels hebben dezelfde specificiteit, dus de volgorde
  beslist.
- `src/features/Marketing.tsx` — de campagnetabel krijgt de klasse
  `mk-campaign-table`, en de resultaatcel krijgt `is-empty` als er geen cijfers
  zijn. CSS kan geen "—" herkennen, dus dat moet uit de JSX komen.
- `tests/mobile/*` — twee campagnes in de seed (één verzonden mét cijfers, één
  concept zonder) en een ondergrens voor het eerste item op de marketingpagina.
  Die pagina toonde in de test altijd de lege staat en werd dus niet gemeten.

## Getest

`npm run test:mobile -- --theme=both` (zoals CI) draait schoon. De verkenner is
apart nagelopen in Chromium op 390×844: sorteermenu openen, het venster staat
volledig in beeld (12–378 × 531–778), een tik op die plek raakt nu
`button.drive-pop-item` in plaats van de tabelkop eronder, en "Gewijzigd"
aanklikken werkt. `tsc` en `npm test` zijn groen.

## Wat de test niet vangt

De lay-outtest opent geen menu's; hij meet alleen wat er bij het laden staat.
Dit soort fout — een uitklapmenu dat door een scroller wordt afgeknipt — glipt er
dus doorheen. Dat is hoe het er sinds de veegrij-ingreep in kon sluipen zonder
dat er iets rood werd.
