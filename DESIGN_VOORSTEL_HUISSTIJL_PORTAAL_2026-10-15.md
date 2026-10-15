# Designvoorstel — Huisstijl in het klantportaal — 2026-10-15

## De vraag

> Via instellingen van de gebruiker kunnen we branding kleuren instellen. Deze branding kleuren
> dienen ook overeen te komen met de look en feel van de klantenpagina. De klantenpagina dient als
> voorbeeld ook in te zien zijn hoe dat dan op de klantpagina te zien is. Laat me zien hoe je dit
> voor je ziet voordat je dit gaat bouwen.

Dit is het voorstel. **Er is nog niets gebouwd**; de code is niet aangeraakt.

## Bekijken

| wat | waar |
|---|---|
| Werkend voorbeeld: Instellingen → Huisstijl met het portaal ernaast dat meekleurt (vier voorbeeldmerken, eigen logo uploaden, desktop en telefoon, overzicht, factuur en inloggen), plus de bevindingen, het bouwplan en de keuzes | `docs/design-voorstel-huisstijl-portaal/index.html` (dubbelklikken), of online: https://claude.ai/artifact/CEKMQD27fFchsHNUta6QbM (privé; deel het via het Share-menu) |
| Beelden van de huidige stand, gemaakt met de nagebootste backend uit `tests/mobile/mock` | `docs/design-voorstel-huisstijl-portaal/beelden/` |

De kleuren in het voorbeeld komen uit een letterlijke vertaling van `brandThemeVars()` in
`src/lib/branding.ts`, aangevuld met de koptokens die hieronder worden voorgesteld.

## Wat er nu misgaat

De huisstijl werkt al door: merkkleur, lettertypen en donker/licht komen via `applyBrandTheme()` in
het portaal en op de publieke pagina's terecht. Drie dingen kloppen niet:

1. **Het portaal heeft de opbouw van de werkruimte niet.** De Cockpit-laag (2026-10-05) is bewust
   alleen onder `.app` gezet. Het portaal heeft nog omlijnde tabknoppen, omlijnde tegels en
   kaarten zonder kop.
2. **Het merkteken blijft goud.** `.brand-icon` in `globals.css` (Belicht-laag) heeft een vast
   goudverloop. Zonder logo staat er bij een blauw merk een gouden initiaal naast blauwe tellers.
3. **In Instellingen zie je het portaal niet.** Er staan twee nagebouwde factuurkaartjes en een
   galerijkop. Die lopen al uit de pas: de gekozen chip in het galerijvoorbeeld gebruikt de
   Dag-accenttekst van de werkruimte (`#855800`) op de donkere galerij, 2,3 : 1.

## Het voorstel

- **Twee merkkleuren.** De bestaande merkkleur (knoppen, actief tabblad, stip bij nieuw, links,
  focus) en een nieuwe **kopkleur** voor het vlak bovenin en het inlogscherm. Standaard
  *Automatisch*: het grafiet van de cockpit in de tint van de merkkleur.
- **Het portaal in de Cockpit-opbouw.** Een kop met groet, de vier kerncijfers als glazen tegels
  en de tabbladen; het werkvlak (Licht of Donker, zoals nu) zweeft eronder. Hoofdknop met een
  verloop uit de merkkleur. Het merkteken krijgt de merkkleur.
- **Leesbaarheid blijft gegarandeerd.** Tekst op de kop wordt vanzelf licht of donker, de merkkleur
  op de kop schuift in helderheid als hij te weinig afsteekt, en een donker logo op een donkere
  kop krijgt een licht plaatje (of de gebruiker uploadt een lichte versie).
- **Live voorbeeld in Instellingen.** Het échte portaal met voorbeeldgegevens op een eigen route
  (`/portal/voorbeeld`) die de niet-opgeslagen keuzes via `postMessage` krijgt; rechts naast de
  instellingen, met desktop/telefoon en overzicht/factuur/inloggen.

## Bouwplan

1. `company_settings.brand_header_color` (leeg = automatisch), mee in `create_child_organization`
   en in de huisstijl uit `_shared/branding.ts`. Optioneel `brand_logo_dark_data_url`.
2. `brandThemeVars()` levert ook `--hdr-*` en het knopverloop, met contrasttests over een raster
   van merk- en kopkleuren.
3. `src/styles/portal-cockpit.css` onder `.portal`; `.brand-icon` in het portaal uit de merkkleur.
4. `/portal/voorbeeld` en de nieuwe indeling van Instellingen → Huisstijl; de nagebouwde
   voorbeelden verdwijnen.
5. `npm test`, typecheck, build en `npm run test:mobile` in Licht en Donker met meerdere merken.

Daarna eventueel: dezelfde kop op de publieke offerte-, factuur- en contractpagina, en de kopkleur
in de e-mails.

## Keuzes die nog open staan

| vraag | advies |
|---|---|
| Een tweede kleur (kopkleur)? | Ja, met Automatisch als standaard |
| Kerncijfers in de kop? | Ja, als glazen tegels |
| Donker logo op een donkere kop | Vanzelf een licht plaatje, plus optioneel een lichte versie |
| Publieke offerte-, factuur- en contractpagina meteen mee? | Eerst het portaal, dan die drie |
| Kleuren uit het logo voorstellen? | Meenemen |
